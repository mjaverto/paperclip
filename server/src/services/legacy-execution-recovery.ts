import { notifyExecutionRunWork } from "./execution-control-notifications.js";
import { hasRequiredWorkspaceRecovery, preserveWorkspaceRestoreRecoveryMetadata, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";
import { hasUnrestoredRemoteWorkspace, preserveLegacyWorkspaceRestoreSources, type LegacyWorkspaceRestoreSource } from "./legacy-workspace-restore-recovery.js";
import { isPreDispatchReviewWaitVerified } from "./pre-dispatch-review-wait.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { claimedAdapterType, hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { agents, companies, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { logActivity, persistActivity } from "./activity-log.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { issueService } from "./issues.js";
import { conflict } from "../errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { expediteAgentStopRetryInTransaction } from "../modules/agent-lifecycle/index.js";

type Run = typeof heartbeatRuns.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh model turn cannot repair or verify unrestored files.
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) return true;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && (run.errorCode === "ai_connection_busy" || run.errorCode === "ai_connection_pool_exhausted") &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** Admission-wait receipts are only exempt after retained execution evidence agrees.
 * The synchronous classifier stays conservative for callers without a DB proof. */
export async function legacyExecutionNeedsReconciliationWithEvidence(db: Db, run: Run): Promise<boolean> {
  return await hasUnrestoredRemoteWorkspace(db, run) ||
    (legacyExecutionNeedsReconciliation(run) && !(await isPreDispatchReviewWaitVerified(db, run))
      && !(await isPreDispatchExecutionWaitVerified(db, run)));
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
  reconcileIfNeeded?: boolean;
  writeConditions?: SQL[];
  /** Adapter settlement records a copy-back failure before host finalization. */
  recordRestoreFailureOnly?: boolean;
  workspaceRestoreSource?: LegacyWorkspaceRestoreSource;
}) {
  const { db, run, status } = input;
  let patch = input.patch;
  const issueId =
    run.nativeIssueId ?? run.issueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    )).for("update");
    if (!current || (current.runtimeMode !== "legacy" && !(input.recordRestoreFailureOnly && current.runtimeMode === "native")) ||
        (!input.recordRestoreFailureOnly && !(input.fromStatuses ?? [run.status]).includes(current.status))) return null;
    if (patch?.resultJson !== undefined) patch = { ...patch,
      resultJson: preserveWorkspaceRestoreRecoveryMetadata(current.resultJson,
        input.recordRestoreFailureOnly ? { ...current.resultJson, ...patch.resultJson } : patch.resultJson),
    };
    await notifyExecutionRunWork(tx);
    let [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status: input.recordRestoreFailureOnly ? current.status : status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.status, current.status),
          ...(input.writeConditions ?? []),
        ),
      )
      .returning();
    if (!updated) return null;
    const retainedLeaseIds = await preserveLegacyWorkspaceRestoreSources(tx as unknown as Db,
      input.recordRestoreFailureOnly ? { ...updated, status: "failed" } : updated, input.workspaceRestoreSource);
    if (retainedLeaseIds.length) {
      [updated] = await tx.update(heartbeatRuns).set({ resultJson: {
        ...updated.resultJson,
        workspaceRestoreRecovery: { schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: retainedLeaseIds },
      } }).where(and(eq(heartbeatRuns.id, updated.id), eq(heartbeatRuns.companyId, updated.companyId))).returning();
    }
    const needsRecovery = input.recordRestoreFailureOnly
      ? retainedLeaseIds.length > 0 || hasRequiredWorkspaceRecovery(updated.resultJson)
      : !input.reconcileIfNeeded || await legacyExecutionNeedsReconciliationWithEvidence(tx as unknown as Db, updated);
    if (!needsRecovery) return updated;
    if (!input.recordRestoreFailureOnly && task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (!input.recordRestoreFailureOnly && task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    if (task && hasRequiredWorkspaceRecovery(updated.resultJson)) {
      // File recovery belongs to this exact source, even if cancellation let a
      // newer owner or conversation generation start before copy-back settled.
      // A resolved no-replay hold can coexist with another active incident; the
      // one-active-action index must never make us supersede either obligation.
      const fingerprint = `${run.runtimeMode === "native" ? "native-workspace" : "legacy-execution"}:${run.id}`;
      const [existing] = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
        eq(issueRecoveryActions.fingerprint, fingerprint),
      )).orderBy(desc(issueRecoveryActions.createdAt)).limit(1).for("update");
      const decision = existing?.evidence.executionReconciliation as Record<string, unknown> | undefined;
      if (hasRequiredWorkspaceRecovery(existing?.evidence) && decision?.runId === run.id) return updated;
      const now = new Date();
      const evidence = {
        ...existing?.evidence,
        runId: run.id,
        originalFailureCode: updated.errorCode,
        workspaceRestoreFailure: updated.resultJson!.workspaceRestoreFailure,
        workspaceRestoreRecovery: updated.resultJson!.workspaceRestoreRecovery,
        executionReconciliation: undefined,
        continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: run.id, replay: "blocked",
          actionOutcome: "unknown", recordedAt: now.toISOString() },
      };
      const values = { status: "resolved", outcome: "blocked", ownerType: "board", ownerAgentId: null,
        ownerUserId: null, returnOwnerAgentId: null, evidence, resolvedAt: now, updatedAt: now,
        wakePolicy: null, monitorPolicy: null,
        nextAction: "The original sandbox is retained for workspace repair. Verify its exact stop receipt, recover the missing files, and record workspaceRepairEvidence without changing the current task. Repair does not replay the stopped run. Explicitly remove the retained allocation after recovery.",
      };
      if (existing) await tx.update(issueRecoveryActions).set(values).where(eq(issueRecoveryActions.id, existing.id));
      else await tx.insert(issueRecoveryActions).values({ ...values, companyId: run.companyId,
        sourceIssueId: task.id, kind: "active_run_watchdog",
        cause: run.runtimeMode === "native" ? "native_continuation_requires_reconciliation" : LEGACY_RECOVERY_CAUSE,
        fingerprint, attemptCount: 1 });
      return updated;
    }
    const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
    const isCurrentReviewer = review?.status === "pending" &&
      review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
    if (
      task &&
      !isSupersededConversationRun(task, updated) &&
      (task.assigneeAgentId === run.agentId || isCurrentReviewer) &&
      (!["done", "cancelled"].includes(task.status) || retainedLeaseIds.length > 0)
    ) {
      // Periodic stranded-work checks may revisit this terminal run before its
      // reconciled or explicitly requested continuation is dispatched. Preserve
      // its recorded decision instead of creating another hold. The explicit
      // receipt must identify an actual successor under the same task/agent;
      // retained user intent remains authoritative after that successor finishes.
      const [reconciled] = await tx.select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          ...(hasRequiredWorkspaceRecovery(updated.resultJson) ? [
            sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
          ] : []),
          or(
            sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
            and(
              sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
              sql`exists (
                select 1 from heartbeat_runs successor
                where successor.id = ${canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'runId'`)}
                  and successor.company_id = ${run.companyId} and successor.agent_id = ${run.agentId}
                  and coalesce(successor.native_issue_id::text, successor.issue_id::text,
                    successor.context_snapshot->>'issueId') = ${task.id}
                  and successor.context_snapshot->>'previousRunId' = ${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'previousRunId'
                  and successor.context_snapshot->'explicitUserContinuation'->>'previousRunId' = ${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'previousRunId'
                  and successor.context_snapshot->'explicitUserContinuation'->>'commentId' is not distinct from
                    ${issueRecoveryActions.evidence}->'explicitUserContinuation'->>'commentId'
              )`,
            ),
            and(
              sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
              or(sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
                sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`),
              sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
            ),
          ),
        )).limit(1);
      if (reconciled) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          ...(hasWorkspaceRestoreFailure(updated.resultJson) ? { workspaceRestoreFailure: updated.resultJson!.workspaceRestoreFailure } : {}),
          ...(hasRequiredWorkspaceRecovery(updated.resultJson) ? { workspaceRestoreRecovery: updated.resultJson!.workspaceRestoreRecovery } : {}),
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction: hasRequiredWorkspaceRecovery(updated.resultJson)
          ? "The original sandbox is retained for workspace repair. Verify that it has stopped, recover the missing files, record workspaceRepairEvidence, and explicitly remove the retained allocation when recovery is complete. A new agent turn cannot prove file recovery."
          : hasWorkspaceRestoreFailure(updated.resultJson)
          ? "Verify safe workspace staging or repair, then reconcile the stopped run before continuing. Saved work and approval decisions remain in force."
          : "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}

