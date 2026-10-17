import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverOmpModelsCached } from "./models.js";
import { parseOmpJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const OMP_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|free\s+usage\s+exceeded)/i;

function buildOmpModelDiscoveryFailureCheck(message: string): AdapterEnvironmentCheck {
  return {
    code: "omp_models_discovery_failed",
    level: "warn",
    message,
    hint: "Run `omp models --json` manually to verify provider auth and config.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "omp");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `omp-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "omp_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "omp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "omp_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const cwdInvalid = checks.some((check) => check.code === "omp_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "omp_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "omp",
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
      checks.push({
        code: "omp_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "omp_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "omp_cwd_invalid" && check.code !== "omp_command_unresolvable");

  // Model discovery shells out to `omp models --json` locally; when probing a
  // remote target we skip discovery and let the remote hello probe surface
  // model/auth issues directly.
  if (!targetIsRemote && canRunProbe) {
    try {
      const discovered = await discoverOmpModelsCached({ command, cwd, env: runtimeEnv });
      if (discovered.length > 0) {
        checks.push({
          code: "omp_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from OMP.`,
        });
      } else {
        checks.push({
          code: "omp_models_empty",
          level: "warn",
          message: "OMP returned no models.",
          hint: "Run `omp models --json` and verify provider authentication.",
        });
      }
    } catch (err) {
      checks.push(
        buildOmpModelDiscoveryFailureCheck(
          err instanceof Error ? err.message : "OMP model discovery failed.",
        ),
      );
    }
  }

  const configuredModel = asString(config.model, "").trim();
  if (!configuredModel) {
    checks.push({
      code: "omp_model_required",
      level: "error",
      message: "OMP requires a configured model in provider/model format.",
      hint: "Set adapterConfig.model using a selector from `omp models --json`.",
    });
  } else if (targetIsRemote) {
    checks.push({
      code: "omp_model_validation_skipped_remote",
      level: "info",
      message: `Skipped local model validation; will be validated by the hello probe inside ${targetLabel}.`,
    });
  } else if (canRunProbe) {
    // Verify model is in the list
    try {
      const discovered = await discoverOmpModelsCached({ command, cwd, env: runtimeEnv });
      const modelExists = discovered.some((m: { id: string }) => m.id === configuredModel);
      if (modelExists) {
        checks.push({
          code: "omp_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
      } else {
        checks.push({
          code: "omp_model_not_found",
          level: "warn",
          message: `Configured model "${configuredModel}" not found in available models.`,
          hint: "Run `omp models --json` and choose a currently available provider/model selector.",
        });
      }
    } catch {
      // If we can't verify, just note it
      checks.push({
        code: "omp_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
    }
  }

  if (canRunProbe && configuredModel) {
    // Parse model for probe
    const provider = configuredModel.includes("/")
      ? configuredModel.slice(0, configuredModel.indexOf("/"))
      : "";
    const modelId = configuredModel.includes("/")
      ? configuredModel.slice(configuredModel.indexOf("/") + 1)
      : configuredModel;
    const thinking = asString(config.thinking, "").trim();
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    const args = ["-p", "Respond with hello.", "--mode", "json", "--no-session"];
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (thinking) args.push("--thinking", thinking);
    // Headless probe: never block on an interactive approval prompt.
    args.push("--approval-mode", "yolo");
    if (extraArgs.length > 0) args.push(...extraArgs);

    try {
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parseOmpJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
      const authEvidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "omp_hello_probe_timed_out",
          level: "warn",
          message: "OMP hello probe timed out.",
          hint: "Retry the probe. If this persists, run OMP manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
        const summary = (parsed.finalMessage || parsed.messages.join(" ")).trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "omp_hello_probe_passed" : "omp_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "OMP hello probe succeeded."
            : "OMP probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Run `omp -p --mode json` manually and prompt `Respond with hello` to inspect output.",
              }),
        });
      } else if (OMP_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "omp_hello_probe_auth_required",
          level: "warn",
          message: "OMP is installed, but provider authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Set provider API key environment variable (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY) and retry.",
        });
      } else {
        checks.push({
          code: "omp_hello_probe_failed",
          level: "error",
          message: "OMP hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `omp -p --mode json` manually in this working directory to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "omp_hello_probe_failed",
        level: "error",
        message: "OMP hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `omp -p --mode json` manually in this working directory to debug.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
