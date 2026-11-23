-- paperclip:migration-compat requires_staging: shipped in the 2026-11-22 upstream sync; the previous fork release (a8115cb300) is stopped and replaced in one deploy, so no old-release writer runs while this migration holds its locks or reshapes data.
ALTER TABLE "projects" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "projects" p
SET "environment_id" = e."id", "execution_workspace_policy" = p."execution_workspace_policy" - 'environmentId'
FROM "environments" e
WHERE lower(p."execution_workspace_policy" ->> 'environmentId') = e."id"::text;
