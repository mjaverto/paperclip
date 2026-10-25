import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases,
  heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, type Db,
} from "@paperclipai/db";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { reconcileArchivedCompanyExecutions, type ArchivedLocalExecutionRetirementEvidence } from "../services/legacy-execution-recovery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("archived historical execution reconciliation", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: Db;
  const actorId = "archived-stop-regression-operator";
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-archived-legacy-recovery-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Archived historical executor", status: "archived", issuePrefix: `LR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Terminating engineer", adapterType: "process",
      status: "terminated", lifecycleState: "terminating" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:01:00Z"), exitCode: 0, nextEventSeq: 3,
      resultJson: { stopReason: "cancelled", summary: "Historical summary", conversationContinuation: "continue_conversation_v1" },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    }).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "adapter.invoke", stream: "system",
      createdAt: new Date("2026-01-01T00:00:30Z"), payload: { adapterType: "claude_local", command: "/usr/local/bin/claude" },
    });
    const [terminal] = await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 2, eventType: "lifecycle", stream: "system",
      createdAt: new Date("2026-01-01T00:01:01Z"), message: "run cancelled", payload: { status: "cancelled", exitCode: 0 },
    }).returning();
    return { companyId, agentId, runId, run, terminal, input: { companyIds: [companyId], runIds: [runId], actorId } };
  }

  it("defaults to a read-only plan and releases stop only through an exact audited adapter-close receipt", async () => {
    const f = await seed();
    const operation = { id: randomUUID(), hostComplete: false, completedPluginIds: [randomUUID()], attempts: 17,
      retryAt: new Date(Date.now() + 60_000).toISOString(), leaseOwner: "existing-stop-worker",
      leaseUntil: new Date(Date.now() + 120_000).toISOString() };
    const [agentBefore] = await db.update(agents).set({ lifecycleVersion: 7, lifecycleOperation: operation,
      lifecycleError: "Preserve the previous stop error" }).where(eq(agents.id, f.agentId)).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Unresolved historical outcome" }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issue.id,
      kind: "execution_reconciliation", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      ownerType: "board", nextAction: "Inspect the action outcome", evidence: { runId: f.runId },
    }).returning();
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    const [plan] = await reconcileArchivedCompanyExecutions(db, f.input);
    expect(plan).toMatchObject({ runId: f.runId, companyId: f.companyId, state: "eligible",
      proof: { kind: "legacy_adapter_exit_receipt" } });
    expect(plan.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual([f.run]);
    expect(await db.select().from(activityLog)).toEqual([]);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]).toEqual(agentBefore);
    await expect(reconcileArchivedCompanyExecutions(db, { ...f.input, apply: true })).rejects.toThrow("evidence hash");
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);

    expect(await reconcileArchivedCompanyExecutions(db, { ...f.input, apply: true,
      expectedEvidence: { [f.runId]: plan.evidenceSha256! },
    })).toMatchObject([{ runId: f.runId, state: "reconciled", evidenceSha256: plan.evidenceSha256 }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    const { retryAt, ...retainedOperation } = agentBefore.lifecycleOperation!;
    expect(retryAt).toBe(operation.retryAt);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0])
      .toEqual({ ...agentBefore, lifecycleOperation: retainedOperation });
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(after).toMatchObject({ status: "cancelled", startedAt: f.run.startedAt, finishedAt: f.run.finishedAt,
      resultJson: { ...f.run.resultJson, executionCancellation: { state: "acknowledged", proof: "legacy_adapter_exit_receipt",
        reconciliation: { actorId, evidenceSha256: plan.evidenceSha256, actionOutcomes: "not_reconciled", replay: "not_authorized" },
      } },
    });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id))).toEqual([action]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)))
      .toMatchObject([{ actorId, action: "heartbeat_run.archived_legacy_stop_reconciled", entityId: f.runId, runId: f.runId,
        details: { evidenceSha256: plan.evidenceSha256, actionOutcomes: "not_reconciled", replay: "not_authorized" } }]);
  });

  it("fails closed when a historical cancelled run has no finishedAt, even with a previously approved plan", async () => {
    const f = await seed();
    const [plan] = await reconcileArchivedCompanyExecutions(db, f.input);
    expect(plan.state).toBe("eligible");
    const [unfinished] = await db.update(heartbeatRuns).set({ finishedAt: null })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect(await reconcileArchivedCompanyExecutions(db, { ...f.input, apply: true,
      expectedEvidence: { [f.runId]: plan.evidenceSha256! },
    })).toMatchObject([{ state: "blocked" }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual([unfinished]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it.each(["missing_exit_key", "mismatched_exit", "before_finish"])("rejects %s instead of treating an operator cancellation as executor settlement", async invalid => {
    const f = await seed();
    await db.update(heartbeatRunEvents).set(invalid === "before_finish"
      ? { createdAt: new Date("2026-01-01T00:00:59Z") }
      : { payload: invalid === "missing_exit_key" ? { status: "cancelled" } : { status: "cancelled", exitCode: 9 } })
      .where(eq(heartbeatRunEvents.id, f.terminal.id));
    await db.update(heartbeatRuns).set({ resultJson: { providerStopped: true, operatorNote: "Assumed stopped" } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it.each(["daytona", null])("does not use a local adapter exit to retire %s provider authority", async provider => {
    const f = await seed();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      provider, providerLeaseId: randomUUID(), status: "released", releasedAt: new Date("2026-01-01T00:01:00Z"), cleanupStatus: "success" });
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson).toEqual(f.run.resultJson);
  });

  it("requires both the explicit company scope and a still-archived company", async () => {
    const f = await seed(), other = await seed();
    expect(await reconcileArchivedCompanyExecutions(db, { ...f.input, runIds: [other.runId] }))
      .toMatchObject([{ runId: other.runId, companyId: null, state: "blocked" }]);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.runId))).toEqual([other.run]);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("invalidates an approved plan when a concurrent historical-row write changes its evidence version", async () => {
    const f = await seed();
    const [plan] = await reconcileArchivedCompanyExecutions(db, f.input);
    expect(plan.state).toBe("eligible");
    await db.update(heartbeatRuns).set({ resultJson: { ...f.run.resultJson, summary: "A newer operator annotation" } })
      .where(eq(heartbeatRuns.id, f.runId));
    const [freshPlan] = await reconcileArchivedCompanyExecutions(db, f.input);
    expect(freshPlan.state).toBe("eligible");
    expect(freshPlan.evidenceSha256).not.toBe(plan.evidenceSha256);
    await expect(reconcileArchivedCompanyExecutions(db, { ...f.input, apply: true,
      expectedEvidence: { [f.runId]: plan.evidenceSha256! },
    })).rejects.toThrow("changed after dry-run");
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it.each(["active_run", "live_pid", "modern_controller"])("does not reconcile through %s authority", async authority => {
    const f = await seed();
    if (authority === "active_run") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    else await db.update(heartbeatRuns).set(authority === "live_pid" ? { processPid: process.pid } : { controllerBootId: randomUUID() })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
  });

  it("keeps scratch cleanup and a released local lease insufficient when the exit receipt was lost", async () => {
    const f = await seed(), scratchDir = `/tmp/historical-scratch-${f.runId}`;
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, f.terminal.id));
    await db.update(heartbeatRuns).set({ exitCode: null, contextSnapshot: { paperclipScratch: { dir: scratchDir } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "local",
      status: "released", cleanupStatus: "success", releasedAt: new Date("2026-01-01T00:01:01Z") });
    const [cleanup] = await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.runId,
      seq: 2, eventType: "lifecycle", stream: "system", message: "run scratch cleaned",
      createdAt: new Date("2026-01-01T00:01:02Z"), payload: { dir: `${scratchDir}-different`, removed: true },
    }).returning();
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    await db.update(heartbeatRunEvents).set({ payload: { dir: scratchDir, removed: true } }).where(eq(heartbeatRunEvents.id, cleanup.id));
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  function retirementEvidence(runId: string) {
    const record = `Verified retirement of the original execution namespace for historical run ${runId}.`;
    return {
      runId, executionHostIdentity: "regression-original-execution-host",
      executionBinding: record, kind: "execution_pid_namespace_retired",
      observedAt: "2026-01-02T00:01:00Z", retirementOrBootBoundary: "2026-01-02T00:00:00Z",
      verifier: actorId, sourceReference: `test-fixture://retired-executor/${runId}`,
      sourceSha256: createHash("sha256").update(record).digest("hex"),
    } satisfies ArchivedLocalExecutionRetirementEvidence;
  }

  it("uses exact reviewed original-host retirement evidence when a custom local executor has no canonical exit receipt", async () => {
    const f = await seed();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, f.terminal.id));
    await db.update(heartbeatRuns).set({ exitCode: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRunEvents).set({ payload: { adapterType: "claude_local", command: "/usr/local/bin/custom-claude-wrapper" } })
      .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.eventType, "adapter.invoke")));
    expect(await reconcileArchivedCompanyExecutions(db, f.input)).toMatchObject([{ state: "blocked" }]);
    const evidence = retirementEvidence(f.runId);
    const input = { ...f.input, retirementEvidence: [evidence] };
    const [plan] = await reconcileArchivedCompanyExecutions(db, input);
    expect(plan).toMatchObject({ state: "eligible", proof: { kind: "verified_local_execution_retirement", retirementEvidence: evidence } });
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    await expect(reconcileArchivedCompanyExecutions(db, { ...input, apply: true,
      retirementEvidence: [{ ...evidence, sourceSha256: createHash("sha256").update("different reviewed record").digest("hex") }],
      expectedEvidence: { [f.runId]: plan.evidenceSha256! },
    })).rejects.toThrow("changed after dry-run");
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
    expect(await reconcileArchivedCompanyExecutions(db, { ...input, apply: true,
      expectedEvidence: { [f.runId]: plan.evidenceSha256! },
    })).toMatchObject([{ state: "reconciled", proof: { kind: "verified_local_execution_retirement" } }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(true);
    expect((await db.select().from(activityLog).where(eq(activityLog.runId, f.runId)))[0].details)
      .toMatchObject({ proof: { retirementEvidence: evidence }, actionOutcomes: "not_reconciled", replay: "not_authorized" });
  });

  it.each(["before_execution_end", "observation_before_retirement", "future_observation"])("rejects retirement evidence with %s", async invalid => {
    const f = await seed();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, f.terminal.id));
    const evidence = retirementEvidence(f.runId);
    if (invalid === "before_execution_end") evidence.retirementOrBootBoundary = f.run.finishedAt!.toISOString();
    if (invalid === "observation_before_retirement") evidence.observedAt = "2026-01-01T23:59:59Z";
    if (invalid === "future_observation") evidence.observedAt = new Date(Date.now() + 60_000).toISOString();
    expect(await reconcileArchivedCompanyExecutions(db, { ...f.input, retirementEvidence: [evidence] }))
      .toMatchObject([{ state: "blocked" }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it.each(["unlisted_run", "duplicate_run", "missing_execution_binding"])("rejects %s operator retirement evidence instead of widening its scope", async invalid => {
    const f = await seed();
    const evidence = retirementEvidence(f.runId);
    if (invalid === "unlisted_run") evidence.runId = randomUUID();
    if (invalid === "missing_execution_binding") evidence.executionBinding = "";
    await expect(reconcileArchivedCompanyExecutions(db, { ...f.input,
      retirementEvidence: invalid === "duplicate_run" ? [evidence, evidence] : [evidence],
    })).rejects.toThrow();
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("never substitutes local host retirement for a remote provider stop", async () => {
    const f = await seed();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, f.terminal.id));
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "daytona", providerLeaseId: randomUUID(), status: "released",
      releasedAt: new Date("2026-01-01T00:01:01Z"), cleanupStatus: "success" });
    expect(await reconcileArchivedCompanyExecutions(db, { ...f.input, retirementEvidence: [retirementEvidence(f.runId)] }))
      .toMatchObject([{ state: "blocked" }]);
    expect(await agentExecutionsHaveStopped(db, [f.agentId])).toBe(false);
    expect(await db.select().from(activityLog)).toEqual([]);
  });
});
