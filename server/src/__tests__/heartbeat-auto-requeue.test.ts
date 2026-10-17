import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_REASON,
  AUTO_RETRY_WAKE_REASON,
  createAutoRetryQueries,
} from "../services/heartbeat/auto-requeue.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const FAILING_ADAPTER = "auto_requeue_failing_test";
const TRANSIENT_ADAPTER = "auto_requeue_transient_test";
const INVALID_TOOLS_ADAPTER = "auto_requeue_invalid_tools_test";
const MANAGER_LOSS_ADAPTER = "auto_requeue_manager_loss_test";
const UNSAFE_ADAPTER = "auto_requeue_unsafe_test";
const SAFE_RECOVERY = { kind: "bootstrap", providerWorkStarted: false } as const;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat auto-requeue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat auto-requeue after failure", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function failingAdapter(type: string, result: Record<string, unknown>, beforeFailing?: () => Promise<void>) {
    registerServerAdapter({
      type,
      execute: async () => {
        await beforeFailing?.();
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "adapter crashed",
          errorCode: "adapter_failed",
          // Pre-provider failure evidence: the only kind upstream treats as safe to replay.
          executionRecovery: SAFE_RECOVERY,
          resultJson: { executionRecovery: SAFE_RECOVERY },
          ...result,
        };
      },
      testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-auto-requeue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    failingAdapter(FAILING_ADAPTER, {});
    failingAdapter(UNSAFE_ADAPTER, { executionRecovery: undefined, resultJson: undefined });
    failingAdapter(TRANSIENT_ADAPTER, {
      errorMessage: "upstream overloaded",
      errorCode: "overloaded",
      errorFamily: "transient_upstream",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        errorFamily: "transient_upstream",
      },
    });
    failingAdapter(INVALID_TOOLS_ADAPTER, { errorCode: "provider_tool_definition_invalid" });
    // Loses its manager mid-run, so the agent is no longer invokable when it fails.
    failingAdapter(MANAGER_LOSS_ADAPTER, {}, async () => {
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.name, "Manager"));
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const type of [FAILING_ADAPTER, TRANSIENT_ADAPTER, INVALID_TOOLS_ADAPTER, MANAGER_LOSS_ADAPTER, UNSAFE_ADAPTER]) {
      unregisterServerAdapter(type);
    }
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { adapterType?: string; adapterConfig?: Record<string, unknown>; withManager?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const managerId = randomUUID();
    if (input.withManager) {
      await db.insert(agents).values({
        id: managerId, companyId, name: "Manager", role: "ceo", status: "idle", adapterType: FAILING_ADAPTER,
        adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Flaky",
      role: "engineer",
      status: "idle",
      reportsTo: input.withManager ? managerId : null,
      adapterType: input.adapterType ?? FAILING_ADAPTER,
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function agentStatus(agentId: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    return row?.status;
  }

  async function runsOf(agentId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  async function failedCount(agentId: string) {
    return (await runsOf(agentId)).filter((run) => run.status === "failed").length;
  }

  /**
   * Make every scheduled retry due and drive it, exactly as the scheduler tick does
   * (server index.ts): promotion only moves a run to `queued`; `resumeQueuedRuns` is
   * what starts it. Promoting alone leaves the run queued whenever the previous
   * run's own tail has already finished its queue sweep.
   */
  async function promoteScheduledRetries() {
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 60 * 60 * 1000));
    await heartbeat.resumeQueuedRuns();
  }

  /** The failed run must finish with the agent parked in `error` and no successor of any kind. */
  async function expectErrorWithoutRetry(agentId: string, runId: string) {
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("error");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await runsOf(agentId);
    expect(runs.map((run) => run.id)).toEqual([runId]);
    expect(runs.some((run) => run.retryOfRunId !== null)).toBe(false);
    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.some((wake) => wake.reason === AUTO_RETRY_WAKE_REASON)).toBe(false);
  }

  it("schedules a bounded retry after the first failure and keeps the agent idle", async () => {
    const { agentId } = await seedAgent();
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-A" }, "manual");
    await expect.poll(async () => (await runsOf(agentId)).filter((r) => r.status === "scheduled_retry").length, {
      timeout: 10_000,
      interval: 50,
    }).toBe(1);
    const [retry] = (await runsOf(agentId)).filter((r) => r.status === "scheduled_retry");
    expect(retry).toMatchObject({ retryOfRunId: run!.id, scheduledRetryReason: AUTO_RETRY_REASON });
    expect((retry!.contextSnapshot as Record<string, unknown>).taskKey).toBe("task-A");
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("idle");
  }, 30_000);

  it("retries a task until the third strike, then parks the agent in error", async () => {
    const { agentId } = await seedAgent();
    await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-B" }, "manual");
    for (let strike = 1; strike < AUTO_RETRY_MAX_ATTEMPTS; strike += 1) {
      await expect.poll(() => failedCount(agentId), { timeout: 15_000, interval: 50 }).toBe(strike);
      await expect
        .poll(async () => (await runsOf(agentId)).filter((r) => r.status === "scheduled_retry").length, { timeout: 10_000, interval: 50 })
        .toBe(1);
      await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("idle");
      await promoteScheduledRetries();
    }
    await expect.poll(() => failedCount(agentId), { timeout: 15_000, interval: 50 }).toBe(AUTO_RETRY_MAX_ATTEMPTS);
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("error");

    // No fourth attempt after the strike limit.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await runsOf(agentId);
    expect(runs).toHaveLength(AUTO_RETRY_MAX_ATTEMPTS);
    expect(runs.some((run) => run.status === "scheduled_retry")).toBe(false);
    expect(runs.every((run) => (run.contextSnapshot as Record<string, unknown>).taskKey === "task-B")).toBe(true);
    expect(runs.filter((run) => run.scheduledRetryReason === AUTO_RETRY_REASON)).toHaveLength(AUTO_RETRY_MAX_ATTEMPTS - 1);
  }, 60_000);

  it("does not double-retry a run upstream's bounded lane already scheduled", async () => {
    const { agentId } = await seedAgent({ adapterType: TRANSIENT_ADAPTER });
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-C" }, "manual");
    await expect.poll(async () => (await runsOf(agentId)).filter((r) => r.retryOfRunId === run!.id).length, {
      timeout: 10_000,
      interval: 50,
    }).toBe(1);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const successors = (await runsOf(agentId)).filter((r) => r.retryOfRunId !== null);
    expect(successors).toHaveLength(1);
    expect(successors[0]!.scheduledRetryReason).not.toBe(AUTO_RETRY_REASON);
  }, 30_000);

  it("sends unscoped failures straight to error without a retry", async () => {
    const { agentId } = await seedAgent();
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await expectErrorWithoutRetry(agentId, run!.id);
  }, 20_000);

  describe("stays in error when upstream's retry gates decline", () => {
    it("openai_dot external runs (an external stop cannot be confirmed)", async () => {
      const { agentId } = await seedAgent({ adapterConfig: { provider: "openai_dot" } });
      const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-dot" }, "manual");
      await expectErrorWithoutRetry(agentId, run!.id);
    }, 20_000);

    it("runs whose provider work may have started (upstream requires reconciliation first)", async () => {
      const { agentId } = await seedAgent({ adapterType: UNSAFE_ADAPTER });
      const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-unsafe" }, "manual");
      await expectErrorWithoutRetry(agentId, run!.id);
    }, 20_000);

    it("runs whose retry budget the completion outbox owns", async () => {
      const { agentId } = await seedAgent();
      const run = await heartbeat.invoke(
        agentId,
        "on_demand",
        { taskKey: "task-outbox", chatCompletionDeliveryIds: [randomUUID()] },
        "manual",
      );
      await expectErrorWithoutRetry(agentId, run!.id);
    }, 20_000);

    it("provider_tool_definition_invalid failures", async () => {
      const { agentId } = await seedAgent({ adapterType: INVALID_TOOLS_ADAPTER });
      const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-tools" }, "manual");
      await expectErrorWithoutRetry(agentId, run!.id);
    }, 20_000);

    it("agents that are no longer invokable", async () => {
      const { agentId } = await seedAgent({ adapterType: MANAGER_LOSS_ADAPTER, withManager: true });
      const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-orphan" }, "manual");
      await expectErrorWithoutRetry(agentId, run!.id);
    }, 20_000);
  });
  describe("queries", () => {
    it("suppresses retries for tasks with a persisted monitor or an open explicit blocker", async () => {
      const { companyId, agentId } = await seedAgent();
      const queries = createAutoRetryQueries(db);
      const insertIssue = async (extra: Partial<typeof issues.$inferInsert> = {}) => {
        const id = randomUUID();
        await db.insert(issues).values({
          id, companyId, title: "Task", status: "in_progress", priority: "medium",
          responsibleUserId: "responsible-user", assigneeAgentId: agentId, ...extra,
        });
        return id;
      };
      const plain = await insertIssue();
      const base = { runId: randomUUID(), companyId, agentId, taskKey: "t" };
      await expect(queries.isIssueRecoverySuppressed({ ...base, issueId: plain })).resolves.toBe(false);
      await expect(queries.isIssueRecoverySuppressed({ ...base, issueId: null })).resolves.toBe(false);

      const monitored = await insertIssue({ monitorNextCheckAt: new Date(Date.now() + 60_000) });
      await expect(queries.isIssueRecoverySuppressed({ ...base, issueId: monitored })).resolves.toBe(true);

      const blocked = await insertIssue();
      const blocker = await insertIssue();
      await db.insert(issueRelations).values({ companyId, issueId: blocker, relatedIssueId: blocked, type: "blocks" });
      await expect(queries.isIssueRecoverySuppressed({ ...base, issueId: blocked })).resolves.toBe(true);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker));
      await expect(queries.isIssueRecoverySuppressed({ ...base, issueId: blocked })).resolves.toBe(false);
    });

    it("counts only this agent's failed or timed-out runs for the task inside the window", async () => {
      const { companyId, agentId } = await seedAgent();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const insertRun = (status: string, taskKey: string, finishedAt: Date | null, createdAt = finishedAt ?? new Date()) =>
        db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          invocationSource: "on_demand",
          status,
          contextSnapshot: { taskKey },
          finishedAt,
          createdAt,
        });
      const recent = new Date();
      const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await insertRun("failed", "t", recent);
      await insertRun("timed_out", "t", recent);
      await insertRun("succeeded", "t", recent);
      await insertRun("failed", "t", stale);
      await insertRun("failed", "other-task", recent);
      const queries = createAutoRetryQueries(db);
      await expect(
        queries.countRecentTaskFailures({ runId: randomUUID(), companyId, agentId, taskKey: "t", issueId: null }, since),
      ).resolves.toBe(2);
    });

    it("detects a successor run linked through retryOfRunId", async () => {
      const { companyId, agentId } = await seedAgent();
      const parentId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: parentId, companyId, agentId, invocationSource: "on_demand", status: "failed", contextSnapshot: { taskKey: "t" },
      });
      const queries = createAutoRetryQueries(db);
      const candidate = { runId: parentId, companyId, agentId, taskKey: "t", issueId: null };
      await expect(queries.hasScheduledSuccessor(candidate)).resolves.toBe(false);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "automation", status: "scheduled_retry",
        retryOfRunId: parentId, contextSnapshot: { taskKey: "t" },
      });
      await expect(queries.hasScheduledSuccessor(candidate)).resolves.toBe(true);
    });
  });
});
