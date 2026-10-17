import { describe, expect, it, vi } from "vitest";
import {
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_WINDOW_MS,
  attemptAutoRetry,
  autoRetrySourceForRun,
  createAutoRetryPolicy,
  type AutoRetryCandidate,
  type AutoRetryPolicyQueries,
} from "./auto-requeue.js";

const NOW = new Date("2026-03-07T12:00:00.000Z");
const candidate: AutoRetryCandidate = {
  runId: "run-1", companyId: "company-1", agentId: "agent-1", taskKey: "issue-1", issueId: "issue-1",
};

function policyWith(overrides: Partial<AutoRetryPolicyQueries> & { failures?: number } = {}) {
  const queries = {
    countRecentTaskFailures: overrides.countRecentTaskFailures ?? vi.fn(async () => overrides.failures ?? 1),
    hasScheduledSuccessor: overrides.hasScheduledSuccessor ?? vi.fn(async () => false),
    isIssueRecoverySuppressed: overrides.isIssueRecoverySuppressed ?? vi.fn(async () => false),
  } satisfies AutoRetryPolicyQueries;
  return { queries, policy: createAutoRetryPolicy(queries, () => NOW) };
}

describe("auto-requeue 3-strike rule", () => {
  it("retries while the task has fewer than three failures in the window (counts the run that just failed)", async () => {
    expect(AUTO_RETRY_MAX_ATTEMPTS).toBe(3);
    await expect(policyWith({ failures: 1 }).policy.shouldAutoRetry(candidate)).resolves.toBe(true);
    await expect(policyWith({ failures: 2 }).policy.shouldAutoRetry(candidate)).resolves.toBe(true);
  });

  it("stops at the third strike so the agent goes to error as before", async () => {
    await expect(policyWith({ failures: 3 }).policy.shouldAutoRetry(candidate)).resolves.toBe(false);
    await expect(policyWith({ failures: 7 }).policy.shouldAutoRetry(candidate)).resolves.toBe(false);
  });

  it("counts failures only inside the trailing 24h window", async () => {
    const { queries, policy } = policyWith({ failures: 1 });
    await policy.shouldAutoRetry(candidate);
    expect(queries.countRecentTaskFailures).toHaveBeenCalledWith(candidate, new Date(NOW.getTime() - AUTO_RETRY_WINDOW_MS));
  });

  it.each([null, "", "__heartbeat__"])("never retries unscoped runs (taskKey %j) and skips every query", async (taskKey) => {
    const { queries, policy } = policyWith({ failures: 1 });
    await expect(policy.shouldAutoRetry({ ...candidate, taskKey })).resolves.toBe(false);
    expect(queries.hasScheduledSuccessor).not.toHaveBeenCalled();
    expect(queries.isIssueRecoverySuppressed).not.toHaveBeenCalled();
    expect(queries.countRecentTaskFailures).not.toHaveBeenCalled();
  });
});

describe("auto-requeue no-double-retry guard", () => {
  it("skips when upstream's bounded lane already scheduled a successor, even under the strike limit", async () => {
    const { queries, policy } = policyWith({ failures: 1, hasScheduledSuccessor: vi.fn(async () => true) });
    await expect(policy.shouldAutoRetry(candidate)).resolves.toBe(false);
    expect(queries.hasScheduledSuccessor).toHaveBeenCalledWith(candidate);
    expect(queries.countRecentTaskFailures).not.toHaveBeenCalled();
  });

  it("still retries when no successor exists", async () => {
    const { queries, policy } = policyWith({ failures: 1 });
    await expect(policy.shouldAutoRetry(candidate)).resolves.toBe(true);
    expect(queries.hasScheduledSuccessor).toHaveBeenCalledOnce();
  });
});

describe("auto-requeue issue-level suppression", () => {
  it("stands down for pause holds, explicit blockers and persisted monitors before counting strikes", async () => {
    const { queries, policy } = policyWith({ failures: 1, isIssueRecoverySuppressed: vi.fn(async () => true) });
    await expect(policy.shouldAutoRetry(candidate)).resolves.toBe(false);
    expect(queries.isIssueRecoverySuppressed).toHaveBeenCalledWith(candidate);
    expect(queries.countRecentTaskFailures).not.toHaveBeenCalled();
  });
});

