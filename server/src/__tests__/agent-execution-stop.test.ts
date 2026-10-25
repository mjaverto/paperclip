import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { readProcessStartedAt } from "../services/hot-restart.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { recordNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent execution stop proof", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: Db;
  let recording = false;
  let transferredBytes: number[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-execution-stop-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    // Observe values decoded from real Postgres, not SQL text or a mocked query.
    db.$client.options.transform.value.from = (value) => {
      if (recording && value != null) {
        transferredBytes.push(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)));
      }
      return value;
    };
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    recording = false;
    transferredBytes = [];
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function seed(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop proof", issuePrefix: `SP${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "codex_local" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:01:00Z"), ...patch,
    }).returning();
    return { companyId, agentId, runId, run };
  }

  it("does not mistake terminal historical cancellation or an agent adapter change for stop proof", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, f.agentId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it.each(["queued", "running"])("rejects %s work even with an old cancellation acknowledgement", async status => {
    const f = await seed({ status, resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("honors the immutable conversation invocation when a legacy run is settled", async () => {
    const f = await seed({ executionStage: "settled", runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    await db.update(heartbeatRuns).set({ runnerProfileJson: null }).where(eq(heartbeatRuns.id, f.runId));
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      eventType: "adapter.invoke", stream: "system", level: "info", payload: { adapterType: "codex_local" } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("distinguishes a live process from reuse of its recorded PID without signalling either", async () => {
    const startedAt = await readProcessStartedAt(process.pid);
    expect(startedAt).not.toBeNull();
    const f = await seed({ processPid: process.pid, processGroupId: process.pid,
      processStartedAt: new Date(startedAt!), resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ processStartedAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    await db.update(heartbeatRuns).set({ processStartedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("requires an expired controller lease even after a run acknowledges cancellation", async () => {
    const f = await seed({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
      resultJson: { executionCancellation: { state: "acknowledged" } } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it("does not substitute local PID absence or a mismatched receipt for remote provider stop", async () => {
    const f = await seed({ processPid: process.pid, resultJson: { executionCancellation: { state: "acknowledged" } } });
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "daytona", providerLeaseId: randomUUID(), status: "released", releasedAt: new Date(), cleanupStatus: "success",
    }).returning();
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" })!;
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: { ...receipt, runId: randomUUID() } } })
      .where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } })
      .where(eq(environmentLeases.id, lease.id));
    // This PID belongs to the test host, not the provider's process namespace.
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("includes unattached resources owned through lease agent metadata", async () => {
    const f = await seed({ resultJson: { executionCancellation: { state: "acknowledged" } } });
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId,
      provider: "local", metadata: { agentId: f.agentId }, status: "pending_cleanup" }).returning();
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease.id));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it("keeps a live process group blocking even when the individual PID field is absent", async () => {
    const f = await seed({ resultJson: { executionCancellation: { state: "acknowledged" } } });
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    await once(child, "spawn");
    try {
      await db.update(heartbeatRuns).set({ processGroupId: child.pid! }).where(eq(heartbeatRuns.id, f.runId));
      expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    } finally {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
  });

  it("does not retire an expired native finalizer until both the execution and controller have stop proof", async () => {
    const f = await seed({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Finalizer owner" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.runId));
    const startedAt = await readProcessStartedAt(process.pid);
    expect(startedAt).not.toBeNull();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: issue.id, runId: f.runId,
      phase: "observed", attempt: 1, controllerGeneration: 1, leaseOwner: "old-controller",
      leaseExpiresAt: new Date(0), controllerPid: process.pid, controllerProcessStartedAt: new Date(startedAt!),
    });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await db.update(nativeRunFinalizations).set({ controllerProcessStartedAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect((await db.select().from(nativeRunFinalizations))[0].leaseOwner).toBe("old-controller");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
    const [exitCode] = await once(child, "close");
    expect(exitCode).toBe(0);
    expect(child.pid).toBeTypeOf("number");
    const [stoppedRun] = await db.update(heartbeatRuns).set({ processPid: child.pid!, processGroupId: child.pid! })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    expect(await recordNativeLocalProcessStop(db, stoppedRun)).toBe(true);
    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect((await db.select().from(nativeRunFinalizations))[0].leaseOwner).toBe("old-controller");
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    expect((await db.select().from(nativeRunFinalizations))[0]).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      eventType: "native.process_start_requested", stream: "system", level: "info" });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("accepts a never-claimed native startup only while no launch contradicts its settled preparation receipt", async () => {
    const f = await seed({ runtimeMode: "native", resultJson: { startupPreparationSettledAt: new Date().toISOString() } });
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Never dispatched" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: issue.id, runId: f.runId,
      phase: "observed", attempt: 0, controllerGeneration: 0 });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      eventType: "native.process_start_requested", stream: "system", level: "info" });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("examines the end of large history without transferring historical payloads", async () => {
    const f = await seed({ status: "succeeded" });
    const padding = "unrelated historical payload ".repeat(512);
    await db.insert(heartbeatRuns).values(Array.from({ length: 513 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "legacy",
      resultJson: { padding }, contextSnapshot: { padding }, runnerProfileJson: { padding },
      stdoutExcerpt: padding, stderrExcerpt: padding,
    })));
    const unresolvedId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await db.insert(heartbeatRuns).values({ id: unresolvedId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:01:00Z"), resultJson: { padding },
    });
    recording = true;
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(transferredBytes.length).toBeGreaterThan(0);
    expect(Math.max(...transferredBytes)).toBeLessThan(8_192);
    expect(transferredBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(1_000_000);
    recording = false;
    await db.update(heartbeatRuns).set({ resultJson: { padding, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, unresolvedId));
    transferredBytes = [];
    recording = true;
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    expect(Math.max(...transferredBytes)).toBeLessThan(8_192);
    expect(transferredBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(1_000_000);
  });
});
