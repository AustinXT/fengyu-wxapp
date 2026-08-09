CREATE TABLE "admin_export_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"requested_by_employee_id" varchar(30) NOT NULL,
	"requested_by_name" text NOT NULL,
	"export_type" varchar(80) NOT NULL,
	"permission_action" varchar(80) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"scope_snapshot" jsonb NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"progress_rows" integer DEFAULT 0 NOT NULL,
	"row_count" integer,
	"sheet_count" integer,
	"file_cloud_path" text,
	"file_name" text,
	"error_code" varchar(80),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_admin_export_job_status" CHECK ("admin_export_jobs"."status" IN ('queued', 'running', 'ready', 'empty', 'failed', 'expired')),
	CONSTRAINT "chk_admin_export_job_attempt_count" CHECK ("admin_export_jobs"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_admin_export_jobs_claim" ON "admin_export_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_export_jobs_owner" ON "admin_export_jobs" USING btree ("requested_by_employee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_admin_export_jobs_expiry" ON "admin_export_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_export_jobs_active_request" ON "admin_export_jobs" USING btree ("requested_by_employee_id","request_hash") WHERE "admin_export_jobs"."status" IN ('queued', 'running');