import { describe, expect, it, vi } from "vitest";
import {
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_WINDOW_MS,
  autoRetrySourceForRun,
  createAutoRetryPolicy,
  type AutoRetryCandidate,
  type AutoRetryPolicyQueries,
} from "./auto-requeue.js";

const NOW = new Date("2026-03-07T12:00:00.000Z");
const candidate: AutoRetryCandidate = { runId: "run-1", companyId: "company-1", agentId: "agent-1", taskKey: "issue-1" };

function policyWith(overrides: Partial<AutoRetryPolicyQueries> & { failures?: number } = {}) {
  const queries = {
    countRecentTaskFailures: overrides.countRecentTaskFailures ?? vi.fn(async () => overrides.failures ?? 1),
    hasScheduledSuccessor: overrides.hasScheduledSuccessor ?? vi.fn(async () => false),
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

  it.each([null, "", "__heartbeat__"])("never retries unscoped runs (taskKey %j) and skips both queries", async (taskKey) => {
    const { queries, policy } = policyWith({ failures: 1 });
    await expect(policy.shouldAutoRetry({ ...candidate, taskKey })).resolves.toBe(false);
    expect(queries.hasScheduledSuccessor).not.toHaveBeenCalled();
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

describe("autoRetrySourceForRun", () => {
  it("reads the task key from the run context and the issue from the durable scope", () => {
    expect(autoRetrySourceForRun({ id: "r", scopeKind: "issue", issueId: "i-1", contextSnapshot: { taskKey: "t-1" } }))
      .toEqual({ runId: "r", taskKey: "t-1", issueId: "i-1" });
  });

  it("does not promote an unscoped run's context into an issue binding", () => {
    expect(autoRetrySourceForRun({ id: "r", scopeKind: "company", issueId: null, contextSnapshot: { taskKey: "t-1", issueId: "i-9" } }))
      .toEqual({ runId: "r", taskKey: "t-1", issueId: null });
    expect(autoRetrySourceForRun({ id: "r", contextSnapshot: null })).toEqual({ runId: "r", taskKey: null, issueId: null });
  });
});
