import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { deleteCompany } from "../services/company-deletion.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("company deletion transaction", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-company-deletion-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    // There are no installed plugins. Host cleanup still uses the real
    // heartbeat stop protocol rather than declaring providers stopped.
    configureAgentLifecycle(db, createLifecycleDriver(db, {} as never));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Archived company", status: "archived", issuePrefix: `CD${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retired engineer", adapterType: "codex_local",
      status: "terminated", lifecycleState: "terminated" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded" });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "output", message: "Preserve on rollback" });
    return { companyId, agentId, runId };
  }

  it("refuses to erase a started legacy cancellation while the real lifecycle host still lacks stop proof", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "idle", lifecycleState: "ready" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: new Date("2026-01-01T00:01:00Z"),
    }).where(eq(heartbeatRuns.id, f.runId));
    await expect(deleteCompany(db, f.companyId)).rejects.toThrow();
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status: "cancelled", resultJson: null });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.lifecycleState).toBe("terminating");
    expect(agent.lifecycleOperation?.hostComplete).not.toBe(true);
  });

  it("preserves an orphan provider teardown reference even when every company agent is terminal", async () => {
    const f = await seed();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId,
      provider: "daytona", providerLeaseId: randomUUID(), heartbeatRunId: null,
      status: "pending_cleanup", cleanupStatus: "failed", metadata: { remoteExecutionTermination: null },
    }).returning();
    await expect(deleteCompany(db, f.companyId)).rejects.toThrow();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id))).toEqual([lease]);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(1);
  });

  it("does not cascade away an owned native finalizer on the strength of a terminal agent label", async () => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Still-owned native finalizer" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.runId));
    const [coordinator] = await db.insert(nativeRunFinalizations).values({ companyId: f.companyId,
      issueId: issue.id, runId: f.runId, phase: "observed", attempt: 1, controllerGeneration: 1,
      leaseOwner: "still-owned", leaseExpiresAt: new Date(0), controllerPid: process.pid,
    }).returning();
    await expect(deleteCompany(db, f.companyId)).rejects.toThrow();
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId))).toEqual([coordinator]);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toHaveLength(1);
  });

  it("rolls back an abandoned blocked delete, leaves no orphan transaction, and permits an explicit retry", async () => {
    const f = await seed(), other = await seed();
    const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [beforeCost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId,
      heartbeatRunId: f.runId, provider: "test", model: "test", costCents: 1, occurredAt: new Date(),
    }).returning();
    const [beforeEvent] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    const blocker = await db.$client.reserve();
    await blocker`begin`;
    const [{ pid: blockerPid }] = await blocker<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await blocker`select id from heartbeat_run_events where run_id = ${f.runId} for update`;
    const controller = new AbortController();
    let settled = false;
    const outcome = deleteCompany(db, f.companyId, { signal: controller.signal })
      .then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
      .finally(() => { settled = true; });
    let deletionPid: number | undefined;
    try {
      await expect.poll(async () => {
        const blocked = await db.execute<{ pid: number }>(sql`
          select pid from pg_stat_activity
          where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))
        `);
        deletionPid = blocked[0]?.pid;
        return blocked.length;
      }, { timeout: 5_000, interval: 25 }).toBeGreaterThan(0);
      controller.abort();
      // The blocker stays held: only cancellation of the actual deletion can
      // finish this request. Releasing the lock first would conceal an orphan.
      await expect.poll(() => settled, { timeout: 3_000, interval: 25 }).toBe(true);
      expect((await outcome).error).not.toBeNull();
      expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual([beforeRun]);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toEqual([beforeEvent]);
      expect(await db.select().from(costEvents).where(eq(costEvents.id, beforeCost.id))).toEqual([beforeCost]);
      const stillDeleting = await db.execute(sql`
        select pid from pg_stat_activity where pid = ${deletionPid!} and xact_start is not null
      `);
      expect(stillDeleting).toHaveLength(0);
      // An unrelated writer must remain usable after cancellation and rollback.
      await db.update(companies).set({ description: "Unrelated company survives" }).where(eq(companies.id, other.companyId));
    } finally {
      controller.abort();
      await blocker`rollback`;
      blocker.release();
      await outcome;
    }
    expect(await deleteCompany(db, f.companyId)).toMatchObject({ id: f.companyId });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, other.companyId)))
      .toMatchObject([{ description: "Unrelated company survives" }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.runId))).toHaveLength(1);
  });
});
