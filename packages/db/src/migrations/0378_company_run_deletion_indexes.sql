-- PostgreSQL checks every incoming FK once per deleted heartbeat run, even
-- after this company's referencing rows have been removed. Company-prefixed
-- indexes do not support a lookup by run_id alone: without these indexes,
-- deleting 29k runs repeatedly scans other companies' histories. These are
-- the missing leading FK keys in 0377, not indexes on unrelated workloads.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_retry_of_run_id_idx" ON "heartbeat_runs" ("retry_of_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "budget_reservations_run_id_idx" ON "budget_reservations" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "run_usage_receipts_run_id_idx" ON "run_usage_receipts" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_commentary_run_id_idx" ON "agent_commentary" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_task_sessions_last_run_id_idx" ON "agent_task_sessions" ("last_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "browser_use_runs_heartbeat_run_id_idx" ON "browser_use_runs" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_completion_deliveries_target_run_id_idx" ON "chat_completion_deliveries" ("target_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_github_reviews_run_id_idx" ON "chat_github_reviews" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "company_secret_proposals_origin_run_id_idx" ON "company_secret_proposals" ("origin_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cost_events_heartbeat_run_id_idx" ON "cost_events" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_queue_items_added_by_run_id_idx" ON "decision_queue_items" ("added_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_queues_created_by_run_id_idx" ON "decision_queues" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_retention_archived_by_run_id_idx" ON "decision_retention" ("archived_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_triage_set_by_run_id_idx" ON "decision_triage" ("set_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_triage_events_actor_run_id_idx" ON "decision_triage_events" ("actor_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decision_bundles_origin_run_id_idx" ON "decision_bundles" ("origin_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "decisions_origin_run_id_idx" ON "decisions" ("origin_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_annotation_comments_created_by_run_id_idx" ON "document_annotation_comments" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_revisions_created_by_run_id_idx" ON "document_revisions" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "execution_workspace_runtime_leases_owner_run_id_idx" ON "execution_workspace_runtime_leases" ("owner_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "finance_events_heartbeat_run_id_idx" ON "finance_events" ("heartbeat_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_run_watchdog_decisions_run_id_idx" ON "heartbeat_run_watchdog_decisions" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_run_watchdog_decisions_created_by_run_id_idx" ON "heartbeat_run_watchdog_decisions" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "connection_token_issuances_run_id_idx" ON "connection_token_issuances" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_created_by_run_id_idx" ON "issue_comments" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_derived_created_by_run_id_idx" ON "issue_comments" ("derived_created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_deleted_by_run_id_idx" ON "issue_comments" ("deleted_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_execution_decisions_created_by_run_id_idx" ON "issue_execution_decisions" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_inbox_archives_archived_by_run_id_idx" ON "issue_inbox_archives" ("archived_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_plan_decompositions_owner_run_id_idx" ON "issue_plan_decompositions" ("owner_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_question_response_deliveries_source_run_id_idx" ON "issue_question_response_deliveries" ("source_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_question_response_deliveries_target_run_id_idx" ON "issue_question_response_deliveries" ("target_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_thread_interactions_source_run_id_idx" ON "issue_thread_interactions" ("source_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_thread_interactions_resolved_by_run_id_idx" ON "issue_thread_interactions" ("resolved_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_tree_hold_members_active_run_id_idx" ON "issue_tree_hold_members" ("active_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_tree_holds_created_by_run_id_idx" ON "issue_tree_holds" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_tree_holds_released_by_run_id_idx" ON "issue_tree_holds" ("released_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_watchdogs_created_by_run_id_idx" ON "issue_watchdogs" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_watchdogs_updated_by_run_id_idx" ON "issue_watchdogs" ("updated_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_work_products_created_by_run_id_idx" ON "issue_work_products" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_checkout_run_id_idx" ON "issues" ("checkout_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_execution_run_id_idx" ON "issues" ("execution_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "native_run_finalizations_run_owner_idx" ON "native_run_finalizations" ("company_id", "issue_id", "run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "native_run_results_run_contract_owner_idx" ON "native_run_results" ("company_id", "issue_id", "run_id", "completion_contract_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "routine_revisions_created_by_run_id_idx" ON "routine_revisions" ("created_by_run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "runner_api_response_reservations_run_id_idx" ON "runner_api_response_reservations" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "status_card_updates_run_id_idx" ON "status_card_updates" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_call_events_run_id_idx" ON "tool_call_events" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_gateway_sessions_run_id_idx" ON "tool_gateway_sessions" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_invocations_run_id_idx" ON "tool_invocations" ("run_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workspace_operations_heartbeat_run_id_idx" ON "workspace_operations" ("heartbeat_run_id");
