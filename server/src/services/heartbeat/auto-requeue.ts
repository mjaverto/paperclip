import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * Blanket auto-retry for failed task-scoped runs. It complements the classified
 * bounded retries in `retries.ts`: when a run fails (or times out) on a specific
 * task, upstream scheduled no successor for it, and the task has failed fewer
 * than `AUTO_RETRY_MAX_ATTEMPTS` times inside `AUTO_RETRY_WINDOW_MS`,
 * `finalizeAgentStatus` asks `scheduleBoundedRetryForRun` for a retry with
 * reason `auto_retry_after_failure`. Only when that retry is actually scheduled
 * does the agent stay `idle`; every upstream gate that declines (external runs,
 * completion-outbox ownership, invalid tool definitions, non-invokable agent,
 * exhausted budget) leaves the agent in `error` as before. After the third
 * strike the agent goes to `error` as well.
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
}

/** What `finalizeAgentStatus` needs to know about the run that just failed. */
export interface AutoRetrySource {
  runId: string;
  taskKey: string | null;
}

export function autoRetrySourceForRun(run: { id: string; contextSnapshot?: unknown }): AutoRetrySource {
  const context =
    run.contextSnapshot && typeof run.contextSnapshot === "object"
      ? (run.contextSnapshot as Record<string, unknown>)
      : {};
  const taskKey = typeof context.taskKey === "string" && context.taskKey.length > 0 ? context.taskKey : null;
  return { runId: run.id, taskKey };
}

export interface AutoRetryPolicyQueries {
  /** Failed/timed_out runs for this agent + task inside the window (includes the run that just failed). */
  countRecentTaskFailures: (input: AutoRetryCandidate, since: Date) => Promise<number>;
  /** True when another lane (e.g. upstream bounded retry) already queued a successor of this run. */
  hasScheduledSuccessor: (input: AutoRetryCandidate) => Promise<boolean>;
}

export function isAutoRetryTaskKey(taskKey: string | null | undefined): taskKey is string {
  return typeof taskKey === "string" && taskKey.length > 0 && taskKey !== SYNTHETIC_HEARTBEAT_TASK_KEY;
}

export function createAutoRetryPolicy(queries: AutoRetryPolicyQueries, now: () => Date = () => new Date()) {
  /**
   * Decide whether a just-failed run should be auto-requeued. The cheap
   * checks run first so unscoped runs and already-retried runs never hit the
   * strike query.
   */
  async function shouldAutoRetry(candidate: AutoRetryCandidate): Promise<boolean> {
    if (!isAutoRetryTaskKey(candidate.taskKey)) return false;
    // Upstream's bounded lane (or any other retry path) already scheduled a
    // successor: a second wakeup would double-retry the same failure.
    if (await queries.hasScheduledSuccessor(candidate)) return false;
    const since = new Date(now().getTime() - AUTO_RETRY_WINDOW_MS);
    const failures = await queries.countRecentTaskFailures(candidate, since);
    return failures < AUTO_RETRY_MAX_ATTEMPTS;
  }
  return { shouldAutoRetry };
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
  };
}
