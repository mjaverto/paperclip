import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat run stats routes", { concurrent: false }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-stats-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, status = "idle") {
    const id = randomUUID();
    await db.insert(agents).values({
      id, companyId, name, role: "engineer", status, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return id;
  }

  async function seedRun(companyId: string, agentId: string, status: string, createdAt = new Date()) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, scopeKind: "company", issueId: null, invocationSource: "timer", status, createdAt, contextSnapshot: {},
    });
    return id;
  }

  function createApp(companyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId, companyId, source: "agent_jwt" };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("serves stats and latest-failed for the actor's own company", async () => {
    const companyId = await seedCompany("RSA");
    const caller = await seedAgent(companyId, "Caller");
    const failing = await seedAgent(companyId, "Failing");
    await seedRun(companyId, caller, "succeeded");
    const failedRunId = await seedRun(companyId, failing, "failed");
    const app = createApp(companyId, caller);

    const stats = await request(app).get(`/api/companies/${companyId}/heartbeat-runs/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "succeeded", count: 1 }),
      expect.objectContaining({ status: "failed", count: 1 }),
    ]));

    const failed = await request(app).get(`/api/companies/${companyId}/heartbeat-runs/latest-failed`);
    expect(failed.status).toBe(200);
    expect(failed.body.map((run: { id: string }) => run.id)).toEqual([failedRunId]);
  });

  it("excludes terminated agents and agents whose newest run succeeded from latest-failed", async () => {
    const companyId = await seedCompany("RSB");
    const caller = await seedAgent(companyId, "Caller");
    const terminated = await seedAgent(companyId, "Gone", "terminated");
    const recovered = await seedAgent(companyId, "Recovered");
    await seedRun(companyId, terminated, "failed");
    await seedRun(companyId, recovered, "failed", new Date(Date.now() - 60_000));
    await seedRun(companyId, recovered, "succeeded");
    const live = await seedRun(companyId, caller, "timed_out");

    const response = await request(createApp(companyId, caller)).get(`/api/companies/${companyId}/heartbeat-runs/latest-failed`);
    expect(response.status).toBe(200);
    expect(response.body.map((run: { id: string }) => run.id)).toEqual([live]);
  });

  it("refuses another company's data with 403 on every run route", async () => {
    const companyId = await seedCompany("RSC");
    const otherCompanyId = await seedCompany("RSD");
    const caller = await seedAgent(companyId, "Caller");
    const outsider = await seedAgent(otherCompanyId, "Outsider");
    await seedRun(otherCompanyId, outsider, "failed");
    const app = createApp(companyId, caller);

    for (const path of ["heartbeat-runs", "heartbeat-runs/stats", "heartbeat-runs/latest-failed"]) {
      const response = await request(app).get(`/api/companies/${otherCompanyId}/${path}`);
      expect(response.status, path).toBe(403);
    }
  });

  it("rejects a malformed agentId or offset with 400 and accepts the boundary values", async () => {
    const companyId = await seedCompany("RSE");
    const caller = await seedAgent(companyId, "Caller");
    const app = createApp(companyId, caller);
    const base = `/api/companies/${companyId}/heartbeat-runs`;

    for (const query of ["agentId=not-a-uuid", "agentId="]) {
      expect((await request(app).get(`${base}?${query}`)).status, query).toBe(400);
      expect((await request(app).get(`${base}/stats?${query}`)).status, query).toBe(400);
    }
    for (const offset of ["-1", "abc", "1.5", "100001"]) {
      expect((await request(app).get(`${base}?offset=${offset}`)).status, offset).toBe(400);
    }
    expect((await request(app).get(`${base}?offset=0&agentId=${caller}`)).status).toBe(200);
    expect((await request(app).get(`${base}?offset=100000`)).status).toBe(200);
    expect((await request(app).get(`${base}/stats?agentId=${caller}`)).status).toBe(200);
  });
});
