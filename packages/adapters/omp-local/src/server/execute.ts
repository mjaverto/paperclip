import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type {
  AdapterExecutionTarget,
  AdapterExecutionTargetPaperclipBridgeHandle,
} from "@paperclipai/adapter-utils/execution-target";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  selectInitialCommunicationGuidance,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { isOmpUnknownSessionError, parseOmpJsonl, createOmpJsonlParser, type ParsedOmpOutput } from "./parse.js";
import { createOmpStdoutCompactor, resolveOmpStdoutLogMode } from "./stdout-compaction.js";
import { ensureOmpModelConfiguredAndAvailable } from "./models.js";
import { prepareOmpRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// OMP resolves its agent dir from $PI_CODING_AGENT_DIR (compat env, honored by
// omp) falling back to $HOME/.omp/agent, and sessions go under --session-dir.
const OMP_SESSIONS_ROOT = path.join(os.homedir(), ".omp", "paperclip");

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

// Host-level skill sources OMP loads by default (enableAgentsUser pulls in the
// operator's personal agents skills home, enablePiUser the pi home, etc.).
// Paperclip stages exactly this agent's skills into a per-run dir and disables
// every host-level user source in the run overlay, so company scoping holds
// and no skill ever accumulates across agents or runs.
const OMP_HOST_SKILL_SOURCES = [
  "enableAgentsUser",
  "enablePiUser",
  "enableClaudeUser",
  "enableCodexUser",
] as const;

// One overlay shape for local and remote runs. Host-level skill sources are
// disabled and only the staged Paperclip skills dir is enabled; advisor,
// memory, and autolearn are also off so live OMP agents neither start the
// operator's advisor models nor persist run learnings to the host home.
// JSON is a valid YAML subset, so no YAML serializer dep is needed.
export function buildOmpRunOverlay(skillsDir: string): string {
  return `${JSON.stringify({
    skills: {
      ...Object.fromEntries(OMP_HOST_SKILL_SOURCES.map((key) => [key, false])),
      customDirectories: [skillsDir],
    },
    advisor: { enabled: false },
    memory: { backend: "off" },
    autolearn: { enabled: false },
  }, null, 2)}\n`;
}

interface OmpSkillsStage {
  stageDir: string;
  skillsDir: string;
  /** Number of skills symlinked into the stage (0 when none desired). */
  skillCount: number;
  cleanup: () => Promise<void>;
}

async function buildOmpSkillsStage(
  onLog: AdapterExecutionContext["onLog"],
  config: Record<string, unknown>,
): Promise<OmpSkillsStage> {
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-runtime-"));
  const skillsDir = path.join(stageDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  let skillCount = 0;
  try {
    const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
    const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
    for (const entry of availableEntries) {
      if (!desiredNames.has(entry.key)) continue;
      await fs.symlink(entry.source, path.join(skillsDir, entry.runtimeName));
      skillCount += 1;
    }
  } catch (err) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  if (skillCount > 0) {
    await onLog(
      "stderr",
      `[paperclip] Staged ${skillCount} Paperclip skill(s) into a per-run OMP skills overlay\n`,
    );
  }
  return {
    stageDir,
    skillsDir,
    skillCount,
    cleanup: async () => {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function writeOmpSkillsOverlay(stage: OmpSkillsStage, skillsDir: string): Promise<string> {
  const overlayPath = path.join(stage.stageDir, "overlay.yml");
  await fs.writeFile(overlayPath, buildOmpRunOverlay(skillsDir), "utf8");
  return overlayPath;
}

// Remote targets: the overlay must reference the skills dir at its in-sandbox
// path, and the overlay file itself must exist on the remote host. Both are
// written through the execution-target shell after the stage asset lands.
async function writeRemoteOmpSkillsOverlay(input: {
  runId: string;
  executionTarget: AdapterExecutionTarget | null;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: AdapterExecutionContext["onLog"];
  runtimeRootDir: string;
  remoteSkillsDir: string;
}): Promise<string> {
  const overlayPath = path.posix.join(input.runtimeRootDir, "omp-skills-overlay.yml");
  const overlayYaml = buildOmpRunOverlay(input.remoteSkillsDir);
  const quotedOverlayPath = shellQuote(overlayPath);
  const script = [
    "mkdir -p $(dirname " + quotedOverlayPath + ")",
    `cat > ${quotedOverlayPath} <<'OMP_OVERLAY_EOF'\n${overlayYaml}OMP_OVERLAY_EOF`,
  ].join("\n");
  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.executionTarget,
    script,
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
      graceSec: input.graceSec,
    },
  );
  if (result.timedOut || (result.exitCode ?? 0) !== 0) {
    throw new Error(
      `Failed to write the OMP skills overlay on the remote target: ${firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || "shell command failed"}`,
    );
  }
  void input.onLog;
  return overlayPath;
}

function resolveOmpBiller(env: Record<string, string>, provider: string | null): string {
  return provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown";
}

async function ensureSessionsDir(sessionDir: string): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
}

function buildSessionDir(agentId: string): string {
  return path.join(OMP_SESSIONS_ROOT, agentId);
}

function buildRemoteSessionDir(runtimeRootDir: string, agentId: string): string {
  return path.posix.join(runtimeRootDir, "sessions", agentId);
}

function normalizeExecutionCwd(candidate: string, remote: boolean): string {
  return remote ? path.posix.normalize(candidate) : path.resolve(candidate);
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return normalizeExecutionCwd(saved, remote) === normalizeExecutionCwd(current, remote);
}

// OMP session files start with a `title` line; the `session` header (carrying
// id and cwd) follows on a later line. Scan until it appears.
function readSessionHeaderCwd(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type !== "session") continue;
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
      return cwd.length > 0 ? cwd : null;
    } catch {
      continue;
    }
  }
  return null;
}

