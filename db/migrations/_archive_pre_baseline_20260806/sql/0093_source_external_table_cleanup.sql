-- Remove production-only tables that are absent from db/schema.
DROP TABLE IF EXISTS "lakala_onboarding_request_logs";
--> statement-breakpoint
DROP TABLE IF EXISTS "lakala_onboarding_attachments";
--> statement-breakpoint
DROP TABLE IF EXISTS "lakala_onboarding_applications";
--> statement-breakpoint
DROP TABLE IF EXISTS "codex_service_completed_at_backup_20260716";
--> statement-breakpoint
DROP TABLE IF EXISTS "codex_service_commission_status_backup_20260716";
--> statement-breakpoint
DROP TABLE IF EXISTS "codex_service_unlock_backup_20260715";
