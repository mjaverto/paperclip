import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

const STOP_PROOF_BATCH_SIZE = 256;
type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

// Ordinary terminal history is proved by its primitive ownership fields. Avoid
// even detoasting its JSON unless the cancelled execution needs receipt proof.
const needsReceiptProof = sql`${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is not null
  and coalesce(${heartbeatRuns.processPid}, 0) = 0 and coalesce(${heartbeatRuns.processGroupId}, 0) = 0
  and ${heartbeatRuns.runtimeMode} in ('legacy', 'native')`;
// Preserve strict JSON comparisons without returning sibling payloads.
const jsonString = (value: SQL) => sql<string | null>`case when ${needsReceiptProof}
  then case when jsonb_typeof(${value}) = 'string' then ${value} #>> '{}' end end`;
const proofBoolean = (value: SQL) => sql<boolean>`case when ${needsReceiptProof} then coalesce(${value}, false) else false end`;

const stopProofRunSelection = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  runtimeMode: heartbeatRuns.runtimeMode,
  runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt,
  executionStage: heartbeatRuns.executionStage,
  errorCode: heartbeatRuns.errorCode,
  processPid: heartbeatRuns.processPid,
  processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt,
  controllerBootId: heartbeatRuns.controllerBootId,
  controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  nativeSessionId: heartbeatRuns.nativeSessionId,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  resultWasNull: proofBoolean(sql`${heartbeatRuns.resultJson} is null or ${heartbeatRuns.resultJson} = 'null'::jsonb`),
  cancellationState: jsonString(sql`${heartbeatRuns.resultJson} #> '{executionCancellation,state}'`),
  beforeNativeSelection: proofBoolean(sql`${heartbeatRuns.resultJson} #> '{startupCancellation,beforeNativeSelection}' = 'true'::jsonb`),
  startupPreparationSettledAt: jsonString(sql`${heartbeatRuns.resultJson}->'startupPreparationSettledAt'`),
  workspaceRestoreFailure: jsonString(sql`${heartbeatRuns.resultJson}->'workspaceRestoreFailure'`),
  workspaceRecoverySchema: jsonString(sql`${heartbeatRuns.resultJson} #> '{workspaceRestoreRecovery,schema}'`),
  conversationContinuation: jsonString(sql`${heartbeatRuns.resultJson}->'conversationContinuation'`),
  stopReason: jsonString(sql`${heartbeatRuns.resultJson}->'stopReason'`),
  timeoutSource: jsonString(sql`${heartbeatRuns.resultJson}->'timeoutSource'`),
  responseWaitVersion: proofBoolean(sql`${heartbeatRuns.resultJson} #> '{preDispatchResponseWait,version}' = '1'::jsonb`),
  responseWaitNoProvider: proofBoolean(sql`${heartbeatRuns.resultJson} #> '{preDispatchResponseWait,providerWorkStarted}' = 'false'::jsonb`),
  adapterType: jsonString(sql`${heartbeatRuns.runnerProfileJson} #> '{adapterDispatch,adapterType}'`),
  connectionIntentResolution: jsonString(sql`${heartbeatRuns.contextSnapshot}->'connectionIntentResolution'`),
  source: jsonString(sql`${heartbeatRuns.contextSnapshot}->'source'`),
  interactionKind: jsonString(sql`${heartbeatRuns.contextSnapshot}->'interactionKind'`),
  interactionStatus: jsonString(sql`${heartbeatRuns.contextSnapshot}->'interactionStatus'`),
  mutation: jsonString(sql`${heartbeatRuns.contextSnapshot}->'mutation'`),
  interactionId: jsonString(sql`${heartbeatRuns.contextSnapshot}->'interactionId'`),
};

const stopProofCoordinatorSelection = {
  runId: nativeRunFinalizations.runId,
  phase: nativeRunFinalizations.phase,
  attempt: nativeRunFinalizations.attempt,
  controllerGeneration: nativeRunFinalizations.controllerGeneration,
  controllerBootId: nativeRunFinalizations.controllerBootId,
  controllerPid: nativeRunFinalizations.controllerPid,
  controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt,
  leaseOwner: nativeRunFinalizations.leaseOwner,
  leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
  resultId: nativeRunFinalizations.resultId,
  hasSuccessorRun: sql<boolean>`coalesce(${nativeRunFinalizations.failureDetail}->'successorRunId'
    not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)`,
};

