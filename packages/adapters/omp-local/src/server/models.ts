import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, parseJson, runChildProcess, sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

interface OmpCatalogModel {
  provider?: unknown;
  kind?: unknown;
  id?: unknown;
  selector?: unknown;
  name?: unknown;
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const envelope = parseJson(stdout);
  const catalog =
    typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>)
      : null;
  const entries = Array.isArray(catalog?.models) ? (catalog!.models as unknown[]) : [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = entry as OmpCatalogModel;
    // `omp models --json` catalogs several kinds (chat models, tiny local
    // models, embedders). Only chat models are valid run targets.
    if (typeof model.kind === "string" && model.kind !== "chat") continue;
    const selector = typeof model.selector === "string" ? model.selector.trim() : "";
    const provider = typeof model.provider === "string" ? model.provider.trim() : "";
    const id = typeof model.id === "string" ? model.id.trim() : "";
    // Prefer the explicit selector ("provider/model"); fall back to joining
    // the separate fields for older catalogs.
    const modelId = selector || (provider && id ? `${provider}/${id}` : id);
    if (!modelId) continue;
    const name = typeof model.name === "string" ? model.name.trim() : "";
    parsed.push({ id: modelId, label: name || modelId });
  }

  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

// Command resolution order: explicit adapter config value, then the
// PAPERCLIP_OMP_COMMAND env default (used by tests and sandbox probes),
// then the default CLI name.
function resolveOmpCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OMP_COMMAND === "string" &&
    process.env.PAPERCLIP_OMP_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OMP_COMMAND.trim()
      : "omp";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  return (
    VOLATILE_ENV_KEY_EXACT.has(key) ||
    VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envFingerprint = Object.keys(env)
    .filter((key) => !isVolatileEnvKey(key))
    .sort()
    .map((key) => `${key}=${createHash("sha256").update(env[key] ?? "").digest("hex")}`)
    .join("&");
  return `${command}|${cwd}|${envFingerprint}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, entry] of discoveryCache) {
    if (entry.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverOmpModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env });

  const result = await runChildProcess(
    `omp-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models", "--json"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`omp models --json` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail =
      result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ??
      result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ??
      "";
    throw new Error(detail ? `\`omp models --json\` failed: ${detail}` : "`omp models --json` failed.");
  }

  // OMP prints the JSON catalog on stdout; fall back to stderr for older builds.
  const output = result.stdout || result.stderr;
  return sortModels(dedupeModels(parseModelsOutput(output)));
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverOmpModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOmpModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export async function ensureOmpModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OMP requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverOmpModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error("OMP returned no models. Run `omp models --json` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    throw new Error(
      `Configured OMP model is unavailable: ${model}. ${models.length} models are available; list them with \`omp models --json\`.`,
    );
  }

  return models;
}

export async function listOmpModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOmpModelsCached();
  } catch {
    return [];
  }
}

export function resetOmpModelsCacheForTests() {
  discoveryCache.clear();
}
