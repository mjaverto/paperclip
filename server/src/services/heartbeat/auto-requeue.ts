import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { normalizeResponsibleUserDenialCode } from "../responsible-user-denial-run-outcomes.js";
import { hasExplicitBlockerPath } from "../recovery/explicit-blocker-path.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../recovery/pause-hold-guard.js";

/**
 * Blanket auto-retry for failed task-scoped runs. It complements the classified
 * bounded retries in `retries.ts`: when a run fails (or times out) on a specific
 * task, upstream scheduled no successor for it, and the task has failed fewer
 * than `AUTO_RETRY_MAX_ATTEMPTS` times inside `AUTO_RETRY_WINDOW_MS`,
 * `finalizeAgentStatus` asks `scheduleBoundedRetryForRun` for a retry with
 * reason `auto_retry_after_failure`. Only when that retry is actually scheduled
 * does the agent stay `idle`; every upstream gate that declines (external runs,
 * completion-outbox ownership, invalid tool definitions, non-invokable agent,
 * budget, exhausted budget) leaves the agent in `error` as before. After the
 * third strike the agent goes to `error` as well.
 */
export const AUTO_RETRY_MAX_ATTEMPTS = 3;
export const AUTO_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUTO_RETRY_REASON = "auto_retry_after_failure";
export const AUTO_RETRY_WAKE_REASON = AUTO_RETRY_REASON;
/** Same pause upstream's bounded transient lane uses between attempts. */
export const AUTO_RETRY_DELAY_MS = 30_000;

const AUTO_RETRY_FAILURE_STATUSES = ["failed", "timed_out"] as const;
const SYNTHETIC_HEARTBEAT_TASK_KEY = "__heartbeat__";

export interface AutoRetryCandidate {
  runId: string;
  companyId: string;
  agentId: string;
  taskKey: string | null;
  issueId: string | null;
}

/** What `finalizeAgentStatus` needs to know about the run that just failed. */
export interface AutoRetrySource {
  runId: string;
  taskKey: string | null;
  issueId: string | null;
}

export interface AutoRetryRunFacts {
  id: string;
  runtimeMode?: string | null;
  errorCode?: string | null;
  livenessState?: string | null;
  resultJson?: unknown;
  issueId?: string | null;
  contextSnapshot?: unknown;
}