function findLocalSessionFilePath(sessionDir: string, sessionId: string): Promise<string | null> {
  const suffix = `${sessionId}.jsonl`;
  return fs
    .readdir(sessionDir)
    .then((entries) => entries.find((name) => name.endsWith(suffix)) ?? null)
    .then((name) => (name ? path.join(sessionDir, name) : null))
    .catch(() => null);
}

async function readSavedSessionCwd(input: {
  runId: string;
  sessionDir: string;
  sessionId: string;
  executionTarget: AdapterExecutionTarget | null;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!input.sessionId.trim()) return null;

  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    const sessionPath = await findLocalSessionFilePath(input.sessionDir, input.sessionId);
    if (!sessionPath) return null;
    try {
      return readSessionHeaderCwd(await fs.readFile(sessionPath, "utf8"));
    } catch {
      return null;
    }
  }

  try {
    const sessionHeader = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `grep -h -m1 '"type":"session"' ${shellQuote(input.sessionDir)}/*${shellQuote(input.sessionId)}.jsonl 2>/dev/null || true`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    if (sessionHeader.timedOut || (sessionHeader.exitCode ?? 0) !== 0) return null;
    return readSessionHeaderCwd(sessionHeader.stdout);
  } catch {
    return null;
  }
}

// Fallback when the stream carried no `session` event (older OMP builds): the
// newest *.jsonl in the managed session dir is the run's session.
async function resolveNewestSessionId(input: {
  runId: string;
  executionTarget: AdapterExecutionTarget | null;
  sessionDir: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  if (!adapterExecutionTargetIsRemote(input.executionTarget)) {
    try {
      const entries = await fs.readdir(input.sessionDir);
      const newest = entries
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .at(-1);
      if (!newest) return null;
      const id = newest.slice(newest.indexOf("_") + 1, -".jsonl".length);
      return id || null;
    } catch {
      return null;
    }
  }
  try {
    const listing = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.executionTarget,
      `ls -1 ${shellQuote(input.sessionDir)} 2>/dev/null | grep '\\.jsonl$' | sort | tail -1`,
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec > 0 ? Math.min(input.timeoutSec, 15) : 15,
        graceSec: input.graceSec,
      },
    );
    const newest = firstNonEmptyLine(listing.stdout);
    if (!newest || !newest.includes("_")) return null;
    return newest.slice(newest.indexOf("_") + 1, -".jsonl".length) || null;
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const hasCustomPromptTemplate = asString(config.promptTemplate, "").trim().length > 0;
  const command = asString(config.command, "omp");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const smolModel = asString(config.smolModel, "").trim();
  const slowModel = asString(config.slowModel, "").trim();
  const planModel = asString(config.planModel, "").trim();
  const toolsFilter = asString(config.tools, "").trim();
  const noLsp = config.noLsp === true;
  const noPty = config.noPty === true;
  const maxTimeSec = asNumber(config.maxTimeSec, 0);
  const stdoutLogMode = resolveOmpStdoutLogMode(config);

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const ompSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOmpSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, ompSkillEntries);
  // Staged per run (local and remote alike) so the skill surface is scoped to
  // this agent and never accumulates in a shared home.
  const skillsStage = await buildOmpSkillsStage(onLog, config);

  // Build environment
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  // Materialize custom OMP providers (PAPERCLIP_OMP_PROVIDERS) into a managed
  // PI_CODING_AGENT_DIR before runtimeEnv is computed, so both local validation
  // and the spawned OMP process resolve models against the managed models.yml.
  const preparedRuntimeConfig = await prepareOmpRuntimeConfig({ env });
  const localAgentConfigDir = preparedRuntimeConfig.agentConfigDir ?? "";
  if (localAgentConfigDir) {
    env.PI_CODING_AGENT_DIR = localAgentConfigDir;
  }
  try {
    // Prepend staged skill `bin/` dirs to PATH so an agent's bash tool can
    // invoke skill binaries (e.g. `paperclip-get-issue`) by name. Without this,
    // any omp_local agent whose AGENTS.md calls a skill command via bash hits
    // exit 127 "command not found". Only include skills actually staged.
    const stagedSkillKeys = new Set(desiredOmpSkillNames);
    const skillBinDirs = ompSkillEntries
      .filter((entry) => stagedSkillKeys.has(entry.key) && entry.source.length > 0)
      .map((entry) => path.join(entry.source, "bin"));
    const mergedEnv = ensurePathInEnv({ ...process.env, ...env });
    const pathKey =
      typeof mergedEnv.Path === "string" && mergedEnv.Path.length > 0 && !mergedEnv.PATH
        ? "Path"
        : "PATH";
    const basePath = mergedEnv[pathKey] ?? "";
    if (skillBinDirs.length > 0) {
      const existing = basePath.split(path.delimiter).filter(Boolean);
      const additions = skillBinDirs.filter((dir) => !existing.includes(dir));
      if (additions.length > 0) {
        mergedEnv[pathKey] = [...additions, basePath].filter(Boolean).join(path.delimiter);
      }
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(mergedEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    if (!executionTargetIsRemote) {
      await ensureOmpModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let remoteSkillsDir: string | null = null;
    let paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null = null;

    if (executionTargetIsRemote) {
      try {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and OMP runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "omp",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          onProgress: (line) => onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [
            {
              key: "skills",
              localDir: skillsStage.skillsDir,
              followSymlinks: true,
            },
            ...(localAgentConfigDir
              ? [{
                key: "agentConfig",
                localDir: localAgentConfigDir,
              }]
              : []),
          ],
        });
        restoreRemoteWorkspace = () =>
          preparedRemoteRuntime.restoreWorkspace((line) => onLog("stdout", line));
        effectiveExecutionCwd = preparedRemoteRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
        refreshPaperclipWorkspaceEnvForExecution({
          env,
          envConfig,
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceSource,
          workspaceId,
          workspaceRepoUrl,
          workspaceRepoRef,
          workspaceHints,
          agentHome,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
        });
        if (adapterExecutionTargetUsesManagedHome(executionTarget) && preparedRemoteRuntime.runtimeRootDir) {
          env.HOME = preparedRemoteRuntime.runtimeRootDir;
        }
        remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
        remoteSkillsDir = preparedRemoteRuntime.assetDirs.skills ?? null;
        if (localAgentConfigDir && preparedRemoteRuntime.assetDirs.agentConfig) {
          env.PI_CODING_AGENT_DIR = preparedRemoteRuntime.assetDirs.agentConfig;
        }
      } catch (error) {
        await restoreRemoteWorkspace?.().catch(() => undefined);
        throw error;
      }
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "omp",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    // Skills overlay: local runs read the staged overlay directly; remote runs
    // write one referencing the in-sandbox skills dir.
    const overlayPath = executionTargetIsRemote
      ? remoteRuntimeRootDir && remoteSkillsDir
        ? await writeRemoteOmpSkillsOverlay({
            runId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
            onLog,
            runtimeRootDir: remoteRuntimeRootDir,
            remoteSkillsDir,
          })
        : null
      : await writeOmpSkillsOverlay(skillsStage, skillsStage.skillsDir);

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const localSessionDir = buildSessionDir(agent.id);
    const remoteSessionDir = remoteRuntimeRootDir
      ? buildRemoteSessionDir(remoteRuntimeRootDir, agent.id)
      : null;
    const sessionDir = executionTargetIsRemote
      ? remoteSessionDir ?? path.posix.join(effectiveExecutionCwd, ".omp-paperclip-sessions", agent.id)
      : localSessionDir;
    if (!executionTargetIsRemote) {
      await ensureSessionsDir(sessionDir);
    }
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 ||
      executionCwdsMatch(runtimeSessionCwd, effectiveExecutionCwd, executionTargetIsRemote);
    const savedSessionCwd =
      runtimeSessionId.length > 0
        ? await readSavedSessionCwd({
            runId,
            sessionDir,
            sessionId: runtimeSessionId,
            executionTarget: runtimeExecutionTarget ?? null,
            cwd,
            env,
            timeoutSec,
            graceSec,
          })
        : null;
    const sessionHeaderCwdMatches =
      runtimeSessionId.length === 0 ||
      (savedSessionCwd !== null &&
        executionCwdsMatch(savedSessionCwd, effectiveExecutionCwd, executionTargetIsRemote));
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionTargetMatches &&
      sessionParamsCwdMatches &&
      sessionHeaderCwdMatches;

    if (runtimeSessionId && !canResumeSession) {
      const staleSessionCwdNote =
        savedSessionCwd !== null && !sessionHeaderCwdMatches
          ? ` OMP stored cwd "${savedSessionCwd}" in the session header, so Paperclip will start a fresh session for "${effectiveExecutionCwd}".`
          : "";
      await onLog(
        "stdout",
        executionTargetIsRemote
          ? `[paperclip] OMP session "${runtimeSessionId}" does not match the current remote execution state and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote} Starting a fresh remote session.\n`
          : `[paperclip] OMP session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".${staleSessionCwdNote}\n`,
      );
    }

    // Handle instructions file and build system prompt extension
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

    let systemPromptExtension = "";
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        // Fall back to base prompt template
        systemPromptExtension = promptTemplate;
      }
    } else {
      systemPromptExtension = promptTemplate;
    }

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
    const systemOwnsDefaultPolicy = !hasCustomPromptTemplate || Boolean(resolvedInstructionsFilePath && !instructionsReadFailed);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (stdoutLogMode !== "raw") {
        notes.push(`OMP stdout run-log compaction mode: ${stdoutLogMode}`);
      }
      if (skillsStage.skillCount > 0) {
        notes.push(
          `Staged ${skillsStage.skillCount} Paperclip skill(s) into a per-run OMP skills overlay (host-level skill sources disabled).`,
        );
      }
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsReadFailed) {
        notes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
        return notes;
      }
      notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      notes.push(
        `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
      );
      return notes;
    })();

    const buildArgs = (resumeId: string | null, overlay: string | null, userPrompt: string): string[] => {
      const args: string[] = [];

      // Use JSON mode for structured output with print mode (non-interactive)
      args.push("--mode", "json");
      args.push("-p"); // Non-interactive mode: process prompt and exit

      // Use --append-system-prompt to extend OMP's default system prompt
      args.push("--append-system-prompt", renderedSystemPromptExtension);

      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);
      if (smolModel) args.push("--smol", smolModel);
      if (slowModel) args.push("--slow", slowModel);
      if (planModel) args.push("--plan", planModel);
      if (toolsFilter) args.push("--tools", toolsFilter);
      if (noLsp) args.push("--no-lsp");
      if (noPty) args.push("--no-pty");
      if (maxTimeSec > 0) args.push("--max-time", String(maxTimeSec));

      // Headless runs must never block on an interactive approval prompt, even
      // when the host config sets tools.approvalMode to always-ask.
      args.push("--approval-mode", "yolo");

      args.push("--session-dir", sessionDir);
      if (resumeId) args.push("--resume", resumeId);
      if (overlay) args.push("--config", overlay);

      if (extraArgs.length > 0) args.push(...extraArgs);

      // Add the user prompt as the last argument
      args.push(userPrompt);

      return args;
    };

    const runAttempt = async (resumeId: string | null) => {
      const attemptResumedSession = canResumeSession && resumeId === runtimeSessionId;
      await hydrateFreshSessionHandoff(ctx, { resumedSession: attemptResumedSession });
      const attemptSections = selectPaperclipPromptSections(context, {
        resumedSession: attemptResumedSession,
        includeCommunicationGuidance: false,
        includeExecutionContract: systemOwnsDefaultPolicy ? false : undefined,
      });
      const attemptBootstrapPrompt = !attemptResumedSession && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
      const attemptWakePrompt = attemptSections.wakePrompt;
      const attemptRenderedHeartbeatPrompt = attemptResumedSession && attemptWakePrompt.length > 0
        || isPaperclipRecoveryWakePayload(context.paperclipWake)
        || !hasCustomPromptTemplate
        ? ""
        : renderTemplate(promptTemplate, templateData);
      const attemptBaseUserPrompt = joinPromptSections([
        attemptBootstrapPrompt,
        attemptWakePrompt,
        attemptSections.taskContextNote,
        sessionHandoffNote,
        attemptRenderedHeartbeatPrompt,
      ]);
      const userPrompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: attemptResumedSession }),
        attemptBaseUserPrompt,
      ]);
      const promptMetrics = {
        systemPromptChars: renderedSystemPromptExtension.length,
        promptChars: userPrompt.length,
        bootstrapPromptChars: attemptBootstrapPrompt.length,
        wakePromptChars: attemptWakePrompt.length,
        taskContextChars: attemptSections.taskContextNote.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: attemptRenderedHeartbeatPrompt.length,
      };
      const args = buildArgs(resumeId, overlayPath, userPrompt);
      if (onMeta) {
        await onMeta({
          adapterType: "omp_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt: userPrompt,
          promptMetrics: { ...promptMetrics, promptChars: userPrompt.length },
          context,
        });
      }

      // Buffer stdout by lines to handle partial JSON chunks
      let stdoutBuffer = "";
      const compactStdoutLine = createOmpStdoutCompactor(stdoutLogMode);
      // Compaction only affects the persisted run log; parseOmpJsonl reads the unfiltered proc.stdout.
      const emitCompacted = async (line: string, suffix: string) => {
        const compacted = compactStdoutLine(line);
        if (compacted !== null) {
          await onLog("stdout", compacted + suffix);
        }
      };
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          // Pass stderr through immediately (not JSONL)
          await onLog(stream, chunk);
          return;
        }

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line) {
            await emitCompacted(line, "\n");
          }
        }
      };

      const consumeAccounting = createOmpJsonlParser();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(bufferedOnLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        return { usage: parsed.usage, costUsd: parsed.usage.costUsd, usageBasis: "per_run", provider, biller: resolveOmpBiller(runtimeEnv, provider), billingType: "unknown", model, complete: parsed.sawAgentEnd };
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        cwd,
        env: executionTargetIsRemote ? env : runtimeEnv,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: accountingLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });
      await accountingLog.flush();

      // Flush any remaining buffer content
      if (stdoutBuffer) {
        await emitCompacted(stdoutBuffer, "");
      }

      // Display output is capped by the process transport. Keep accounting
      // from the full stream, including when no checkpoint callback is installed.
      const parsed = parseOmpJsonl(proc.stdout);
      if (hasAccounting) {
        const retained = consumeAccounting("");
        parsed.usage = retained.usage;
        parsed.sawAgentEnd = retained.sawAgentEnd;
      }
      return { proc, rawStderr: proc.stderr, parsed };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ParsedOmpOutput;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: attempt.parsed.sawAgentEnd,
        usage: attempt.parsed.usage, usageBasis: "per_run", provider, biller: resolveOmpBiller(runtimeEnv, provider), model, billingType: "unknown", costUsd: attempt.parsed.usage.costUsd,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId = clearSessionOnMissingSession ? null : attempt.parsed.sessionId;
      const resolvedSessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          }
        : null;

      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const parsedError = attempt.parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const effectiveExitCode = (rawExitCode ?? 0) === 0 && parsedError ? 1 : rawExitCode;
      const fallbackErrorMessage = parsedError || stderrLine || `OMP exited with code ${rawExitCode ?? -1}`;

      return {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: attempt.parsed.sawAgentEnd,
      usageBasis: "per_run",
        errorMessage: (effectiveExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: provider,
        biller: resolveOmpBiller(runtimeEnv, provider),
        model: model,
        billingType: "unknown",
        costUsd: attempt.parsed.usage.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
        clearSession: Boolean(clearSessionOnMissingSession),
      };
    };

    try {
      const initial = await runAttempt(canResumeSession ? runtimeSessionId : null);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

      if (
        canResumeSession &&
        initialFailed &&
        isOmpUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OMP session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      try {
        await providerStop.collectBeforeRestore();
      } finally {
        await Promise.all([
          paperclipBridge?.stop(),
          restoreRemoteWorkspace?.(),
        ]);
      }
    }
  } finally {
    await Promise.all([
      preparedRuntimeConfig.cleanup(),
      skillsStage.cleanup(),
    ]);
  }
}