/** Cancellation changes admission. Process and lease evidence controls cleanup.
 * Historical runs remain part of the proof, but only bounded scalar pages leave
 * Postgres; executor output and context siblings never enter the stop loop. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const [blockingLease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    or(inArray(environmentLeases.heartbeatRunId, runIds), inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds)),
    or(
      and(isNull(environmentLeases.releasedAt),
        sql`not coalesce(${environmentLeases.status} = 'retained' and ${environmentLeases.cleanupStatus} = 'success', false)`),
      eq(environmentLeases.status, "pending_cleanup"),
      eq(environmentLeases.cleanupStatus, "failed"),
    ),
  )).limit(1);
  if (blockingLease) return false;
  const now = new Date();
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  async function coordinatorHasStopped(coordinator: {
    leaseOwner: string | null; leaseExpiresAt: Date | null; resultId: string | null;
    controllerPid: number | null; controllerProcessStartedAt: Date | null;
  }, status: string) {
    if (!coordinator.leaseOwner) return true;
    if (!coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > now || coordinator.resultId || status !== "cancelled") return false;
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) return true;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    return Boolean(observed && coordinator.controllerProcessStartedAt &&
      new Date(observed).getTime() !== coordinator.controllerProcessStartedAt.getTime());
  }

  let cursor: string | undefined;
  for (;;) {
    const runs = await db.select(stopProofRunSelection).from(heartbeatRuns).where(and(
      inArray(heartbeatRuns.agentId, agentIds), cursor ? gt(heartbeatRuns.id, cursor) : undefined,
    )).orderBy(heartbeatRuns.id).limit(STOP_PROOF_BATCH_SIZE);
    if (!runs.length) break;
    const pageRunIds = runs.map(run => run.id);
    const coordinators = await db.select(stopProofCoordinatorSelection).from(nativeRunFinalizations)
      .where(inArray(nativeRunFinalizations.runId, pageRunIds));
    const coordinatorsByRun = new Map(coordinators.map(row => [row.runId, row]));
    const leaseProofs = new Map<string, { remote: boolean; receipts: boolean }>();
    let leaseCursor: string | undefined;
    for (;;) {
      const leases = await db.select({
        id: environmentLeases.id, companyId: environmentLeases.companyId,
        heartbeatRunId: environmentLeases.heartbeatRunId, provider: environmentLeases.provider,
        providerLeaseId: environmentLeases.providerLeaseId, releasedAt: environmentLeases.releasedAt,
        status: environmentLeases.status, cleanupStatus: environmentLeases.cleanupStatus,
        // The receipt alone is the helper's immutable lease-bound evidence.
        metadata: sql<Record<string, unknown>>`jsonb_build_object('remoteExecutionTermination',
          jsonb_build_object(
            'schema', ${environmentLeases.metadata} #> '{remoteExecutionTermination,schema}',
            'companyId', ${environmentLeases.metadata} #> '{remoteExecutionTermination,companyId}',
            'runId', ${environmentLeases.metadata} #> '{remoteExecutionTermination,runId}',
            'leaseId', ${environmentLeases.metadata} #> '{remoteExecutionTermination,leaseId}',
            'provider', ${environmentLeases.metadata} #> '{remoteExecutionTermination,provider}',
            'providerLeaseId', ${environmentLeases.metadata} #> '{remoteExecutionTermination,providerLeaseId}',
            'state', ${environmentLeases.metadata} #> '{remoteExecutionTermination,state}'))`,
      }).from(environmentLeases).where(and(
        inArray(environmentLeases.heartbeatRunId, pageRunIds),
        leaseCursor ? gt(environmentLeases.id, leaseCursor) : undefined,
      )).orderBy(environmentLeases.id).limit(STOP_PROOF_BATCH_SIZE);
      for (const lease of leases) {
        const proof = leaseProofs.get(lease.heartbeatRunId!) ?? { remote: false, receipts: true };
        proof.remote ||= Boolean(lease.provider && lease.provider !== "local");
        proof.receipts &&= hasRemoteTerminationReceipt(lease);
        leaseProofs.set(lease.heartbeatRunId!, proof);
      }
      if (leases.length < STOP_PROOF_BATCH_SIZE) break;
      leaseCursor = leases[leases.length - 1]!.id;
    }
    for (const row of runs) {
      const coordinator = coordinatorsByRun.get(row.id);
      if (coordinator && !await coordinatorHasStopped(coordinator, row.status)) return false;
      if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(row.status)) return false;
      if (row.controllerLeaseExpiresAt && row.controllerLeaseExpiresAt > new Date()) return false;
      const leases = leaseProofs.get(row.id);
      if (leases?.remote) {
        if (row.status === "cancelled" && !leases.receipts) return false;
        continue;
      }
      let processAlive = Boolean(row.processPid && !absent(row.processPid));
      let groupAlive = Boolean(row.processGroupId && !absent(-row.processGroupId));
      if (processAlive && row.processStartedAt) {
        const observed = await readProcessStartedAt(row.processPid!).catch(() => null);
        if (observed && new Date(observed).getTime() !== row.processStartedAt.getTime()) {
          processAlive = false;
          if (row.processGroupId === row.processPid) groupAlive = false;
        }
      }
      if (processAlive || groupAlive) return false;
      if (row.status !== "cancelled" || !row.startedAt || row.processPid || row.processGroupId) continue;
      // These existing helpers declare a full Run/Coordinator, but consume only
      // the explicitly projected proof fields below. Do not fetch full rows to
      // satisfy their broader types.
      const run = {
        ...row,
        resultJson: row.resultWasNull ? null : {
          executionCancellation: { state: row.cancellationState },
          startupCancellation: { beforeNativeSelection: row.beforeNativeSelection },
          startupPreparationSettledAt: row.startupPreparationSettledAt,
          workspaceRestoreFailure: row.workspaceRestoreFailure,
          workspaceRestoreRecovery: { schema: row.workspaceRecoverySchema },
          conversationContinuation: row.conversationContinuation,
          stopReason: row.stopReason, timeoutSource: row.timeoutSource,
          preDispatchResponseWait: {
            version: row.responseWaitVersion ? 1 : null,
            providerWorkStarted: row.responseWaitNoProvider ? false : null,
          },
        },
        runnerProfileJson: { adapterDispatch: { adapterType: row.adapterType } },
        contextSnapshot: {
          connectionIntentResolution: row.connectionIntentResolution, source: row.source,
          interactionKind: row.interactionKind, interactionStatus: row.interactionStatus,
          mutation: row.mutation, interactionId: row.interactionId,
        },
      } as unknown as Run;
      const startupCoordinator = coordinator ? {
        ...coordinator, failureDetail: { successorRunId: coordinator.hasSuccessorRun },
      } as unknown as Coordinator : undefined;
      if (row.runtimeMode === "native" &&
          !await hasNativeLocalProcessStop(db, row.companyId, row.id) &&
          !await isCancelledNativeStartup(db, run, startupCoordinator)) return false;
      if (row.runtimeMode === "legacy" && row.cancellationState !== "acknowledged" &&
          !(row.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
          !await isCancelledNativeStartup(db, run, startupCoordinator)) return false;
    }
    if (runs.length < STOP_PROOF_BATCH_SIZE) break;
    cursor = runs[runs.length - 1]!.id;
  }

  // Do not clear any owner until every historical execution has stop proof.
  // Re-read bounded pages and retain the original owner/version CAS fence.
  let coordinatorCursor: string | undefined;
  for (;;) {
    const abandoned = await db.select({
      ...stopProofCoordinatorSelection, status: heartbeatRuns.status,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, nativeRunFinalizations.runId))
      .where(and(inArray(heartbeatRuns.agentId, agentIds), sql`${nativeRunFinalizations.leaseOwner} <> ''`,
        coordinatorCursor ? gt(nativeRunFinalizations.runId, coordinatorCursor) : undefined))
      .orderBy(nativeRunFinalizations.runId).limit(STOP_PROOF_BATCH_SIZE);
    for (const coordinator of abandoned) {
      if (!await coordinatorHasStopped(coordinator, coordinator.status)) return false;
      const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
          eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
          eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
          eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
          eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
        .returning({ runId: nativeRunFinalizations.runId });
      if (!cleared) return false;
    }
    if (abandoned.length < STOP_PROOF_BATCH_SIZE) break;
    coordinatorCursor = abandoned[abandoned.length - 1]!.runId;
  }
  return true;
}