function contextOf(run: AutoRetryRunFacts): Record<string, unknown> {
  return run.contextSnapshot && typeof run.contextSnapshot === "object"
    ? (run.contextSnapshot as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The auto-retry source for a failed run, or `undefined` when this lane must
 * not touch it. Mirrors the cases where upstream already stands down from
 * automatic recovery: native runs (the native finalizer owns their recovery),
 * a durable AI-authentication card, responsible-user denials, goal-control
 * wakes, and callers' own `suppressed` facts (conversation settlement, native
 * terminal failures, deterministic setup failures).
 */
export function autoRetrySourceForRun(
  run: AutoRetryRunFacts,
  options: { suppressed?: boolean } = {},
): AutoRetrySource | undefined {
  if (options.suppressed) return undefined;
  if (run.runtimeMode === "native") return undefined;
  if (isAiAuthenticationBlocked(run)) return undefined;
  if (normalizeResponsibleUserDenialCode(run.errorCode) !== null) return undefined;
  const context = contextOf(run);
  if (nonEmptyString(context.goalControlRequestId) !== null || context.resumeSessionGoalHeartbeat === true) {
    return undefined;
  }
  return {
    runId: run.id,
    taskKey: nonEmptyString(context.taskKey),
    issueId: run.issueId ?? nonEmptyString(context.issueId),
  };
}

export interface AutoRetryPolicyQueries {
  /** Failed/timed_out runs for this agent + task inside the window (includes the run that just failed). */
  countRecentTaskFailures: (input: AutoRetryCandidate, since: Date) => Promise<number>;
  /** True when another lane (e.g. upstream bounded retry) already queued a successor of this run. */
  hasScheduledSuccessor: (input: AutoRetryCandidate) => Promise<boolean>;
  /** True when the task is under a pause hold, an explicit blocker or a persisted monitor: no automatic recovery. */
  isIssueRecoverySuppressed: (input: AutoRetryCandidate) => Promise<boolean>;
}

export function isAutoRetryTaskKey(taskKey: string | null | undefined): taskKey is string {
  return typeof taskKey === "string" && taskKey.length > 0 && taskKey !== SYNTHETIC_HEARTBEAT_TASK_KEY;
}

export function createAutoRetryPolicy(queries: AutoRetryPolicyQueries, now: () => Date = () => new Date()) {
  /**
   * Decide whether a just-failed run should be auto-retried. The cheap checks
   * run first so unscoped runs and already-retried runs never hit the strike
   * query.
   */
  async function shouldAutoRetry(candidate: AutoRetryCandidate): Promise<boolean> {
    if (!isAutoRetryTaskKey(candidate.taskKey)) return false;
    // Upstream's bounded lane (or any other retry path) already scheduled a
    // successor: a second retry would double-retry the same failure.
    if (await queries.hasScheduledSuccessor(candidate)) return false;
    if (await queries.isIssueRecoverySuppressed(candidate)) return false;
    const since = new Date(now().getTime() - AUTO_RETRY_WINDOW_MS);
    const failures = await queries.countRecentTaskFailures(candidate, since);
    return failures < AUTO_RETRY_MAX_ATTEMPTS;
  }
  return { shouldAutoRetry, hasScheduledSuccessor: queries.hasScheduledSuccessor };
}

export type AutoRetryPolicy = ReturnType<typeof createAutoRetryPolicy>;

export interface AutoRetryScheduleResult {
  outcome: string;
  reason?: string;
}

/**
 * Evaluate eligibility, then ask the bounded-retry scheduler for a retry.
 * Resolves true only when a retry exists afterwards: newly scheduled, reused,
 * or (when the scheduler throws after its transaction committed) found by a
 * follow-up successor check. Every error path resolves false.
 */
export async function attemptAutoRetry(input: {
  policy: AutoRetryPolicy;
  candidate: AutoRetryCandidate;
  schedule: () => Promise<AutoRetryScheduleResult>;
  log: { warn: (fields: object, message: string) => void; info: (fields: object, message: string) => void };
}): Promise<boolean> {
  const { policy, candidate, schedule, log } = input;
  const fields = { agentId: candidate.agentId, runId: candidate.runId, taskKey: candidate.taskKey };
  try {
    if (!(await policy.shouldAutoRetry(candidate))) return false;
  } catch (err) {
    log.warn({ ...fields, err }, "auto-retry eligibility check failed");
    return false;
  }
  let result: AutoRetryScheduleResult | null;
  try {
    result = await schedule();
  } catch (err) {
    log.warn({ ...fields, err }, "auto-retry scheduling failed");
    // The scheduler's transaction may have committed before the error surfaced.
    const successorExists = await policy.hasScheduledSuccessor(candidate).catch(() => false);
    result = successorExists ? { outcome: "scheduled" } : null;
  }
  const retried = result?.outcome === "scheduled";
  log.info(
    { ...fields, retryOutcome: result?.outcome ?? "error", reason: result?.reason },
    retried ? "auto-retry scheduled after failure" : "auto-retry not scheduled",
  );
  return retried;
}

export function createAutoRetryQueries(db: Db): AutoRetryPolicyQueries {
  return {
    async countRecentTaskFailures(input, since) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
            inArray(heartbeatRuns.status, [...AUTO_RETRY_FAILURE_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey' = ${input.taskKey}`,
            // A raw expression carries no column type, so bind the cutoff as an ISO string.
            sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
          ),
        );
      return row?.count ?? 0;
    },
    async hasScheduledSuccessor(input) {
      const [row] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.retryOfRunId, input.runId),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async isIssueRecoverySuppressed(input) {
      if (!input.issueId) return false;
      if (await isAutomaticRecoverySuppressedByPauseHold(db, input.companyId, input.issueId)) return true;
      if (await hasExplicitBlockerPath(db, input.companyId, input.issueId)) return true;
      const [issue] = await db
        .select({ monitorNextCheckAt: issues.monitorNextCheckAt })
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
      return Boolean(issue?.monitorNextCheckAt);
    },
  };
}
