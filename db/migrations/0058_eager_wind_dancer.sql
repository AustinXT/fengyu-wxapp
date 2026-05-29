CREATE TYPE "public"."lakala_attachment_type" AS ENUM('biz_license', 'id_card_front', 'id_card_back', 'settle_card', 'storefront', 'cashier_desk', 'premises', 'agreement', 'other');--> statement-breakpoint
CREATE TYPE "public"."lakala_contract_status" AS ENUM('draft', 'applied', 'pending_manual_review', 'signed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lakala_log_direction" AS ENUM('outbound', 'inbound_callback');--> statement-breakpoint
CREATE TYPE "public"."lakala_onboarding_status" AS ENUM('draft', 'contract_signing', 'contract_signed', 'attachments_uploading', 'submitted', 'callback_pending', 'approved', 'rejected', 'under_review', 'appealing', 'realname_pending', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lakala_realname_status" AS ENUM('not_submitted', 'submitted', 'success', 'fail', 'modifying');--> statement-breakpoint
CREATE TABLE "lakala_merchant_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"lakala_merchant_id" text NOT NULL,
	"attachment_type" "lakala_attachment_type" NOT NULL,
	"local_url" text NOT NULL,
	"cloud_path" text NOT NULL,
	"attch_id" text,
	"uploaded_to_lakala_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_lakala_attachments_dedupe" UNIQUE("lakala_merchant_id","attachment_type","attch_id")
);
--> statement-breakpoint
CREATE TABLE "lakala_merchant_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lakala_merchant_id" text NOT NULL,
	"direction" "lakala_log_direction" NOT NULL,
	"endpoint" text NOT NULL,
	"req_body" jsonb,
	"resp_body" jsonb,
	"resp_code" text,
	"latency_ms" integer,
	"operator_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lakala_merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"applicant_user_id" integer,
	"merchant_name" text NOT NULL,
	"out_org_code" text NOT NULL,
	"contract_no" text,
	"last_submitted_form_data" jsonb,
	"last_req_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contract_status" "lakala_contract_status" DEFAULT 'draft' NOT NULL,
	"contract_pdf_url" text,
	"merchant_no" text,
	"term_no" text,
	"wx_sub_mchid" text,
	"wx_sub_appid" text,
	"alipay_sub_mchid" text,
	"wx_realname_status" "lakala_realname_status" DEFAULT 'not_submitted' NOT NULL,
	"wx_realname_qrcode_url" text,
	"alipay_realname_status" "lakala_realname_status" DEFAULT 'not_submitted' NOT NULL,
	"alipay_realname_qrcode_url" text,
	"onboarding_status" "lakala_onboarding_status" DEFAULT 'draft' NOT NULL,
	"last_error_code" text,
	"last_error_msg" text,
	"last_callback_at" timestamp,
	"last_query_at" timestamp,
	"form_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lakala_merchants_out_org_code_unique" UNIQUE("out_org_code")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "lakala_merchant_id" text;--> statement-breakpoint
ALTER TABLE "lakala_merchant_attachments" ADD CONSTRAINT "lakala_merchant_attachments_lakala_merchant_id_lakala_merchants_id_fk" FOREIGN KEY ("lakala_merchant_id") REFERENCES "public"."lakala_merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lakala_merchant_logs" ADD CONSTRAINT "lakala_merchant_logs_lakala_merchant_id_lakala_merchants_id_fk" FOREIGN KEY ("lakala_merchant_id") REFERENCES "public"."lakala_merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lakala_merchant_logs" ADD CONSTRAINT "lakala_merchant_logs_operator_user_id_admin_passwords_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."admin_passwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lakala_merchants" ADD CONSTRAINT "lakala_merchants_applicant_user_id_admin_passwords_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."admin_passwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_lakala_attachments_merchant" ON "lakala_merchant_attachments" USING btree ("lakala_merchant_id");--> statement-breakpoint
CREATE INDEX "idx_lakala_logs_merchant_time" ON "lakala_merchant_logs" USING btree ("lakala_merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lakala_merchants_onboarding_status" ON "lakala_merchants" USING btree ("onboarding_status");--> statement-breakpoint
CREATE INDEX "idx_lakala_merchants_merchant_no" ON "lakala_merchants" USING btree ("merchant_no");--> statement-breakpoint
CREATE INDEX "idx_lakala_merchants_applicant_user_id" ON "lakala_merchants" USING btree ("applicant_user_id");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_lakala_merchant_id_lakala_merchants_id_fk" FOREIGN KEY ("lakala_merchant_id") REFERENCES "public"."lakala_merchants"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_stores_lakala_merchant_id" ON "stores" USING btree ("lakala_merchant_id");--> statement-breakpoint

-- ============================================================
-- Legacy 数据搬迁（plan §1.4.1）
--
-- prod 已有手填 lakala_merchant_no（蓝茉店等，[lakala-per-store-merchant]）。
-- 开发阶段虽 [no-legacy-compat]，但 prod 数据不能丢，故 migration 0058 内嵌一次性搬迁：
--   1. 为每个有手填 merchant_no 的 store 造一行 lm_legacy_* 的 lakala_merchants stub
--   2. 把 stores.lakala_merchant_id 指回该 stub
-- UI 列表标注「legacy 入库」，运营按需补全表单/附件后转入正规流程。
--
-- 幂等：ON CONFLICT DO NOTHING（id / out_org_code 双 UNIQUE 都拦得住）。
-- ============================================================

INSERT INTO "lakala_merchants" (
    "id",
    "merchant_name",
    "out_org_code",
    "merchant_no",
    "wx_sub_appid",
    "onboarding_status",
    "contract_status",
    "applicant_user_id",
    "last_req_ids"
)
SELECT
    'lm_legacy_' || "store_id",
    "store_name",
    'legacy-' || "store_id",
    "lakala_merchant_no",
    "lakala_sub_appid",
    'completed',
    'signed',
    NULL,
    '{}'::jsonb
FROM "stores"
WHERE "lakala_merchant_no" IS NOT NULL
ON CONFLICT ("out_org_code") DO NOTHING;--> statement-breakpoint

UPDATE "stores"
SET "lakala_merchant_id" = 'lm_legacy_' || "store_id"
WHERE "lakala_merchant_no" IS NOT NULL
  AND "lakala_merchant_id" IS NULL;