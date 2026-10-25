import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { agentObservabilityService } from "./agent-observability.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
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

// A company delete must not cascade or SET NULL another company's records.
// Ownership is sometimes indirect (for example status_card_updates -> cards),
// so inspect the actual FK graph rather than maintaining a partial link list.
async function assertCompanyDeletionBoundary(
  tx: DeletionTransaction,
  id: string,
  run: <T>(query: PromiseLike<T>) => Promise<T>,
) {
  type Reference = {
    constraint_id: string;
    child_id: string; child_schema: string; child_table: string; child_has_company: boolean;
    parent_id: string; parent_schema: string; parent_table: string; parent_has_company: boolean;
    child_columns: string[]; parent_columns: string[];
  };
  const references = await run(tx.execute<Reference>(sql`
    select fk.oid::text as constraint_id,
      child.oid::text as child_id, cns.nspname as child_schema, child.relname as child_table,
      parent.oid::text as parent_id, pns.nspname as parent_schema, parent.relname as parent_table,
      exists (select 1 from pg_attribute a where a.attrelid = child.oid
        and a.attname = 'company_id' and not a.attisdropped) as child_has_company,
      exists (select 1 from pg_attribute a where a.attrelid = parent.oid
        and a.attname = 'company_id' and not a.attisdropped) as parent_has_company,
      array_agg(ca.attname::text order by keys.ordinality) as child_columns,
      array_agg(pa.attname::text order by keys.ordinality) as parent_columns
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace cns on cns.oid = child.relnamespace
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace pns on pns.oid = parent.relnamespace
    cross join lateral unnest(fk.conkey, fk.confkey) with ordinality as keys(child_key, parent_key, ordinality)
    join pg_attribute ca on ca.attrelid = child.oid and ca.attnum = keys.child_key
    join pg_attribute pa on pa.attrelid = parent.oid and pa.attnum = keys.parent_key
    where fk.contype = 'f'
    group by fk.oid, child.oid, child.relname, cns.nspname, parent.oid, parent.relname, pns.nspname
  `));
  const ownershipColumns = new Map<string, string>();
  const parents = new Map<string, Reference[]>();
  for (const reference of references) {
    if (reference.child_has_company) ownershipColumns.set(reference.child_id, "company_id");
    if (reference.parent_has_company) ownershipColumns.set(reference.parent_id, "company_id");
    if (reference.child_table === "companies") ownershipColumns.set(reference.child_id, "id");
    if (reference.parent_table === "companies") ownershipColumns.set(reference.parent_id, "id");
    const edges = parents.get(reference.child_id) ?? [];
    edges.push(reference);
    parents.set(reference.child_id, edges);
  }
  function ownershipPaths(tableId: string, excludedConstraint?: string): Reference[][] {
    const paths: Reference[][] = [];
    const pending = [{ tableId, path: [] as Reference[], visited: new Set([tableId]) }];
    let traversed = 0;
    while (pending.length > 0) {
      // Bound total work too, not just breadth, in a multiply linked graph.
      if (++traversed > 256) {
        throw new AgentLifecycleConflict("Company deletion cannot establish bounded dependency ownership");
      }
      const next = pending.pop()!;
      if (ownershipColumns.has(next.tableId)) {
        paths.push(next.path);
        continue;
      }
      for (const edge of parents.get(next.tableId) ?? []) {
        if (edge.constraint_id === excludedConstraint || next.visited.has(edge.parent_id)) continue;
        pending.push({
          tableId: edge.parent_id, path: [...next.path, edge],
          visited: new Set([...next.visited, edge.parent_id]),
        });
      }
      // Schema topology, not historical row count, bounds this traversal.
      // Never silently skip ambiguous ownership if a future schema exceeds it.
      if (pending.length + paths.length > 256) {
        throw new AgentLifecycleConflict("Company deletion cannot establish bounded dependency ownership");
      }
    }
    return paths;
  }
  function match(reference: Reference, child: string, parent: string): SQL {
    return sql.join(reference.child_columns.map((column, index) =>
      sql`${sql.identifier(child)}.${sql.identifier(column)} = ${sql.identifier(parent)}.${sql.identifier(reference.parent_columns[index]!)}`,
    ), sql` and `);
  }
  function ownerPredicate(tableId: string, alias: string, paths: Reference[][], foreign: boolean): SQL {
    const comparison = foreign ? sql`<> ${id}` : sql`= ${id}`;
    return sql.join(paths.map((path) => {
      if (path.length === 0) {
        return sql`${sql.identifier(alias)}.${sql.identifier(ownershipColumns.get(tableId)!)} ${comparison}`;
      }
      const first = path[0]!;
      const from = sql`${sql.identifier(first.parent_schema)}.${sql.identifier(first.parent_table)} owner_0`;
      const joins = path.slice(1).map((edge, index) => sql`
        join ${sql.identifier(edge.parent_schema)}.${sql.identifier(edge.parent_table)} ${sql.identifier(`owner_${index + 1}`)}
          on ${match(edge, `owner_${index}`, `owner_${index + 1}`)}
      `);
      const last = path[path.length - 1]!;
      return sql`exists (
        select 1 from ${from} ${sql.join(joins, sql` `)}
        where ${match(first, alias, "owner_0")}
          and ${sql.identifier(`owner_${path.length - 1}`)}.${sql.identifier(ownershipColumns.get(last.parent_id)!)} ${comparison}
      )`;
    }), sql` or `);
  }
  for (const reference of references) {
    // A composite ownership FK already proves equality of company IDs.
    if (reference.child_has_company && reference.parent_has_company
      && reference.child_columns.some((column, index) =>
        column === "company_id" && reference.parent_columns[index] === "company_id")) continue;
    if (reference.parent_table === "companies" && reference.child_has_company
      && reference.child_columns.length === 1 && reference.child_columns[0] === "company_id") continue;
    const parentOwners = ownershipPaths(reference.parent_id);
    const childOwners = ownershipPaths(reference.child_id, reference.constraint_id);
    // With no independent ownership path, a child belongs solely to its
    // referenced parent and cannot represent another company's owned record.
    if (parentOwners.length === 0 || childOwners.length === 0) continue;
    const rows = await run(tx.execute(sql`
      select 1 from ${sql.identifier(reference.child_schema)}.${sql.identifier(reference.child_table)} child
      join ${sql.identifier(reference.parent_schema)}.${sql.identifier(reference.parent_table)} owned
        on ${match(reference, "child", "owned")}
      where (${ownerPredicate(reference.parent_id, "owned", parentOwners, false)})
        and (${ownerPredicate(reference.child_id, "child", childOwners, true)})
      limit 1
    `));
    if (rows.length > 0) {
      throw new AgentLifecycleConflict("Another company references this company's deletion dependencies");
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
            await run(tx.execute(sql`
              select count(*) from (
                select id from ${issues} where company_id = ${id} for update
              ) locked_issues
            `));
            await assertCompanyDeletionBoundary(tx, id, run);
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
