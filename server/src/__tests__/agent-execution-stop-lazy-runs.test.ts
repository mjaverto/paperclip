import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { readProcessStartedAt } from "../services/hot-restart.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

const TERMINAL_RUNS = 8;
const BLOB = "x".repeat(2 * 1024 * 1024);
interface Fixture { company: { id: string }; agent: { id: string } }
const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";

/** Counts `select().from(heartbeat_runs)` calls that read every column. */
function withFullRunSelectCounter(db: Db) {
  const counter = { fullRunSelects: 0 };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select") return typeof value === "function" ? value.bind(target) : value;
      return (...selectArgs: unknown[]) => {
        const builder = (value as (...args: unknown[]) => { from: (table: unknown) => unknown }).call(target, ...selectArgs);
        return new Proxy(builder, {
          get(builderTarget, builderProperty) {
            const member = Reflect.get(builderTarget, builderProperty, builderTarget);
            if (builderProperty !== "from") return typeof member === "function" ? member.bind(builderTarget) : member;
            return (table: unknown) => {
              if (table === heartbeatRuns && selectArgs.length === 0) counter.fullRunSelects += 1;
              return (member as (table: unknown) => unknown).call(builderTarget, table);
            };
          },
        });
      };
    },
  }) as Db;
  return { db: proxy, counter };
}

(support.supported ? describe : describe.skip)("agent execution stop check loads heavy run columns lazily", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-stop-lazy-runs-"); db = createDb(database.connectionString); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });

  async function fixture(): Promise<Fixture> {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Lazy runs", issuePrefix: `L${id.slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Heavy history agent",
      adapterType: "paperclip_runner", status: "idle", lifecycleState: "ready" }).returning();
    const statuses = ["succeeded", "failed", "timed_out", "interrupted"];
    await db.insert(heartbeatRuns).values(Array.from({ length: TERMINAL_RUNS }, (_, index) => ({
      companyId: company.id, agentId: agent.id, status: statuses[index % statuses.length], invocationSource: "on_demand",
      runtimeMode: "legacy", startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      resultJson: { blob: BLOB, index }, contextSnapshot: { blob: BLOB, index },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" }, blob: BLOB },
    })));
    return { company, agent };
  }

  async function addRun(f: Fixture, values: Partial<typeof heartbeatRuns.$inferInsert>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "legacy", executionStage: "settled",
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      contextSnapshot: { blob: BLOB }, ...values }).returning({ id: heartbeatRuns.id });
    return run;
  }

  async function check(f: Fixture) {
    const spied = withFullRunSelectCounter(db);
    const stopped = await agentExecutionsHaveStopped(spied.db, [f.agent.id]);
    return { stopped, fullRunSelects: spied.counter.fullRunSelects };
  }

  it("reports an agent whose runs are all terminal as stopped without reading any full run row", async () => {
    const f = await fixture();
    expect(await check(f)).toEqual({ stopped: true, fullRunSelects: 0 });
  });

  it("is not stopped while a run is still running", async () => {
    const f = await fixture();
    await addRun(f, { status: "running", finishedAt: null });
    expect(await check(f)).toEqual({ stopped: false, fullRunSelects: 0 });
  });

  it("is not stopped while a terminal run holds a future controller lease", async () => {
    const f = await fixture();
    await addRun(f, { status: "failed", controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await check(f)).toEqual({ stopped: false, fullRunSelects: 0 });
  });

  it("is not stopped while a terminal run's recorded process is alive", async () => {
    const f = await fixture();
    const startedAt = await readProcessStartedAt(process.pid).catch(() => null);
    await addRun(f, { status: "failed", processPid: process.pid, processGroupId: null,
      processStartedAt: startedAt ? new Date(startedAt) : null });
    expect(await check(f)).toEqual({ stopped: false, fullRunSelects: 0 });
  });

  it("holds a cancelled legacy run that used a conversation adapter until its cancellation is acknowledged", async () => {
    const f = await fixture();
    const run = await addRun(f, { resultJson: { blob: BLOB }, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } });
    // Only the one candidate run is read in full, however many terminal runs the agent has.
    expect(await check(f)).toEqual({ stopped: false, fullRunSelects: 1 });
    await db.update(heartbeatRuns).set({ resultJson: { blob: BLOB, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await check(f)).toEqual({ stopped: true, fullRunSelects: 0 });
  });

  it("accepts a settled cancelled legacy run that never used a conversation adapter", async () => {
    const f = await fixture();
    await addRun(f, { resultJson: { blob: BLOB }, runnerProfileJson: { adapterDispatch: { adapterType: "http" } } });
    expect(await check(f)).toEqual({ stopped: true, fullRunSelects: 1 });
  });

  it("holds a cancelled native run without process identity or stop receipt, and accepts it once stopped", async () => {
    const f = await fixture();
    const run = await addRun(f, { runtimeMode: "native", resultJson: { blob: BLOB } });
    expect(await check(f)).toEqual({ stopped: false, fullRunSelects: 1 });
    await db.insert(heartbeatRunEvents).values({ companyId: f.company.id, agentId: f.agent.id, runId: run.id,
      seq: 1, eventType: LOCAL_PROCESS_STOPPED });
    expect(await check(f)).toEqual({ stopped: true, fullRunSelects: 0 });
  });
});
