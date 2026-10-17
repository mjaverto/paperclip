import { and, eq, isNull, notInArray } from "drizzle-orm";
import { issueRelations, issues, type Db } from "@paperclipai/db";

/** True while an open, visible issue still blocks `issueId` through an explicit `blocks` relation. */
export async function hasExplicitBlockerPath(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const row = await db
    .select({ issueId: issueRelations.issueId })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
        eq(issues.companyId, companyId),
        notInArray(issues.status, ["done", "cancelled"]),
        isNull(issues.hiddenAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}
