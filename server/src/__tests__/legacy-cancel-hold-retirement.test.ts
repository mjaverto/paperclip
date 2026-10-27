import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  LEGACY_RECOVERY_CAUSE, legacyExecutionNeedsReconciliationWithEvidence, settleCancelledLegacyBeforeDispatch,
  terminalizeLegacyExecution,
} from "../services/legacy-execution-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "../services/workspace-restore-recovery-state.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";

// Reassigning a task cancels its active omp_local run before the assignee
// changes. That run's cancellation fence is committed but no child process was
// ever terminated, so the stop is never acknowledged and the run is classified
// as an unreconciled legacy execution. These tests pin when that cancel-time
// hold may be retired by the exact executor, and that nothing else can.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy cancellation hold retirement", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-cancel-hold-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  const requestedAt = new Date().toISOString();
  const fence = { cancellation: { requestedAt, reason: "Cancelled for task reassignment" },
    startupCancellation: { requestedAt, errorCode: "issue_reassigned", beforeNativeSelection: false },
    executionCancellation: { state: "requested", requestedAt } };

  interface HoldFixture {
    companyId: string; agentId: string; issueId: string; runId: string;
    run: () => Promise<typeof heartbeatRuns.$inferSelect>;
    actions: () => Promise<Array<typeof issueRecoveryActions.$inferSelect>>;
  }

  /** Cancel a never-dispatched legacy run the way the reassign route does: the
   * hold is created at cancel time, then the executor's finally would retire it. */
  async function cancelled(options: { receipt?: boolean; fence?: boolean } = {}): Promise<HoldFixture> {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "omp", status: "idle", adapterType: "omp_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned", status: "in_progress", assigneeAgentId: agentId });
    const [running] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy",
      executionStage: "preparing", startedAt: new Date(), contextSnapshot: { issueId },
      resultJson: options.fence === false ? {} : fence }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const terminal = await terminalizeLegacyExecution({ db, run: running, status: "cancelled", fromStatuses: ["running"], reconcileIfNeeded: true,
      patch: { finishedAt: new Date(), errorCode: "issue_reassigned", error: "Cancelled for task reassignment",
        resultJson: options.fence === false ? {} : fence } });
    expect(terminal?.status).toBe("cancelled");
    if (options.receipt !== false) await db.update(heartbeatRuns).set({
      resultJson: { ...terminal!.resultJson, startupPreparationSettledAt: new Date().toISOString() },
    }).where(eq(heartbeatRuns.id, runId));
    const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const f = { companyId, agentId, issueId, runId, run, actions };
    expect(await actions()).toMatchObject([{ cause: LEGACY_RECOVERY_CAUSE, status: "active", fingerprint: `legacy-execution:${runId}` }]);
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId });
    return f;
  }
  const retire = async (f: HoldFixture, providerDispatchStarted = false) =>
    settleCancelledLegacyBeforeDispatch(db, { run: await f.run(), providerDispatchStarted });

  it("retires the hold of a cancelled run whose executor unwound before any dispatch", async () => {
    const f = await cancelled();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "local",
      status: "released", releasedAt: new Date() });
    const settled = await retire(f);
    expect(settled?.resultJson?.executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await f.actions()).toMatchObject([{ status: "resolved", outcome: "false_positive" }]);
    // The verdict is on the run itself, so later sweeps never recreate a hold.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, await f.run())).toBe(false);
    await terminalizeLegacyExecution({ db, run: await f.run(), status: "cancelled", fromStatuses: ["cancelled"], reconcileIfNeeded: true });
    expect(await f.actions()).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("retires an automatically resolved no-replay disposition and re-allows replay", async () => {
    const f = await cancelled();
    await settleUnrecoverableExecutions(db);
    expect(await f.actions()).toMatchObject([{ status: "resolved", outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } } }]);
    expect(await retire(f)).not.toBeNull();
    expect(await f.actions()).toMatchObject([{ status: "resolved", outcome: "false_positive",
      evidence: { automaticRecovery: { replay: "allowed" } } }]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  const negatives: Array<[string, (f: HoldFixture) => Promise<void>]> = [
    ["a dispatch gate hand-off", async f => { await db.update(heartbeatRuns).set({ usageJson: { budgetDispatch: {
      reservationId: randomUUID(), admittedAt: requestedAt, handedOffAt: requestedAt } } }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a recorded process id", async f => { await db.update(heartbeatRuns).set({ processPid: 4242 }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a recorded process group", async f => { await db.update(heartbeatRuns).set({ processGroupId: 4242 }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a recorded process start", async f => { await db.update(heartbeatRuns).set({ processStartedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a provider session", async f => { await db.update(heartbeatRuns).set({ sessionIdAfter: "session-1" }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["an adapter invoke event", async f => { await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId,
      agentId: f.agentId, seq: 1000, eventType: "adapter.invoke" }); }],
    ["a provider-sourced event", async f => { await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId,
      agentId: f.agentId, seq: 1000, eventType: "log", sourceEventId: "provider-event-1" }); }],
    ["an unreleased environment lease", async f => { await db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: f.runId, provider: "local" }); }],
    ["a failed lease cleanup", async f => { await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "local", status: "released", releasedAt: new Date(), cleanupStatus: "failed" }); }],
    ["a remote lease without a termination receipt", async f => { await db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: f.runId, provider: "sandbox", status: "released", releasedAt: new Date() }); }],
    ["an unrestored workspace", async f => { await db.update(heartbeatRuns).set({ resultJson: { ...(await f.run()).resultJson,
      workspaceRestoreFailure: "restore_unsafe_archive" } }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a native finalization row", async f => {
      await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, phase: "running" }); }],
    ["required workspace recovery on the run", async f => { await db.update(heartbeatRuns).set({ resultJson: { ...(await f.run()).resultJson,
      workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA } } }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a workspace restore failure recorded on the hold", async f => { const [action] = await f.actions();
      await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, workspaceRestoreFailure: "restore_unsafe_archive" } })
        .where(eq(issueRecoveryActions.id, action.id)); }],
    ["an exhausted retry budget", async f => { await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 2 }).where(eq(heartbeatRuns.id, f.runId)); }],
    ["a board reconciliation decision", async f => { const [action] = await f.actions();
      await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, executionReconciliation: { runId: f.runId } } })
        .where(eq(issueRecoveryActions.id, action.id)); }],
  ];
  it.each(negatives)("keeps the hold when there is %s", async (_label, mutate) => {
    const f = await cancelled();
    await mutate(f);
    expect(await retire(f)).toBeNull();
    expect(await f.actions()).toMatchObject([{ cause: LEGACY_RECOVERY_CAUSE }]);
    expect((await f.actions())[0].outcome).not.toBe("false_positive");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps the hold without the exact executor's unwind receipt (a restart loses it)", async () => {
    const f = await cancelled({ receipt: false });
    expect(await retire(f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps the hold when the executor reports that dispatch began", async () => {
    const f = await cancelled();
    expect(await retire(f, true)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps the hold when no cancellation fence was ever committed", async () => {
    const f = await cancelled({ fence: false });
    expect(await retire(f)).toBeNull();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("keeps the hold unless the run is a cancelled legacy run", async () => {
    const native = await cancelled();
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, native.runId));
    expect(await retire(native)).toBeNull();
    const failed = await cancelled();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, failed.runId));
    expect(await retire(failed)).toBeNull();
    expect(await getExecutionBlocker(db, failed.companyId, failed.issueId)).not.toBeNull();
  });

  it("does not retire another run's hold", async () => {
    const f = await cancelled(), other = await cancelled();
    expect(await retire(f)).not.toBeNull();
    expect(await other.actions()).toMatchObject([{ status: "active" }]);
    expect(await getExecutionBlocker(db, other.companyId, other.issueId)).not.toBeNull();
  });

  describe("terminalizeLegacyExecution idempotency per run", () => {
    it.each([
      // The automatic disposition keeps replay blocked, so the one action still blocks.
      ["an automatic no-replay disposition", true, async () => { await settleUnrecoverableExecutions(db); }],
      ["a board false-positive verdict", false, async (f: HoldFixture) => {
        await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive", resolvedAt: new Date() })
          .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)); }],
    ])("does not insert a second action once the first has %s", async (_label, stillBlocked, resolve) => {
      const f = await cancelled();
      await resolve(f);
      const [first] = await f.actions();
      expect(first.status).toBe("resolved");
      // No run-level verdict exists, so the classifier still wants a hold: only the action-level guard stops it.
      expect(await legacyExecutionNeedsReconciliationWithEvidence(db, await f.run())).toBe(true);
      await terminalizeLegacyExecution({ db, run: await f.run(), status: "cancelled", fromStatuses: ["cancelled"], reconcileIfNeeded: true });
      await terminalizeLegacyExecution({ db, run: await f.run(), status: "cancelled", fromStatuses: ["cancelled"], reconcileIfNeeded: true });
      expect(await f.actions()).toMatchObject([{ id: first.id, status: "resolved" }]);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId) !== null).toBe(stillBlocked);
    });

    it("serializes concurrent calls into a single action for the run", async () => {
      const f = await cancelled();
      await settleUnrecoverableExecutions(db);
      await Promise.all([1, 2, 3].map(async () => terminalizeLegacyExecution({ db, run: await f.run(), status: "cancelled",
        fromStatuses: ["cancelled"], reconcileIfNeeded: true })));
      expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `legacy-execution:${f.runId}`)))).toHaveLength(1);
    });
  });
});
