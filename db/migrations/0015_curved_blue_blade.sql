CREATE TABLE "lakala_onboarding_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"store_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"merchant_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legal_person_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settlement_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shop_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terminal_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fee_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lakala_request_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"e_contract_order_no" text,
	"e_contract_apply_id" text,
	"e_contract_result_url" text,
	"e_contract_no" text,
	"e_contract_status" text,
	"e_contract_signed_at" timestamp with time zone,
	"contract_id" text,
	"mer_inner_no" text,
	"mer_cup_no" text,
	"channel_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sub_merchant_checked_at" timestamp with time zone,
	"lakala_merchant_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"submitted_at" timestamp with time zone,
	"created_by" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lakala_onboarding_applications_order_no_unique" UNIQUE("order_no")
);
--> statement-breakpoint
CREATE TABLE "lakala_onboarding_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"att_type" text NOT NULL,
	"display_name" text NOT NULL,
	"local_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_ext" text,
	"file_size" text NOT NULL,
	"mime_type" text,
	"status" text DEFAULT 'LOCAL_SAVED' NOT NULL,
	"att_file_id" text,
	"lakala_file_url" text,
	"lakala_show_url" text,
	"lakala_batch_no" text,
	"lakala_ocr_status" text,
	"uploaded_to_lakala_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lakala_onboarding_request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text,
	"api_name" text NOT NULL,
	"request_id" text NOT NULL,
	"request_payload_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lakala_onboarding_applications" ADD CONSTRAINT "lakala_onboarding_applications_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lakala_onboarding_attachments" ADD CONSTRAINT "lakala_onboarding_attachments_application_id_lakala_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."lakala_onboarding_applications"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lakala_onboarding_request_logs" ADD CONSTRAINT "lakala_onboarding_request_logs_application_id_lakala_onboarding_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."lakala_onboarding_applications"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_store_id" ON "lakala_onboarding_applications" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_status" ON "lakala_onboarding_applications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_onboarding_active_store" ON "lakala_onboarding_applications" USING btree ("store_id") WHERE "lakala_onboarding_applications"."status" NOT IN ('SUCCESS', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_attachments_app" ON "lakala_onboarding_attachments" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_attachments_display" ON "lakala_onboarding_attachments" USING btree ("application_id","display_name");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_logs_app" ON "lakala_onboarding_request_logs" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_lakala_onboarding_logs_api" ON "lakala_onboarding_request_logs" USING btree ("api_name");