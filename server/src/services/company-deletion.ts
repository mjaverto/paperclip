import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { agentObservabilityService } from "./agent-observability.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { createAgentLifecycle, processAgentLifecycle } from "./agent-lifecycle.js";
import { requestRestorePointDeletion } from "./git-restore-point-ledger.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import { AgentLifecycleConflict, assertAgentPurgeAllowed } from "../modules/agent-lifecycle/index.js";
import {
  companies, agents, companyLogos, assets, agentApiKeys, agentRuntimeState,
  agentTaskSessions, agentWakeupRequests, issues, issueComments, projects,
  executionWorkspaces, goals, heartbeatRuns, runIdentityContexts, heartbeatRunEvents,
  costEvents, decisionInvocations, financeEvents, budgetPolicies, budgetIncidents,
  issueReadStates, approvalComments, approvals, activityLog, companySecrets,
  joinRequests, invites, principalPermissionGrants, companyMemberships,
  companySkills, cases, documents, routineRuns, routineTriggers, routineRevisions,
  routines, nativeRunFinalizations, statusDecisionEffects, statusDecisions,
  workAssessments, nativeRunResults, completionContracts, decisions, decisionBundles,
  decisionQueues, decisionRetention, decisionTriage, decisionTriageEvents,
  browserUseRuns, browserUseBrowsers,
  browserUseSessions, browserUseSettings, documentAnnotationAnchorSnapshots,
  documentAnnotationComments, documentAnnotationThreads, feedbackVotes,
  feedbackExports, heartbeatRunWatchdogDecisions, inboxDismissals,
  issueApprovals, issueAttachments, issueDocuments, issueExecutionDecisions,
  issueInboxArchives, issuePlanDecompositions, issueRecoveryActions,
  issueReferenceMentions, issueRelations, issueThreadInteractions,
  issueTreeHoldMembers, issueTreeHolds, issueWorkProducts, projectGoals,
  projectWorkspaces, providerTraceRecords, routineDocuments, secretAccessEvents,
  workspaceRuntimeServices, environmentLeases,
} from "@paperclipai/db";

type DeletionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Nullable run references must not silently rewrite another company's history.
// Inspect the actual FK tuples (including native composite ownership keys), not
// a hand-maintained subset of links that can fall behind the schema.
async function assertCompanyRunBoundary(
  tx: DeletionTransaction,
  id: string,
  run: <T>(query: PromiseLike<T>) => Promise<T>,
) {
  const references = await run(tx.execute<{
    schema_name: string; table_name: string; child_columns: string[]; run_columns: string[];
  }>(sql`
    select ns.nspname as schema_name, child.relname as table_name,
      array_agg(ca.attname::text order by keys.ordinality) as child_columns,
      array_agg(ra.attname::text order by keys.ordinality) as run_columns
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace ns on ns.oid = child.relnamespace
    cross join lateral unnest(fk.conkey, fk.confkey) with ordinality as keys(child_key, run_key, ordinality)
    join pg_attribute ca on ca.attrelid = child.oid and ca.attnum = keys.child_key
    join pg_attribute ra on ra.attrelid = fk.confrelid and ra.attnum = keys.run_key
    where fk.contype = 'f' and fk.confrelid = 'heartbeat_runs'::regclass
      and exists (select 1 from pg_attribute a where a.attrelid = child.oid
        and a.attname = 'company_id' and not a.attisdropped)
    group by fk.oid, ns.nspname, child.relname
  `));
  for (const reference of references) {
    const join = sql.join(reference.child_columns.map((column, index) =>
      sql`child.${sql.identifier(column)} = owned.${sql.identifier(reference.run_columns[index]!)}`,
    ), sql` and `);
    const rows = await run(tx.execute(sql`
      select 1 from ${sql.identifier(reference.schema_name)}.${sql.identifier(reference.table_name)} child
      join ${heartbeatRuns} owned on ${join}
      where owned.company_id = ${id} and child.company_id <> ${id} limit 1
    `));
    if (rows.length > 0) {
      throw new AgentLifecycleConflict("Another company references this company's heartbeat runs");
    }
  }
}

