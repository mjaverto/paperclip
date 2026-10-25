/**
 * Record verified historical Stop receipts without replaying work.
 *
 * Run from server with DATABASE_URL supplied through the existing secret store:
 *   pnpm exec tsx scripts/reconcile-archived-company-executions.ts \
 *     --company <archived-company-uuid> --actor <board-user-id>
 * Save and review the JSON output outside the company being removed. In
 * particular, inspect every proof's immutable invocation/receipt IDs and hashes.
 * Then repeat the explicit scope with --apply --plan <saved-json-file>.
 * --run <uuid> can be repeated to restrict the default historical gap inventory.
 *
 * Dry-run uses read-only transactions. Apply requires the reviewed evidence hash
 * for every selected run, rechecks proof under locks, and atomically writes the
 * cancellation receipt and activity audit. It does not stop processes, attest
 * action outcomes, request continuations, or complete lifecycle operations.
 * A blocked run needs actual stop evidence; never edit the plan to invent it.
 *
 * Missing child-close receipts need --retirement-evidence <manifest.json> on
 * BOTH dry-run and apply. The manifest is {version:1,evidence:[...]}.
 * Each evidence entry has these REQUIRED fields (no inferred/default values):
 *   runId: UUID of exactly one selected run
 *   executionHostIdentity: verified identity of its ORIGINAL execution host
 *   executionBinding: explanation binding the frozen invocation to that host
 *   kind: execution_host_reboot | execution_host_retired |
 *         execution_pid_namespace_retired
 *   observedAt: ISO timestamp of the verification
 *   retirementOrBootBoundary: ISO timestamp strictly after run.finishedAt,
 *                             no later than observedAt
 *   verifier: identity of the person who verified the retained source
 *   sourceReference: durable diagnostic/provenance reference
 *   sourceSha256: lowercase SHA-256 of the actual source artifact bytes
 *   sourcePath: source artifact path, relative to this manifest or absolute
 * The script checks the source bytes against the hash. The operator must
 * verify what those bytes prove, including original-host binding. The present
 * server/container restarting says nothing about an unrelated original host.
 * Exclude secrets from source artifacts. Save the manifest and source outside
 * the removed company; the database audit is company-owned.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { reconcileArchivedCompanyExecutions, type ArchivedExecutionReconciliationResult,
  type ArchivedLocalExecutionRetirementEvidence } from "../src/services/legacy-execution-recovery.js";

const { values } = parseArgs({ options: {
  company: { type: "string", multiple: true },
  run: { type: "string", multiple: true },
  actor: { type: "string" },
  apply: { type: "boolean", default: false },
  plan: { type: "string" },
  "retirement-evidence": { type: "string" },
} });
const companyIds = [...new Set(values.company ?? [])].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!companyIds.length || companyIds.some(id => !uuid.test(id)) || !values.actor?.trim()) {
  throw new Error("Use explicit --company UUID (repeatable) and --actor board-user-id.");
}
if (values.apply && !values.plan) throw new Error("--apply requires a reviewed --plan file from dry-run.");
if (values.plan && !values.apply) throw new Error("--plan is only accepted with --apply.");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required; never pass credentials as CLI arguments.");
const db = createDb(url, { maxConnections: 1, applicationName: "paperclip-archived-legacy-reconciliation" });
try {
  let runIds = values.run;
  let expectedEvidence: Record<string, string> | undefined;
  let retirementEvidence: ArchivedLocalExecutionRetirementEvidence[] | undefined;
  if (values["retirement-evidence"]) {
    const manifestPath = resolve(values["retirement-evidence"]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version?: number; evidence?: (ArchivedLocalExecutionRetirementEvidence & { sourcePath: string })[];
    };
    if (manifest.version !== 1 || !Array.isArray(manifest.evidence) || !manifest.evidence.length) {
      throw new Error("Retirement manifest must contain version:1 and explicit per-run evidence entries.");
    }
    retirementEvidence = [];
    for (const entry of manifest.evidence) {
      const { sourcePath, ...evidence } = entry;
      if (typeof sourcePath !== "string" || !sourcePath.trim()) throw new Error("Each retirement entry requires sourcePath.");
      const bytes = await readFile(resolve(dirname(manifestPath), sourcePath));
      if (createHash("sha256").update(bytes).digest("hex") !== evidence.sourceSha256) {
        throw new Error(`Retirement source hash mismatch for run ${evidence.runId}.`);
      }
      retirementEvidence.push(evidence);
    }
  }
  if (values.apply) {
    const plan = JSON.parse(await readFile(values.plan!, "utf8")) as {
      version?: number; apply?: boolean; companyIds?: string[]; results?: ArchivedExecutionReconciliationResult[];
    };
    if (plan.version !== 1 || plan.apply !== false || !Array.isArray(plan.companyIds) ||
        JSON.stringify([...plan.companyIds].sort()) !== JSON.stringify(companyIds) || !Array.isArray(plan.results) ||
        plan.results.some(result => result.state !== "eligible" || !companyIds.includes(result.companyId ?? "") ||
          !uuid.test(result.runId) || !/^[a-f0-9]{64}$/.test(result.evidenceSha256 ?? ""))) {
      throw new Error("Plan must be a wholly eligible dry-run with the same explicit company scope. Restrict --run and inspect blockers first.");
    }
    const plannedIds = plan.results.map(result => result.runId).sort();
    if (runIds && JSON.stringify([...runIds].sort()) !== JSON.stringify(plannedIds)) {
      throw new Error("Explicit --run scope must exactly match the reviewed plan.");
    }
    runIds = plannedIds;
    expectedEvidence = Object.fromEntries(plan.results.map(result => [result.runId, result.evidenceSha256!]));
  }
  if (!runIds) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      inArray(heartbeatRuns.companyId, companyIds), eq(heartbeatRuns.runtimeMode, "legacy"),
      eq(heartbeatRuns.status, "cancelled"), isNotNull(heartbeatRuns.startedAt),
      isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId),
      isNull(heartbeatRuns.runtimeModeResolvedAt), isNull(heartbeatRuns.controllerBootId),
      sql`coalesce(${heartbeatRuns.executionStage}, '') <> 'settled'`,
      sql`coalesce(${heartbeatRuns.resultJson}->'executionCancellation'->>'state', '') <> 'acknowledged'`,
    )).orderBy(asc(heartbeatRuns.id)).limit(101);
    if (rows.length > 100) throw new Error("More than 100 historical gaps; select an explicit bounded --run scope.");
    runIds = rows.map(row => row.id);
  }
  const results = runIds.length ? await reconcileArchivedCompanyExecutions(db, {
    companyIds, runIds, actorId: values.actor, apply: values.apply, expectedEvidence, retirementEvidence,
  }) : [];
  console.log(JSON.stringify({ version: 1, apply: values.apply, companyIds, results }, null, 2));
  if (results.some(result => result.state === "blocked")) process.exitCode = 2;
} finally {
  await db.$client.end({ timeout: 5 });
}
