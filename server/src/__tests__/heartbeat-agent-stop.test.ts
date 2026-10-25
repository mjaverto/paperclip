import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents, heartbeatRuns, type Db,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("heartbeat agent stop", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: Db;
  let recording = false;
  let transferredBytes: number[] = [];
  const ownedControls = new Set<string>();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-stop-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    db.$client.options.transform.value.from = value => {
      if (recording && value != null) {
        transferredBytes.push(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)));
      }
      return value;
    };
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    recording = false;
    transferredBytes = [];
    for (const runId of ownedControls) {
      adapterExecutionControls.get(runId)?.finish();
      adapterExecutionControls.delete(runId);
    }
    ownedControls.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Historical stop", status: "archived", issuePrefix: `HS${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retired engineer", adapterType: "codex_local",
      lifecycleState: "terminated", status: "terminated" });
    return { companyId, agentId };
  }

  it("keeps terminal cancelled history blocking until stop acknowledgement is durable", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ ...f, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: new Date("2026-01-01T00:01:00Z"),
    }).returning();
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Company cleanup")).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].resultJson)
      .toBeNull();
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Company cleanup")).toBe(true);
  });

  it("waits for the live adapter owner even when cancellation has already been acknowledged", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ ...f, status: "cancelled", startedAt: new Date(),
      finishedAt: new Date(), resultJson: { executionCancellation: { state: "acknowledged" } },
    }).returning();
    const control = createAdapterExecutionControl();
    ownedControls.add(run.id);
    adapterExecutionControls.set(run.id, control);
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Company cleanup")).toBe(false);
    control.finish();
    adapterExecutionControls.delete(run.id);
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Company cleanup")).toBe(true);
  });

  it("does not allow another company's unresolved execution to hold or be modified by a scoped stop", async () => {
    const target = await seed(), other = await seed();
    const [otherRun] = await db.insert(heartbeatRuns).values({ ...other, status: "cancelled",
      startedAt: new Date(), finishedAt: new Date(), resultJson: { operatorNote: "Keep this history" },
    }).returning();
    expect(await heartbeatService(db).stopInvocationsForAgents([target.agentId], "Remove target only")).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRun.id)))[0]).toEqual(otherRun);
  });

  it("checks later history pages without decoding the result, context, profile or output payloads", async () => {
    const f = await seed();
    const padding = "historical output not needed to stop ".repeat(512);
    await db.insert(heartbeatRuns).values(Array.from({ length: 513 }, (_, index) => ({
      ...f, id: `00000000-0000-4000-9000-${index.toString(16).padStart(12, "0")}`,
      status: "succeeded", runtimeMode: "legacy", resultJson: { padding }, contextSnapshot: { padding },
      runnerProfileJson: { padding }, stdoutExcerpt: padding, stderrExcerpt: padding,
    })));
    const runId = "ffffffff-ffff-4fff-afff-ffffffffffff";
    await db.insert(heartbeatRuns).values({ ...f, id: runId, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date("2026-01-01T00:00:00Z"), finishedAt: new Date("2026-01-01T00:01:00Z"),
      resultJson: { padding }, runnerProfileJson: { padding, adapterDispatch: { adapterType: "codex_local" } },
    });
    const heartbeat = heartbeatService(db);
    recording = true;
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Remove archived company")).toBe(false);
    expect(transferredBytes.length).toBeGreaterThan(0);
    expect(Math.max(...transferredBytes)).toBeLessThan(8_192);
    expect(transferredBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(1_000_000);
    recording = false;
    await db.update(heartbeatRuns).set({ resultJson: { padding, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, runId));
    transferredBytes = [];
    recording = true;
    expect(await heartbeat.stopInvocationsForAgents([f.agentId], "Remove archived company")).toBe(true);
    expect(Math.max(...transferredBytes)).toBeLessThan(8_192);
    expect(transferredBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(1_000_000);
  });
});