describe("autoRetrySourceForRun", () => {
  it("reads the task key and issue from the run", () => {
    expect(autoRetrySourceForRun({ id: "r", issueId: "i-1", contextSnapshot: { taskKey: "t-1" } }))
      .toEqual({ runId: "r", taskKey: "t-1", issueId: "i-1" });
    expect(autoRetrySourceForRun({ id: "r", contextSnapshot: { issueId: "i-9" } }))
      .toEqual({ runId: "r", taskKey: null, issueId: "i-9" });
    expect(autoRetrySourceForRun({ id: "r", contextSnapshot: null })).toEqual({ runId: "r", taskKey: null, issueId: null });
  });

  it("never retries native runs (the native finalizer owns their recovery)", () => {
    expect(autoRetrySourceForRun({ id: "r", runtimeMode: "native", contextSnapshot: { taskKey: "t" } })).toBeUndefined();
    expect(autoRetrySourceForRun({ id: "r", runtimeMode: "legacy", contextSnapshot: { taskKey: "t" } })).toBeDefined();
  });

  it("never retries a run a durable AI-authentication card owns", () => {
    expect(autoRetrySourceForRun({ id: "r", errorCode: "claude_auth_required", livenessState: "blocked", contextSnapshot: { taskKey: "t" } }))
      .toBeUndefined();
    // Not persisted as blocked yet: the classification, not the code alone, decides.
    expect(autoRetrySourceForRun({ id: "r", errorCode: "claude_auth_required", livenessState: "advanced", contextSnapshot: { taskKey: "t" } }))
      .toBeDefined();
  });

  it("never retries responsible-user denials", () => {
    for (const errorCode of ["RESPONSIBLE_USER_UNAUTHORIZED", "RESPONSIBLE_USER_UNAVAILABLE"]) {
      expect(autoRetrySourceForRun({ id: "r", errorCode, contextSnapshot: { taskKey: "t" } })).toBeUndefined();
    }
  });

  it.each([{ goalControlRequestId: "req-1" }, { resumeSessionGoalHeartbeat: true }])(
    "never retries goal-control wakes %j",
    (context) => {
      expect(autoRetrySourceForRun({ id: "r", contextSnapshot: { taskKey: "t", ...context } })).toBeUndefined();
    },
  );

  it("honors the caller's own suppression (conversation settled, native terminal failure, setup failure)", () => {
    expect(autoRetrySourceForRun({ id: "r", contextSnapshot: { taskKey: "t" } }, { suppressed: true })).toBeUndefined();
  });
});

describe("attemptAutoRetry", () => {
  const log = () => ({ warn: vi.fn(), info: vi.fn() });

  it("is true only for a scheduled outcome", async () => {
    const { policy } = policyWith();
    await expect(attemptAutoRetry({ policy, candidate, schedule: async () => ({ outcome: "scheduled" }), log: log() })).resolves.toBe(true);
    for (const outcome of ["not_scheduled", "retry_exhausted", "missing_run"]) {
      await expect(attemptAutoRetry({ policy, candidate, schedule: async () => ({ outcome }), log: log() })).resolves.toBe(false);
    }
  });

  it("does not schedule when ineligible", async () => {
    const { policy } = policyWith({ failures: 3 });
    const schedule = vi.fn(async () => ({ outcome: "scheduled" }));
    await expect(attemptAutoRetry({ policy, candidate, schedule, log: log() })).resolves.toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("treats a failing eligibility query as not retried instead of throwing", async () => {
    const { policy } = policyWith({ hasScheduledSuccessor: vi.fn(async () => { throw new Error("db down"); }) });
    const schedule = vi.fn(async () => ({ outcome: "scheduled" }));
    const logger = log();
    await expect(attemptAutoRetry({ policy, candidate, schedule, log: logger })).resolves.toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("counts a successor that exists after the scheduler throws as scheduled", async () => {
    const hasScheduledSuccessor = vi.fn<AutoRetryPolicyQueries["hasScheduledSuccessor"]>()
      .mockResolvedValueOnce(false) // eligibility check
      .mockResolvedValueOnce(true); // post-throw re-check
    const { policy } = policyWith({ hasScheduledSuccessor });
    const schedule = async (): Promise<{ outcome: string }> => { throw new Error("commit ack lost"); };
    await expect(attemptAutoRetry({ policy, candidate, schedule, log: log() })).resolves.toBe(true);
  });

  it("stays false when the scheduler throws and no successor exists", async () => {
    const { policy } = policyWith();
    const schedule = async (): Promise<{ outcome: string }> => { throw new Error("boom"); };
    await expect(attemptAutoRetry({ policy, candidate, schedule, log: log() })).resolves.toBe(false);
  });
});
