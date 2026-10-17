import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
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
  AUTO_RETRY_WAKE_REASON,
  createAutoRetryQueries,
} from "../services/heartbeat/auto-requeue.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const FAILING_ADAPTER = "auto_requeue_failing_test";
const TRANSIENT_ADAPTER = "auto_requeue_transient_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat auto-requeue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat auto-requeue after failure", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-auto-requeue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: FAILING_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "adapter crashed",
        errorCode: "adapter_failed",
      }),
      testEnvironment: async () => ({
        adapterType: FAILING_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: TRANSIENT_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "upstream overloaded",
        errorCode: "overloaded",
        errorFamily: "transient_upstream",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "transient_upstream",
        },
      }),
      testEnvironment: async () => ({
        adapterType: TRANSIENT_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
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
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(FAILING_ADAPTER);
    unregisterServerAdapter(TRANSIENT_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType = FAILING_ADAPTER) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Flaky",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function agentStatus(agentId: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    return row?.status;
  }

  async function failedRuns(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(asc(heartbeatRuns.createdAt));
  }

  it("requeues a failed task-scoped run until the third strike, then parks the agent in error", async () => {
    const { agentId } = await seedAgent();
    await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-A" }, "manual");

    await expect
      .poll(async () => (await failedRuns(agentId)).filter((run) => run.status === "failed").length, {
        timeout: 20_000,
        interval: 50,
      })
      .toBe(AUTO_RETRY_MAX_ATTEMPTS);
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("error");

    // No fourth attempt after the strike limit.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await failedRuns(agentId);
    expect(runs).toHaveLength(AUTO_RETRY_MAX_ATTEMPTS);
    expect(runs.every((run) => (run.contextSnapshot as Record<string, unknown>).taskKey === "task-A")).toBe(true);

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason, source: agentWakeupRequests.source })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.filter((wake) => wake.reason === AUTO_RETRY_WAKE_REASON)).toEqual(
      Array.from({ length: AUTO_RETRY_MAX_ATTEMPTS - 1 }, () => ({ reason: AUTO_RETRY_WAKE_REASON, source: "automation" })),
    );
  }, 40_000);

  it("enqueues an automation wakeup after the first failure", async () => {
    const { agentId } = await seedAgent();
    await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-B" }, "manual");
    await expect
      .poll(
        () =>
          db
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, AUTO_RETRY_WAKE_REASON)))
            .then((rows) => rows.length),
        { timeout: 10_000, interval: 25 },
      )
      .toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("does not double-retry a run upstream's bounded lane already scheduled", async () => {
    const { agentId } = await seedAgent(TRANSIENT_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "task-C" }, "manual");
    expect(run).not.toBeNull();
    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("error");
    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.some((wake) => wake.reason === AUTO_RETRY_WAKE_REASON)).toBe(false);
  }, 30_000);

  it("sends unscoped failures straight to error without requeueing", async () => {
    const { agentId } = await seedAgent();
    await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    await expect.poll(() => agentStatus(agentId), { timeout: 10_000, interval: 50 }).toBe("error");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await failedRuns(agentId)).toHaveLength(1);
    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.some((wake) => wake.reason === AUTO_RETRY_WAKE_REASON)).toBe(false);
  }, 20_000);

  describe("queries", () => {
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
        queries.countRecentTaskFailures({ runId: randomUUID(), companyId, agentId, taskKey: "t" }, since),
      ).resolves.toBe(2);
    });

    it("detects a successor run linked through retryOfRunId", async () => {
      const { companyId, agentId } = await seedAgent();
      const parentId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: parentId, companyId, agentId, invocationSource: "on_demand", status: "failed", contextSnapshot: { taskKey: "t" },
      });
      const queries = createAutoRetryQueries(db);
      const candidate = { runId: parentId, companyId, agentId, taskKey: "t" };
      await expect(queries.hasScheduledSuccessor(candidate)).resolves.toBe(false);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "automation", status: "scheduled_retry",
        retryOfRunId: parentId, contextSnapshot: { taskKey: "t" },
      });
      await expect(queries.hasScheduledSuccessor(candidate)).resolves.toBe(true);
    });
  });
});
