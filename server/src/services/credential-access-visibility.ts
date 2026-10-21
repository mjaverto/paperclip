import { sql } from "drizzle-orm";
import { connectionGrants, connectionGrantMembers, heartbeatRuns } from "@paperclipai/db";

/** Diagnostic names are visible to the affected user and the human grant audience.
 * Callers obtain viewer identity from authentication, never request parameters.
 * The grant reference stays in storage and never enters the response. */
export function credentialAccessConnectionNameSql(viewerUserId: string | null) {
  // No viewer can never see a name: skip the result_json read entirely.
  if (viewerUserId === null) return sql<string | null>`null::text`;
  // Cheap row-level tests come first so most rows never detoast result_json.
  // Only a failed `configuration_incomplete` run carries credentialAccess.
  return sql<string | null>`case when ${heartbeatRuns.status} = 'failed'
  and ${heartbeatRuns.errorCode} = 'configuration_incomplete'
  and jsonb_typeof(${heartbeatRuns.resultJson} #> '{configurationIncomplete,credentialAccess,connectionName}') = 'string'
  and (${heartbeatRuns.responsibleUserId} = ${viewerUserId}
    or exists (
      select 1 from ${connectionGrants}
      where ${connectionGrants.companyId} = ${heartbeatRuns.companyId}
        and ${connectionGrants.id}::text = ${heartbeatRuns.resultJson} #>> '{configurationIncomplete,credentialAccess,grantId}'
        and ((${connectionGrants.kind} = 'user' and ${connectionGrants.subjectUserId} = ${viewerUserId})
          or (${connectionGrants.kind} = 'organization' and (
            not exists (select 1 from ${connectionGrantMembers}
              where ${connectionGrantMembers.companyId} = ${connectionGrants.companyId}
                and ${connectionGrantMembers.grantId} = ${connectionGrants.id})
            or exists (select 1 from ${connectionGrantMembers}
              where ${connectionGrantMembers.companyId} = ${connectionGrants.companyId}
                and ${connectionGrantMembers.grantId} = ${connectionGrants.id}
                and ${connectionGrantMembers.subjectType} = 'user'
                and ${connectionGrantMembers.subjectId} = ${viewerUserId})
          )))
    ))
  then left(${heartbeatRuns.resultJson} #>> '{configurationIncomplete,credentialAccess,connectionName}', 240) end`;
}