/** Called only by the exact executor's finally block after preparation/cleanup
 * settles. A shutdown can win the terminal-status race before the setup catch
 * records that no provider started. Retire only that mistaken recovery hold. */
export async function settleInterruptedNativeBootstrap(
  db: Db, input: { run: Run; providerDispatchStarted: boolean },
): Promise<Run | null> {
  if (input.providerDispatchStarted) return null;
  const issueId = input.run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return null;
  return db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.run.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId))).for("update");
    if (!task || !run || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt ||
        run.contextSnapshot?.issueId !== task.id ||
        run.status !== "interrupted" || run.errorCode !== "server_shutdown_interrupted" ||
        claimedAdapterType(run) !== "paperclip_runner" || run.processPid || run.processGroupId ||
        hasWorkspaceRestoreFailure(run.resultJson) || executionFailureRetryCount(run) >= 2) return null;
    const [native] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).limit(1);
    const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      or(isNull(environmentLeases.releasedAt), eq(environmentLeases.status, "pending_cleanup"), eq(environmentLeases.cleanupStatus, "failed")),
    )).limit(1);
    if (native || lease) return null;
    const holds = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
      eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE), eq(issueRecoveryActions.fingerprint, `legacy-execution:${run.id}`),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
      sql`coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'`,
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]), and(
        eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'`,
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      )),
    )).for("update");
    const ownedBlock = holds.map(hold => hold.evidence.nativeBootstrapFailureBlock as Record<string, unknown> | undefined)
      .find(receipt => receipt?.runId === run.id && receipt.statusVersion === task.statusVersion &&
        ["todo", "in_progress", "in_review"].includes(String(receipt.previousStatus)));
    if (task.status === "blocked" && ownedBlock && task.assigneeAgentId === run.agentId &&
        !isSupersededConversationRun(task, run) && !task.executionRunId && !task.checkoutRunId) {
      // Restore only the unchanged projection made by this exact incident.
      // The issue service still enforces dependency/assignee readiness. Human
      // reblocks, reassignment and conversation resets invalidate this receipt.
      await issueService(tx as unknown as Db).update(task.id, { status: String(ownedBlock.previousStatus) }, tx);
    }
    const now = new Date();
    const [settled] = await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false, preparationSettledAt: now.toISOString() },
    }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id)).returning();
    const resolved = holds.length ? await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive",
      resolutionNote: "The interrupted executor finished preparation and cleanup without starting a provider.",
      resolvedAt: now, updatedAt: now,
      // An automatic disposition may already have resolved the incident but
      // left replay blocked. Preserve its history while correcting that verdict.
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"allowed"'::jsonb, false) ||
        ${JSON.stringify({ bootstrapPreparationSettledAt: now.toISOString() })}::jsonb`,
    }).where(inArray(issueRecoveryActions.id, holds.map(hold => hold.id))).returning({ id: issueRecoveryActions.id }) : [];
    if (resolved.length) await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "system",
      action: "issue.recovery_action_resolved", entityType: "issue", entityId: task.id, agentId: run.agentId, runId: run.id,
      details: { reason: "native_bootstrap_stopped_before_provider", recoveryActionIds: resolved.map(r => r.id) },
    });
    return settled;
  });
}

/** Capture the required-file obligation before unrelated host writes. Keeps
 * execution ownership while the adapter's host finalization is still running. */
export async function recordLegacyWorkspaceRestoreFailure(db: Db, run: Run, evidence: Record<string, unknown>, source?: LegacyWorkspaceRestoreSource) {
  if (run.runtimeMode !== "legacy" || !hasWorkspaceRestoreFailure(evidence)) return;
  return recordRequiredWorkspaceRestoreFailure(db, run, evidence, source);
}

export async function recordRequiredWorkspaceRestoreFailure(db: Db, run: Run, evidence: Record<string, unknown>, source?: LegacyWorkspaceRestoreSource) {
  if (!hasWorkspaceRestoreFailure(evidence)) return;
  return terminalizeLegacyExecution({ db, run, status: run.status,
    recordRestoreFailureOnly: true, patch: { resultJson: evidence }, workspaceRestoreSource: source,
  });
}

export interface ArchivedExecutionReconciliationResult {
  companyId: string | null;
  runId: string;
  state: "eligible" | "reconciled" | "blocked";
  reason?: string;
  evidenceSha256?: string;
  proof?: Record<string, unknown>;
}

/** Operator evidence must bind this exact run's local executor to the retired
 * host/namespace. A current server restart or a missing PID is not that binding. */
export interface ArchivedLocalExecutionRetirementEvidence {
  runId: string;
  executionHostIdentity: string;
  executionBinding: string;
  kind: "execution_host_reboot" | "execution_host_retired" | "execution_pid_namespace_retired";
  observedAt: string;
  retirementOrBootBoundary: string;
  verifier: string;
  sourceReference: string;
  sourceSha256: string;
}

/**
 * Re-encode positive historical executor receipts, not a terminal status or an
 * absent PID. No provider is stopped, action outcome attested, or work replayed.
 *
 * Historical heartbeat 07757a59e wrote exitCode/signal and a lifecycle status
 * payload only after the local adapter returned its child-close result.
 * Scratch cleanup alone is insufficient: older ACP close errors were swallowed.
 * Missing exit receipts and custom commands require separately verified local
 * host/namespace retirement, bound to this exact invocation by the operator.
 * Neither a released lease nor an operator cancellation event proves Stop.
 *
 * Dry-run is read-only. Apply requires each exact dry-run evidence hash and
 * rechecks the company, agent, run, event and lease identities under row locks.
 * This deliberately excludes native, remote, unknown, and modern controllers.
 */
export async function reconcileArchivedCompanyExecutions(db: Db, input: {
  companyIds: string[];
  runIds: string[];
  actorId: string;
  apply?: boolean;
  expectedEvidence?: Record<string, string>;
  retirementEvidence?: ArchivedLocalExecutionRetirementEvidence[];
}): Promise<ArchivedExecutionReconciliationResult[]> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!input.companyIds.length || input.companyIds.some(id => !uuid.test(id)) ||
      !input.runIds.length || input.runIds.length > 100 || input.runIds.some(id => !uuid.test(id)) ||
      new Set(input.runIds).size !== input.runIds.length || !input.actorId.trim()) {
    throw conflict("Explicit company UUIDs, 1–100 unique run UUIDs, and an operator identity are required.");
  }
  if (input.apply && input.runIds.some(id => !/^[a-f0-9]{64}$/.test(input.expectedEvidence?.[id] ?? ""))) {
    throw conflict("Apply requires the exact evidence hash for every run from a reviewed dry-run.");
  }
  const retirementEvidence = new Map<string, ArchivedLocalExecutionRetirementEvidence>();
  for (const evidence of input.retirementEvidence ?? []) {
    if (!input.runIds.includes(evidence.runId) || retirementEvidence.has(evidence.runId) ||
        !["execution_host_reboot", "execution_host_retired", "execution_pid_namespace_retired"].includes(evidence.kind) ||
        typeof evidence.executionHostIdentity !== "string" || evidence.executionHostIdentity.trim().length < 10 ||
        typeof evidence.executionBinding !== "string" || evidence.executionBinding.trim().length < 20 ||
        typeof evidence.verifier !== "string" || !evidence.verifier.trim() ||
        typeof evidence.sourceReference !== "string" || !evidence.sourceReference.trim() ||
        typeof evidence.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sourceSha256) ||
        typeof evidence.observedAt !== "string" || typeof evidence.retirementOrBootBoundary !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/.test(evidence.observedAt) || !/^\d{4}-\d{2}-\d{2}T/.test(evidence.retirementOrBootBoundary) ||
        !Number.isFinite(Date.parse(evidence.observedAt)) || !Number.isFinite(Date.parse(evidence.retirementOrBootBoundary))) {
      throw conflict("Retirement evidence needs an exact listed run, verified host binding, timestamps, verifier and hashed source.");
    }
    retirementEvidence.set(evidence.runId, evidence);
  }
  const results: ArchivedExecutionReconciliationResult[] = [];
  for (const runId of [...input.runIds].sort()) {
    const [binding] = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.companyId, input.companyIds)));
    const blocked = (reason: string): ArchivedExecutionReconciliationResult => ({
      companyId: binding?.companyId ?? null, runId, state: "blocked", reason,
    });
    if (!binding) { results.push(blocked("Run is absent or outside the explicit company scope.")); continue; }
    results.push(await db.transaction<ArchivedExecutionReconciliationResult>(async tx => {
      if (!input.apply) await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
      const companyQuery = tx.select({ id: companies.id, status: companies.status }).from(companies)
        .where(eq(companies.id, binding.companyId));
      const [company] = await (input.apply ? companyQuery.for("update") : companyQuery);
      if (company?.status !== "archived") return blocked("Company must remain archived.");
      const agentQuery = tx.select({ id: agents.id, state: agents.lifecycleState, version: agents.lifecycleVersion,
        status: agents.status }).from(agents)
        .where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId)));
      const [agent] = await (input.apply ? agentQuery.for("update") : agentQuery);
      if (!agent || !["terminating", "cleaning_up", "terminated", "rejected"].includes(agent.state) ||
          agent.status !== "terminated") return blocked("Agent must remain fenced for termination.");
      const coordinatorQuery = tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
        .where(and(eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.runId, runId)));
      const coordinators = await (input.apply ? coordinatorQuery.for("update") : coordinatorQuery);
      if (coordinators.length) return blocked("Native execution ownership requires its own stop protocol.");
      const runQuery = tx.select({
        id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        rowVersion: sql<string>`${heartbeatRuns}."xmin"::text`,
        status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
        resolvedAt: heartbeatRuns.runtimeModeResolvedAt, controllerBootId: heartbeatRuns.controllerBootId,
        controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
        startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
        executionStage: heartbeatRuns.executionStage, processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
        nativeSessionId: heartbeatRuns.nativeSessionId, externalRunId: heartbeatRuns.externalRunId,
        exitCode: heartbeatRuns.exitCode, signal: heartbeatRuns.signal,
        cancellationState: sql<string | null>`${heartbeatRuns.resultJson}->'executionCancellation'->>'state'`,
        stopReason: sql<string | null>`${heartbeatRuns.resultJson}->>'stopReason'`,
        workspaceFailure: sql<string | null>`${heartbeatRuns.resultJson}->>'workspaceRestoreFailure'`,
        workspaceRecovery: sql<string | null>`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema'`,
        claimedAdapter: sql<string | null>`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`,
        environmentDriver: sql<string | null>`${heartbeatRuns.contextSnapshot}->'paperclipEnvironment'->>'driver'`,
        environmentLeaseId: sql<string | null>`${heartbeatRuns.contextSnapshot}->'paperclipEnvironment'->>'leaseId'`,
        scratchDir: sql<string | null>`${heartbeatRuns.contextSnapshot}->'paperclipScratch'->>'dir'`,
      }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId)));
      const [run] = await (input.apply ? runQuery.for("update") : runQuery);
      const now = new Date();
      if (!run || run.status !== "cancelled" || run.runtimeMode !== "legacy" || !run.startedAt || !run.finishedAt ||
          run.finishedAt < run.startedAt || run.finishedAt > now || run.resolvedAt || run.controllerBootId ||
          run.processPid || run.processGroupId || run.processStartedAt || run.nativeSessionId || run.externalRunId ||
          (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now) ||
          run.cancellationState === "acknowledged" || run.workspaceFailure || run.workspaceRecovery) {
        return blocked("Run is not an unreconciled, terminal, pre-controller local legacy execution.");
      }
      const finishedAt = run.finishedAt;
      const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      )).limit(1);
      if (active) return blocked("Agent still has active execution authority.");
      const leaseQuery = tx.select({
        id: environmentLeases.id, companyId: environmentLeases.companyId, runId: environmentLeases.heartbeatRunId,
        provider: environmentLeases.provider, status: environmentLeases.status,
        cleanupStatus: environmentLeases.cleanupStatus, releasedAt: environmentLeases.releasedAt,
        rowVersion: sql<string>`${environmentLeases}."xmin"::text`,
      }).from(environmentLeases).where(or(eq(environmentLeases.heartbeatRunId, runId), and(
        eq(environmentLeases.companyId, binding.companyId),
        sql`${environmentLeases.metadata}->>'agentId' = ${binding.agentId}`,
        or(isNull(environmentLeases.releasedAt), eq(environmentLeases.status, "pending_cleanup"),
          eq(environmentLeases.cleanupStatus, "failed")),
      ))).orderBy(asc(environmentLeases.id));
      const leases = await (input.apply ? leaseQuery.for("update") : leaseQuery);
      if (leases.some(lease => lease.companyId !== binding.companyId || lease.runId !== runId ||
          lease.provider !== "local" || !lease.releasedAt || lease.releasedAt > now ||
          lease.status === "pending_cleanup" || lease.cleanupStatus === "failed") ||
          (run.environmentDriver && run.environmentDriver !== "local") ||
          (run.environmentLeaseId && !leases.some(lease => lease.id === run.environmentLeaseId))) {
        return blocked("Remote, unknown, changed or unreleased environment authority cannot use local receipts.");
      }
      const events = await tx.select({
        id: heartbeatRunEvents.id, seq: heartbeatRunEvents.seq, type: heartbeatRunEvents.eventType,
        message: heartbeatRunEvents.message, createdAt: heartbeatRunEvents.createdAt,
        adapterType: sql<string | null>`${heartbeatRunEvents.payload}->>'adapterType'`,
        command: sql<string | null>`${heartbeatRunEvents.payload}->>'command'`,
        environmentDriver: sql<string | null>`${heartbeatRunEvents.payload}->'context'->'paperclipEnvironment'->>'driver'`,
        status: sql<string | null>`${heartbeatRunEvents.payload}->>'status'`,
        hasExitCode: sql<boolean>`coalesce(${heartbeatRunEvents.payload} ? 'exitCode', false)`,
        exitCode: sql<string | null>`${heartbeatRunEvents.payload}->>'exitCode'`,
        exitCodeType: sql<string | null>`jsonb_typeof(${heartbeatRunEvents.payload}->'exitCode')`,
        removed: sql<boolean>`coalesce(${heartbeatRunEvents.payload}->'removed' = 'true'::jsonb, false)`,
        dir: sql<string | null>`${heartbeatRunEvents.payload}->>'dir'`,
      }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, binding.companyId),
        eq(heartbeatRunEvents.runId, runId), isNull(heartbeatRunEvents.sourceEventId),
        or(eq(heartbeatRunEvents.eventType, "adapter.invoke"), and(eq(heartbeatRunEvents.eventType, "lifecycle"),
          inArray(heartbeatRunEvents.message, ["run cancelled", "run scratch cleaned"])))))
        .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id));
      const invocations = events.filter(event => event.type === "adapter.invoke");
      const invocation = invocations[0];
      if (invocations.length !== 1 || !invocation || !["claude_local", "opencode_local"].includes(invocation.adapterType ?? "") ||
          (run.claimedAdapter && run.claimedAdapter !== invocation.adapterType) ||
          (invocation.environmentDriver && invocation.environmentDriver !== "local") ||
          invocation.createdAt < run.startedAt || invocation.createdAt > run.finishedAt) {
        return blocked("An exact historical local adapter invocation is required; mutable agent settings are not proof.");
      }
      const retirement = retirementEvidence.get(runId);
      if (retirement && (Date.parse(retirement.retirementOrBootBoundary) <= run.finishedAt.getTime() ||
          Date.parse(retirement.retirementOrBootBoundary) > Date.parse(retirement.observedAt) ||
          Date.parse(retirement.observedAt) > now.getTime())) {
        return blocked("Verified retirement must follow this execution and precede its non-future observation.");
      }
      if (!invocation.command) return blocked("Historical invocation command identity is missing.");
      const canonicalCommand = basename(invocation.command) ===
        (invocation.adapterType === "claude_local" ? "claude" : "opencode");
      const terminal = canonicalCommand ? events.find(event => event.type === "lifecycle" && event.message === "run cancelled" &&
        event.status === "cancelled" && event.hasExitCode && event.seq > invocation.seq &&
        event.exitCodeType === (run.exitCode === null ? "null" : "number") &&
        event.exitCode === (run.exitCode === null ? null : String(run.exitCode)) &&
        event.createdAt >= finishedAt && (Number.isInteger(run.exitCode) ||
          ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"].includes(run.signal ?? ""))) : undefined;
      if (!terminal && !retirement) return blocked("No positive canonical adapter-close receipt or verified original local host retirement.");
      const proof = {
        schema: "paperclip.archived-legacy-stop.v1",
        kind: terminal ? "legacy_adapter_exit_receipt" : "verified_local_execution_retirement",
        adapterType: invocation.adapterType, invocationEventId: invocation.id,
        receiptEventId: terminal?.id ?? null,
        sourceRevisions: ["07757a59e", "a388ea1cac073f41b0ce00ee3293f17199dd9e09"],
        retirementEvidence: retirement ?? null,
        run, leases, events,
      };
      const evidenceSha256 = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
      if (!input.apply) return { companyId: binding.companyId, runId, state: "eligible", evidenceSha256, proof };
      if (input.expectedEvidence?.[runId] !== evidenceSha256) {
        throw conflict("Execution evidence changed after dry-run; inspect a new plan before applying.", { runId });
      }
      const acknowledgedAt = new Date().toISOString();
      const receipt = { state: "acknowledged", acknowledgedAt, proof: proof.kind,
        reconciliation: { schema: proof.schema, actorId: input.actorId, evidenceSha256, evidence: proof,
          actionOutcomes: "not_reconciled", replay: "not_authorized" } };
      const [updated] = await tx.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object('executionCancellation',
          coalesce(${heartbeatRuns.resultJson}->'executionCancellation', '{}'::jsonb) || ${JSON.stringify(receipt)}::jsonb)`,
        updatedAt: new Date(),
      }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.status, "cancelled"),
        eq(heartbeatRuns.runtimeMode, "legacy"), sql`${heartbeatRuns}."xmin"::text = ${run.rowVersion}`))
        .returning({ id: heartbeatRuns.id });
      if (!updated) throw conflict("Execution changed before reconciliation.", { runId });
      await persistActivity(tx as unknown as Db, {
        companyId: binding.companyId, actorType: "user", actorId: input.actorId,
        action: "heartbeat_run.archived_legacy_stop_reconciled", entityType: "heartbeat_run", entityId: runId,
        agentId: binding.agentId, runId,
        details: { evidenceSha256, proof, actionOutcomes: "not_reconciled", replay: "not_authorized" },
      });
      // Lifecycle owns scheduling and preserves the stop fence and worker lease.
      await expediteAgentStopRetryInTransaction(tx as unknown as Db, {
        notifyWork: target => notifyDeliveryWork(target, DELIVERY_QUEUES.agentLifecycle),
      }, binding.companyId, agent.id, agent.version);
      return { companyId: binding.companyId, runId, state: "reconciled", evidenceSha256, proof };
    }));
  }
  return results;
}
