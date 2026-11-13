import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { readProcessStartedAt } from "../services/hot-restart.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

const TERMINAL_RUNS = 8;
const BLOB = "x".repeat(2 * 1024 * 1024);
const HEAVY_COLUMNS = ["resultJson", "contextSnapshot", "runnerProfileJson"] as const;
interface Fixture { company: { id: string }; agent: { id: string } }
const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";

/**
 * Counts result rows that carry a heavy run column, whatever query shape read
 * them (full select, widened projection, reload-all-then-find). Chain methods
 * and transactions are re-wrapped so nested queries are measured as well.
 */
function withHeavyRowCounter(db: Db) {
  const counter = { heavyRows: 0 };
  const isHeavyRow = (row: unknown) => typeof row === "object" && row !== null &&
    HEAVY_COLUMNS.some(column => column in row);
  // Builder methods return `this` or a fresh builder (`from`); wrap both so every later link stays measured.
  const isBuilder = (value: unknown): value is object => typeof value === "object" && value !== null &&
    (typeof (value as { then?: unknown }).then === "function" || typeof (value as { from?: unknown }).from === "function");
  const wrapBuilder = (builder: object): object => {
    const wrapped: object = new Proxy(builder, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property === "then") {
          return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            (member as PromiseLike<unknown>["then"]).call(target, (rows: unknown) => {
              if (Array.isArray(rows)) counter.heavyRows += rows.filter(isHeavyRow).length;
              return rows;
            }).then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          const result = (member as (...a: unknown[]) => unknown).apply(target, args);
          return result === target ? wrapped : isBuilder(result) ? wrapBuilder(result) : result;
        };
      },
    });
    return wrapped;
  };
  const wrapDb = (target: Db): Db => new Proxy(target, {
    get(inner, property) {
      const member = Reflect.get(inner, property, inner);
      if (typeof member !== "function") return member;
      if (property === "select" || property === "selectDistinct" || property === "selectDistinctOn") {
        return (...args: unknown[]) => wrapBuilder((member as (...a: unknown[]) => object).apply(inner, args));
      }
      if (property === "transaction") {
        return (callback: (tx: Db) => unknown, ...rest: unknown[]) =>
          (member as (...a: unknown[]) => unknown).call(inner, (tx: Db) => callback(wrapDb(tx)), ...rest);
      }
      return member.bind(inner);
    },
  });
  return { db: wrapDb(db), counter };
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

  /** `heavyRows` is how many run rows carrying result/context/runner-profile JSON the check read back. */
  async function check(f: Fixture) {
    const spied = withHeavyRowCounter(db);
    const stopped = await agentExecutionsHaveStopped(spied.db, [f.agent.id]);
    return { stopped, heavyRows: spied.counter.heavyRows };
  }

  it("reports an agent whose runs are all terminal as stopped without reading any heavy run row", async () => {
    const f = await fixture();
    expect(await check(f)).toEqual({ stopped: true, heavyRows: 0 });
  });

  it("is not stopped while a run is still running", async () => {
    const f = await fixture();
    await addRun(f, { status: "running", finishedAt: null });
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 0 });
  });

  it("is not stopped while a terminal run holds a future controller lease", async () => {
    const f = await fixture();
    await addRun(f, { status: "failed", controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 0 });
  });

  it("is not stopped while a terminal run's recorded process is alive", async () => {
    const f = await fixture();
    const startedAt = await readProcessStartedAt(process.pid).catch(() => null);
    await addRun(f, { status: "failed", processPid: process.pid, processGroupId: null,
      processStartedAt: startedAt ? new Date(startedAt) : null });
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 0 });
  });

  it("holds a cancelled legacy run that used a conversation adapter until its cancellation is acknowledged", async () => {
    const f = await fixture();
    const run = await addRun(f, { resultJson: { blob: BLOB }, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } });
    // Exactly the one candidate run is read in full, however many terminal runs the agent has.
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 1 });
    await db.update(heartbeatRuns).set({ resultJson: { blob: BLOB, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await check(f)).toEqual({ stopped: true, heavyRows: 0 });
  });

  it("still holds a conversation-adapter run whose cancellation is requested but not acknowledged", async () => {
    const f = await fixture();
    await addRun(f, { resultJson: { blob: BLOB, executionCancellation: { state: "requested" } },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } });
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 1 });
  });

  it("accepts a settled cancelled legacy run that never used a conversation adapter", async () => {
    const f = await fixture();
    await addRun(f, { resultJson: { blob: BLOB }, runnerProfileJson: { adapterDispatch: { adapterType: "http" } } });
    expect(await check(f)).toEqual({ stopped: true, heavyRows: 1 });
  });

  it("holds a cancelled native run without process identity or stop receipt, and accepts it once stopped", async () => {
    const f = await fixture();
    const run = await addRun(f, { runtimeMode: "native", resultJson: { blob: BLOB } });
    expect(await check(f)).toEqual({ stopped: false, heavyRows: 1 });
    await db.insert(heartbeatRunEvents).values({ companyId: f.company.id, agentId: f.agent.id, runId: run.id,
      seq: 1, eventType: LOCAL_PROCESS_STOPPED });
    expect(await check(f)).toEqual({ stopped: true, heavyRows: 0 });
  });

  it("accepts a cancelled native startup that never claimed a runner, judged on the hydrated row", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Never claimed" }).returning();
    const run = await addRun(f, { runtimeMode: "native", executionStage: null, nativeIssueId: issue.id,
      resultJson: { blob: BLOB, startupPreparationSettledAt: "2000-01-01T00:00:01.000Z" } });
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: run.id, issueId: issue.id, phase: "observed" });
    // isCancelledNativeStartup reads resultJson; a column-limited row would wrongly hold the pause.
    expect(await check(f)).toEqual({ stopped: true, heavyRows: 1 });
  });
});
