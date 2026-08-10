CREATE TABLE "lakala_onboarding_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"application_no" text NOT NULL,
	"store_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"merchant_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legal_person_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settlement_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shop_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terminal_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fee_policy_version" text,
	"e_contract_order_no" text,
	"e_contract_apply_id" text,
	"e_contract_no" text,
	"e_contract_status" text,
	"e_contract_signed_at" timestamp (3) with time zone,
	"contract_id" text,
	"mer_inner_no" text,
	"mer_cup_no" text,
	"channel_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sub_merchant_checked_at" timestamp (3) with time zone,
	"lakala_merchant_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"submitted_at" timestamp (3) with time zone,
	"created_by_employee_id" varchar(30),
	"created_by_name" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_lakala_onboarding_application_status" CHECK ("lakala_onboarding_applications"."status" IN ('DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'SUBMITTING', 'SUBMITTED', 'REGISTERING', 'SUCCESS', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "lakala_onboarding_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"attachment_type" text NOT NULL,
	"display_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_ext" varchar(20),
	"file_size_bytes" integer NOT NULL,
	"content_type" varchar(255),
	"content_sha256" varchar(64) NOT NULL,
	"status" text DEFAULT 'LOCAL_SAVED' NOT NULL,
	"lakala_file_id" text,
	"lakala_file_reference" text,
	"lakala_batch_no" text,
	"lakala_ocr_status" text,
	"uploaded_to_lakala_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_lakala_onboarding_attachment_file_size" CHECK ("lakala_onboarding_attachments"."file_size_bytes" > 0),
	CONSTRAINT "chk_lakala_onboarding_attachment_storage_key" CHECK (length("lakala_onboarding_attachments"."storage_key") > 0),
	CONSTRAINT "chk_lakala_onboarding_attachment_sha256" CHECK ("lakala_onboarding_attachments"."content_sha256" ~ '^[A-Fa-f0-9]{64}$'),
	CONSTRAINT "chk_lakala_onboarding_attachment_status" CHECK ("lakala_onboarding_attachments"."status" IN ('LOCAL_SAVED', 'UPLOADING', 'UPLOADED', 'EXPIRED', 'FAILED', 'DELETED'))
);
--> statement-breakpoint
CREATE TABLE "lakala_onboarding_request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text,
	"api_name" text NOT NULL,
	"request_id" text NOT NULL,
	"idempotency_key" text,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"request_payload_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"http_status" integer,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"external_request_id" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "chk_lakala_onboarding_request_log_attempt" CHECK ("lakala_onboarding_request_logs"."attempt_no" > 0),
	CONSTRAINT "chk_lakala_onboarding_request_log_status" CHECK ("lakala_onboarding_request_logs"."status" IN ('PENDING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "lakala_onboarding_applications" ADD CONSTRAINT "lakala_onboarding_applications_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lakala_onboarding_applications" ADD CONSTRAINT "lakala_onboarding_applications_lakala_merchant_id_lakala_merchants_id_fk" FOREIGN KEY ("lakala_merchant_id") REFERENCES "public"."lakala_merchants"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lakala_onboarding_attachments" ADD CONSTRAINT "lakala_onboarding_attachments_application_id_lakala_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."lakala_onboarding_applications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lakala_onboarding_request_logs" ADD CONSTRAINT "lakala_onboarding_request_logs_application_id_lakala_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."lakala_onboarding_applications"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_application_no" ON "lakala_onboarding_applications" USING btree ("application_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_active_store" ON "lakala_onboarding_applications" USING btree ("store_id") WHERE "lakala_onboarding_applications"."status" NOT IN ('SUCCESS', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_mer_cup_no" ON "lakala_onboarding_applications" USING btree ("mer_cup_no") WHERE "lakala_onboarding_applications"."mer_cup_no" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_econtract_order_no" ON "lakala_onboarding_applications" USING btree ("e_contract_order_no") WHERE "lakala_onboarding_applications"."e_contract_order_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_store_updated_at" ON "lakala_onboarding_applications" USING btree ("store_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_status_updated_at" ON "lakala_onboarding_applications" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_submerchant_poll" ON "lakala_onboarding_applications" USING btree ("status","sub_merchant_checked_at") WHERE "lakala_onboarding_applications"."status" = 'SUCCESS' AND "lakala_onboarding_applications"."mer_cup_no" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_attachment_storage_key" ON "lakala_onboarding_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_attachment_application" ON "lakala_onboarding_attachments" USING btree ("application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_attachment_type" ON "lakala_onboarding_attachments" USING btree ("application_id","attachment_type");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_attachment_status" ON "lakala_onboarding_attachments" USING btree ("application_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_request_log_request_id" ON "lakala_onboarding_request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_request_log_idempotency_attempt" ON "lakala_onboarding_request_logs" USING btree ("application_id","api_name","idempotency_key","attempt_no") WHERE "lakala_onboarding_request_logs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_request_log_application" ON "lakala_onboarding_request_logs" USING btree ("application_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_request_log_api" ON "lakala_onboarding_request_logs" USING btree ("api_name","started_at" DESC NULLS LAST);