/** Stop work first; dependency removal is atomic and bound to its request. */
export async function deleteCompany(db: Db, id: string, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const [existingCompany] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
  if (!existingCompany) return null;
  const lifecycle = createAgentLifecycle(db);
  const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, id));
  for (const agent of companyAgents) {
    options.signal?.throwIfAborted();
    await lifecycle.terminateAgent(agent.id);
    // Provider/process stop work must settle normally, never be interrupted by
    // cancelling the dependency transaction or replaced with a synthetic ack.
    await processAgentLifecycle(db, agent.id);
  }
  options.signal?.throwIfAborted();
  return withAccountHomeSecretMutationLock(undefined, id, () =>
    withDedicatedDbConnection(db, async (deletionDb) =>
      withDedicatedDbConnection(db, async (controlDb) => {
        const deadline = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
        let backend: { pid: number; backend_start: string; transaction_id: string } | undefined;
        let cancellation = Promise.resolve();
        // Both connections are private and kept until cancellation completes:
        // this PID can never have been returned to a pool for unrelated work.
        const cancel = () => {
          if (backend === undefined) return;
          const owner = backend;
          cancellation = cancellation.then(async () => {
            await controlDb.execute(sql`
              select pg_cancel_backend(pid) from pg_stat_activity
              where pid = ${owner.pid} and backend_start::text = ${owner.backend_start}
                and backend_xid::text = ${owner.transaction_id}
            `);
          });
          // Observe immediately; the original failure still propagates below.
          void cancellation.catch(() => {});
        };
        const timer = setTimeout(() => deadline.abort(new Error("Company deletion exceeded its transaction deadline")), 60_000);
        timer.unref?.();
        signal.addEventListener("abort", cancel, { once: true });
        const run = async <T>(query: PromiseLike<T>): Promise<T> => {
          signal.throwIfAborted();
          const result = await query;
          signal.throwIfAborted();
          return result;
        };
        try {
          signal.throwIfAborted();
          return await deletionDb.transaction(async (tx) => {
            const [owner] = await tx.execute<{ pid: number; backend_start: string; transaction_id: string }>(sql`
              select pg_backend_pid() as pid, backend_start::text,
                mod(txid_current(), 4294967296)::text as transaction_id
              from pg_stat_activity where pid = pg_backend_pid()
            `);
            backend = owner;
            signal.throwIfAborted();
            // Local to this transaction; no global limits on agent work.
            await run(tx.execute(sql`set local statement_timeout = '60s'`));
            await run(tx.execute(sql`set local lock_timeout = '5s'`));
            // KEY SHARE stays compatible with existing child/accounting saves.
            const [existing] = await run(tx.select({ id: companies.id }).from(companies)
              .where(eq(companies.id, id)).for("no key update"));
            if (!existing) return null;
            const lockedAgents = await run(tx.select({ lifecycleState: agents.lifecycleState }).from(agents)
              .where(eq(agents.companyId, id)).for("update"));
            // Refuse pending stop/cleanup before touching large history tables.
            for (const agent of lockedAgents) assertAgentPurgeAllowed(agent);
            for (const query of [
              tx.select({ id: browserUseSessions.id }).from(browserUseSessions).where(and(
                eq(browserUseSessions.companyId, id),
                sql`not (${browserUseSessions.status} = 'closed' or
                  (${browserUseSessions.status} = 'failed' and ${browserUseSessions.providerSessionId} is null))`,
              )).limit(1),
              tx.select({ id: browserUseBrowsers.id }).from(browserUseBrowsers).where(and(eq(browserUseBrowsers.companyId, id), ne(browserUseBrowsers.status, "stopped"))).limit(1),
              tx.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(and(eq(workspaceRuntimeServices.companyId, id), ne(workspaceRuntimeServices.status, "stopped"))).limit(1),
              // Orphan leases may have no run/agent; retain their only durable
              // teardown evidence until the same cleanup proof used by agent
              // stop has succeeded.
              tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
                eq(environmentLeases.companyId, id),
                sql`((${environmentLeases.releasedAt} is null and not coalesce(
                  ${environmentLeases.status} = 'retained' and ${environmentLeases.cleanupStatus} = 'success', false))
                  or ${environmentLeases.status} = 'pending_cleanup' or ${environmentLeases.cleanupStatus} = 'failed')`,
              )).limit(1),
              tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
                eq(nativeRunFinalizations.companyId, id), sql`${nativeRunFinalizations.leaseOwner} <> ''`,
              )).limit(1),
            ]) {
              if ((await run(query)).length > 0) {
                throw new AgentLifecycleConflict("Complete company provider and process cleanup before deleting the company");
              }
            }
            // Fence incoming FK inserts before checking cross-company links.
            // Aggregate server-side so locking history returns only one row.
            await run(tx.execute(sql`
              select count(*) from (
                select id from ${heartbeatRuns} where company_id = ${id} for update
              ) locked_runs
            `));
            await assertCompanyRunBoundary(tx, id, run);
            await run(notifyDeliveryWork(tx, DELIVERY_QUEUES.skillSourceSync));
            await run(agentObservabilityService(tx as unknown as Db).removeForCompanyDeletion(id));
            // Delete owned NO ACTION dependencies before runs, sessions, secrets,
            // issues or agents. Cascades remove their own subordinate records.
            for (const table of [
              financeEvents, decisionInvocations, costEvents, budgetIncidents, budgetPolicies,
              cases, nativeRunFinalizations, statusDecisionEffects, statusDecisions,
              workAssessments, nativeRunResults, completionContracts,
              decisions, decisionBundles, decisionTriageEvents, decisionTriage,
              decisionQueues, decisionRetention,
              browserUseRuns, browserUseBrowsers, browserUseSessions, browserUseSettings,
              documentAnnotationAnchorSnapshots, documentAnnotationComments, documentAnnotationThreads,
              feedbackExports, feedbackVotes, heartbeatRunWatchdogDecisions,
              inboxDismissals, issueApprovals, issueAttachments, issueDocuments,
              issueExecutionDecisions, issueInboxArchives, issuePlanDecompositions,
              issueRecoveryActions, issueReferenceMentions, issueRelations,
              issueThreadInteractions, issueTreeHoldMembers, issueTreeHolds,
              issueWorkProducts, providerTraceRecords, routineDocuments, secretAccessEvents,
              workspaceRuntimeServices,
            ]) {
              await run(tx.delete(table).where(eq(table.companyId, id)));
            }
            // Ownership is the delete predicate; no historical run IDs cross
            // into JavaScript or become a giant SQL IN parameter list.
            await run(tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id)));
            for (const table of [agentTaskSessions, activityLog, runIdentityContexts]) {
              await run(tx.delete(table).where(eq(table.companyId, id)));
            }
            await run(tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id)));
            for (const table of [
              agentWakeupRequests, agentApiKeys, agentRuntimeState, issueComments,
              approvalComments, approvals, companySecrets, joinRequests, invites,
              principalPermissionGrants, companyMemberships, companySkills,
              routineRuns, routineTriggers, routineRevisions, routines, issueReadStates,
              documents, issues, companyLogos, assets, projectGoals, goals,
            ]) {
              await run(tx.delete(table).where(eq(table.companyId, id)));
            }
            await run(requestRestorePointDeletion(tx, { companyId: id }));
            await run(tx.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, id)));
            await run(tx.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, id)));
            await run(tx.delete(projects).where(eq(projects.companyId, id)));
            await run(agentLifecycleCompanyDeletion.deleteCompanyData(tx, id));
            const rows = await run(tx.delete(companies).where(eq(companies.id, id)).returning());
            signal.throwIfAborted();
            return rows[0] ?? null;
          });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          await cancellation;
        }
      }),
    ),
  );
}
