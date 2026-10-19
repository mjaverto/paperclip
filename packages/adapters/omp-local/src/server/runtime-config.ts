import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PreparedOmpRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /** The managed agent-config dir, or null when nothing was staged into one. */
  agentConfigDir: string | null;
  /** Whether a per-agent WATCHDOG.yml advisor roster was staged for this run. */
  advisorEnabled: boolean;
  cleanup: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. an LLM-gateway virtual key) into models.yml
// SERVER-SIDE, where the value is reliably present. OMP resolves a provider apiKey
// by trying it as an env var name first, then as a literal -- but the (possibly
// sandboxed) run process env plumbing is not guaranteed to carry the key, so we
// resolve it here. Unresolvable placeholders are left intact; an env var set to
// an empty string counts as unresolvable (the placeholder stays for OMP to try).
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
): ParsedProviderConfig {
  // Unset/empty (or an empty JSON object) is the normal "feature off" case: no warning.
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  // A SET but unusable value is a misconfiguration; surface it so the run does
  // not proceed silently unconfigured and fail later with an opaque
  // model-not-found error pointing nowhere near the env var.
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: "PAPERCLIP_OMP_PROVIDERS is set but is not a JSON object; custom providers ignored.",
      };
    }
    // Only keep provider entries that are themselves objects; surface the ones
    // we drop so a malformed entry is just as diagnosable as malformed JSON.
    const providers: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
      else skipped.push(key);
    }
    return {
      providers: Object.keys(providers).length > 0 ? providers : null,
      warning: skipped.length > 0
        ? `PAPERCLIP_OMP_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: "PAPERCLIP_OMP_PROVIDERS contains invalid JSON; custom providers ignored.",
    };
  }
}

// Materialize custom OMP providers supplied via PAPERCLIP_OMP_PROVIDERS (a JSON
// object in OMP's models.yml "providers" shape), plus the agent's WATCHDOG.yml
// advisor roster when its instructions bundle carries one, into a managed
// agent-config dir.
//
// OMP has no base-url CLI flag or env var: the only mechanism for pointing it at a
// custom/OpenAI- or Anthropic-compatible endpoint is a models.yml file in its
// agent config dir, which OMP resolves from $PI_CODING_AGENT_DIR (falling back to
// $HOME/.omp/agent). OMP resolves `--provider P --model M` by matching that
// registry, so routing a gateway model requires the provider entry to enumerate
// its models explicitly. We accept the providers as config (not hard-coded) so the
// gateway URL, key, and model list stay declarative.
//
// The advisor roster is per-agent config too: OMP discovers it at
// <active agent dir>/WATCHDOG.yml (with a .yaml fallback at the same scope), so
// Paperclip stages the roster file from the agent's instructions bundle into the
// same managed dir and the run overlay enables the advisor subsystem, so live
// runs review with exactly this agent's advisors.
//
// The staged dir intentionally replaces the host agent dir wholesale, which also
// hides the operator's OMP logins. A roster can therefore only be staged when the
// run can authenticate some other way: the OMP auth broker (OMP_AUTH_BROKER_URL,
// which shares existing logins without copying them) or declarative providers
// (PAPERCLIP_OMP_PROVIDERS). With neither, staging would silently break the
// agent's primary model, so the roster stays unstaged, advisors stay off, and the
// run surfaces a config-gap note. Host config and credentials are never copied
// into run assets.
//
// When anything is staged we point PI_CODING_AGENT_DIR at a fresh temp dir. For
// remote execution targets, execute.ts ships the dir to the sandbox as a runtime
// asset and repoints PI_CODING_AGENT_DIR at the in-sandbox copy, so the roster
// lands on remote targets through the same asset path as models.yml. JSON is
// written verbatim to models.yml: OMP's loader reads YAML, and JSON is a valid
// YAML subset, so no serializer dependency is needed. The roster is written verbatim.
export async function prepareOmpRuntimeConfig(input: {
  env: Record<string, string>;
  /** Contents of the agent's WATCHDOG.yml advisor roster, when the instructions bundle carries one. */
  advisorRoster?: string | null;
}): Promise<PreparedOmpRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const { providers, warning } = parseProviderConfig(
    input.env.PAPERCLIP_OMP_PROVIDERS ?? process.env.PAPERCLIP_OMP_PROVIDERS,
    resolveEnv,
  );
  const advisorRoster =
    typeof input.advisorRoster === "string" && input.advisorRoster.trim().length > 0
      ? input.advisorRoster
      : null;
  const brokerConfigured = (resolveEnv("OMP_AUTH_BROKER_URL") ?? "").trim().length > 0;
  // Only stage a roster when the run can authenticate without the host agent dir.
  const rosterToStage =
    advisorRoster !== null && (providers !== null || brokerConfigured) ? advisorRoster : null;
  if (!providers && rosterToStage === null) {
    return {
      env: input.env,
      notes: [
        ...(warning ? [warning] : []),
        ...(advisorRoster
          ? ["Agent instructions carry a WATCHDOG.yml advisor roster, but neither OMP_AUTH_BROKER_URL nor PAPERCLIP_OMP_PROVIDERS is set; the roster is not staged and the advisor stays off. The managed agent dir hides host OMP logins, so run `omp auth-broker serve` and set OMP_AUTH_BROKER_URL, or configure provider credentials."]
          : []),
      ],
      agentConfigDir: null,
      advisorEnabled: false,
      cleanup: async () => {},
    };
  }

  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-agent-config-"));
  try {
    if (providers) {
      await fs.writeFile(
        path.join(agentConfigDir, "models.yml"),
        `${JSON.stringify({ providers }, null, 2)}\n`,
        "utf8",
      );
    }
    if (rosterToStage !== null) {
      await fs.writeFile(path.join(agentConfigDir, "WATCHDOG.yml"), rosterToStage, "utf8");
    }
  } catch (err) {
    // Never leak the temp dir when a write fails (e.g. disk-full): the
    // caller only receives the cleanup handle on success.
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    env: {
      ...input.env,
      PI_CODING_AGENT_DIR: agentConfigDir,
    },
    notes: [
      ...(warning ? [warning] : []),
      ...(providers
        ? [`Injected ${Object.keys(providers).length} custom OMP provider(s) from PAPERCLIP_OMP_PROVIDERS into a managed models.yml: ${Object.keys(providers).join(", ")}.`]
        : []),
      ...(rosterToStage !== null
        ? [
            "Staged the agent's WATCHDOG.yml advisor roster into the managed OMP agent dir; the advisor subsystem is enabled for this run.",
            ...(brokerConfigured
              ? []
              : ["OMP_AUTH_BROKER_URL is not set: advisor models authenticate only through the declared providers or provider environment keys, not host OMP logins."]),
          ]
        : []),
    ],
    agentConfigDir,
    advisorEnabled: rosterToStage !== null,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}
