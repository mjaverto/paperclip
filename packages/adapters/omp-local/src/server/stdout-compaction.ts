import { performance } from "node:perf_hooks";
import { parseJson } from "@paperclipai/adapter-utils/server-utils";
import { asRecord } from "./guards.js";

/**
 * Stateful JSONL compaction for OMP `--mode json` stdout before it enters
 * the Paperclip run-log pipeline.
 *
 * OMP emits `message_update` events that repeat the FULL cumulative assistant
 * message on every streaming delta. Persisting each line makes run-log size
 * grow ~quadratically. In `compact` mode, stripping the cumulative copies
 * keeps growth linear without changing `parseOmpJsonl` output or UI live typing.
 *
 * No truncation here: it would run before the server's secret redaction and
 * can split a secret across the cut boundary. The server re-caps after
 * redaction; oversized content is its responsibility.
 *
 * Tool update streams become throttled Paperclip progress events so the
 * stale-run watchdog's `lastOutputAt` stays fresh during long tools.
 */

const OMP_STDOUT_LOG_MODES = ["raw", "compact"] as const;

export type OmpStdoutLogMode = (typeof OMP_STDOUT_LOG_MODES)[number];

const DEFAULT_OMP_STDOUT_LOG_MODE: OmpStdoutLogMode = "compact";

const PROGRESS_INTERVAL_MS = 5_000;

function isOmpStdoutLogMode(value: string): value is OmpStdoutLogMode {
  return OMP_STDOUT_LOG_MODES.includes(value as OmpStdoutLogMode);
}

export function resolveOmpStdoutLogMode(config: Record<string, unknown>): OmpStdoutLogMode {
  if (config.stdoutLogMode === undefined || config.stdoutLogMode === null) {
    return DEFAULT_OMP_STDOUT_LOG_MODE;
  }
  if (typeof config.stdoutLogMode !== "string") return "raw";
  const normalized = config.stdoutLogMode.trim().toLowerCase();
  if (isOmpStdoutLogMode(normalized)) {
    return normalized;
  }
  // Invalid explicit values fail safe to the lossless legacy stream rather
  // than silently enabling a lossy transformation.
  return "raw";
}

function parseLineEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  const event = parseJson(trimmed);
  return asRecord(event);
}

function slimAssistantMessageEvent(update: unknown): unknown {
  const record = asRecord(update);
  if (!record) return update;
  const { partial: _partial, ...rest } = record;
  return rest;
}

type Clock = () => number;

function createThrottle(intervalMs: number, now: Clock): () => boolean {
  let lastAt = Number.NEGATIVE_INFINITY;
  return () => {
    const current = now();
    if (current - lastAt < intervalMs) return false;
    lastAt = current;
    return true;
  };
}

function progressTick(allow: () => boolean, toolCallId?: unknown): string | null {
  if (!allow()) return null;
  // `paperclip_` prefix marks this as adapter metadata, not an OMP event.
  return JSON.stringify({
    type: "paperclip_progress",
    sourceEventType: "tool_execution_update",
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
  });
}

type OmpStdoutCompactor = (line: string) => string | null;

interface OmpStdoutCompactorOptions {
  now?: Clock;
}

// Advisor events are content-free runtime telemetry (cost ticks, yield
// notices); they carry no transcript value and only grow the run log.
const DROPPED_OMP_EVENT_TYPES = new Set([
  "advisor_cost_changed",
  "advisor_yielded",
]);

function createCompactCompactor(now: Clock): OmpStdoutCompactor {
  const allowToolTick = createThrottle(PROGRESS_INTERVAL_MS, now);
  return (line) => {
    const event = parseLineEvent(line);
    if (!event) return line;

    if (event.type === "tool_execution_update") {
      return progressTick(allowToolTick, event.toolCallId);
    }
    if (typeof event.type === "string" && DROPPED_OMP_EVENT_TYPES.has(event.type)) return null;
    // Non-`message_update` events pass through untouched — including
    // `tool_execution_end`, whose `.result` can be tens of MiB (large
    // tool/bash output). Capping that is an intentional separate follow-up:
    // truncation here would run before the server's secret redaction and
    // could split a secret across the cut boundary. See #5699.
    if (event.type !== "message_update") return line;

    const { message: _cumulativeMessage, ...rest } = event;
    return JSON.stringify({
      ...rest,
      ...(event.assistantMessageEvent !== undefined
        ? { assistantMessageEvent: slimAssistantMessageEvent(event.assistantMessageEvent) }
        : {}),
    });
  };
}

export function createOmpStdoutCompactor(
  mode: OmpStdoutLogMode,
  options: OmpStdoutCompactorOptions = {},
): OmpStdoutCompactor {
  const now = options.now ?? (() => performance.now());
  switch (mode) {
    case "raw":
      return (line) => line;
    case "compact":
      return createCompactCompactor(now);
  }
}
