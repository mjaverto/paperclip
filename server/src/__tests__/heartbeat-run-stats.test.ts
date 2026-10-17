import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run stats tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;

describeEmbeddedPostgres("heartbeat run stats, latest-failed and paging", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-stats-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string, createdAt: Date) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status,
      createdAt,
      contextSnapshot: {},
    });
    return id;
  }

  const utcDay = (date: Date) => date.toISOString().slice(0, 10);

  it("groups the trailing 14 UTC days by day and status, scoped to the company and optional agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentA = await seedAgent(companyId, "A");
    const agentB = await seedAgent(companyId, "B");
    const outsider = await seedAgent(otherCompanyId, "Outsider");
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * HOUR_MS);
    await seedRun(companyId, agentA, "succeeded", today);
    await seedRun(companyId, agentA, "succeeded", today);
    await seedRun(companyId, agentA, "failed", yesterday);
    await seedRun(companyId, agentB, "failed", yesterday);
    await seedRun(companyId, agentB, "timed_out", today);
    await seedRun(companyId, agentA, "succeeded", new Date(today.getTime() - 20 * 24 * HOUR_MS));
    await seedRun(otherCompanyId, outsider, "succeeded", today);

    const all = await heartbeat.stats(companyId);
    expect(all).toEqual(
      expect.arrayContaining([
        { date: utcDay(yesterday), status: "failed", count: 2 },
        { date: utcDay(today), status: "succeeded", count: 2 },
        { date: utcDay(today), status: "timed_out", count: 1 },
      ]),
    );
    expect(all).toHaveLength(3);

    expect(await heartbeat.stats(companyId, agentA)).toEqual(
      expect.arrayContaining([
        { date: utcDay(yesterday), status: "failed", count: 1 },
        { date: utcDay(today), status: "succeeded", count: 2 },
      ]),
    );
    expect(await heartbeat.stats(companyId, agentA)).toHaveLength(2);
  });

  it("returns only agents whose newest run failed or timed out", async () => {
    const companyId = await seedCompany();
    const recovered = await seedAgent(companyId, "Recovered");
    const failing = await seedAgent(companyId, "Failing");
    const timedOut = await seedAgent(companyId, "TimedOut");
    const healthy = await seedAgent(companyId, "Healthy");
    const now = Date.now();
    await seedRun(companyId, recovered, "failed", new Date(now - 3 * HOUR_MS));
    await seedRun(companyId, recovered, "succeeded", new Date(now - 2 * HOUR_MS));
    await seedRun(companyId, failing, "succeeded", new Date(now - 3 * HOUR_MS));
    const failingLatest = await seedRun(companyId, failing, "failed", new Date(now - 2 * HOUR_MS));
    const timedOutLatest = await seedRun(companyId, timedOut, "timed_out", new Date(now - HOUR_MS));
    await seedRun(companyId, healthy, "succeeded", new Date(now - HOUR_MS));
    const otherCompanyId = await seedCompany();
    const outsider = await seedAgent(otherCompanyId, "Outsider");
    await seedRun(otherCompanyId, outsider, "failed", new Date(now));

    const runs = await heartbeat.latestFailed(companyId);
    expect(runs.map((run) => run.id).sort()).toEqual([failingLatest, timedOutLatest].sort());
    expect(runs.find((run) => run.id === failingLatest)).toMatchObject({ agentId: failing, status: "failed", companyId });
  });

  it("returns an empty list when no agent's newest run failed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Healthy");
    await seedRun(companyId, agentId, "succeeded", new Date());
    expect(await heartbeat.latestFailed(companyId)).toEqual([]);
  });

  it("pages the run list newest-first with offset", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Pager");
    const base = Date.now() - 10 * HOUR_MS;
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await seedRun(companyId, agentId, "succeeded", new Date(base + index * HOUR_MS)));
    }
    const newestFirst = [...ids].reverse();
    const first = await heartbeat.list(companyId, agentId, 2, { summary: true });
    const second = await heartbeat.list(companyId, agentId, 2, { summary: true, offset: 2 });
    const third = await heartbeat.list(companyId, agentId, 2, { summary: true, offset: 4 });
    expect(first.map((run) => run.id)).toEqual(newestFirst.slice(0, 2));
    expect(second.map((run) => run.id)).toEqual(newestFirst.slice(2, 4));
    expect(third.map((run) => run.id)).toEqual(newestFirst.slice(4));
  });
});
