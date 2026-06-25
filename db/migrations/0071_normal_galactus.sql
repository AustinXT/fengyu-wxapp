ALTER TABLE "lakala_merchant_attachments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lakala_merchant_logs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "lakala_merchant_attachments" CASCADE;--> statement-breakpoint
DROP TABLE "lakala_merchant_logs" CASCADE;--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP CONSTRAINT "lakala_merchants_out_org_code_unique";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP CONSTRAINT "lakala_merchants_applicant_user_id_admin_passwords_id_fk";
--> statement-breakpoint
DROP INDEX "idx_lakala_merchants_onboarding_status";--> statement-breakpoint
DROP INDEX "idx_lakala_merchants_applicant_user_id";--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "lakala_merchant_no";--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "lakala_term_no";--> statement-breakpoint
ALTER TABLE "stores" DROP COLUMN "lakala_enabled";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "applicant_user_id";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "out_org_code";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "contract_no";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_submitted_form_data";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_req_ids";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "contract_status";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "contract_pdf_url";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "wx_sub_mchid";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "wx_sub_appid";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "alipay_sub_mchid";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "wx_realname_status";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "wx_realname_qrcode_url";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "alipay_realname_status";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "alipay_realname_qrcode_url";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "onboarding_status";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_error_code";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_error_msg";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_callback_at";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "last_query_at";--> statement-breakpoint
ALTER TABLE "lakala_merchants" DROP COLUMN "form_data";--> statement-breakpoint
DROP TYPE "public"."lakala_attachment_type";--> statement-breakpoint
DROP TYPE "public"."lakala_contract_status";--> statement-breakpoint
DROP TYPE "public"."lakala_log_direction";--> statement-breakpoint
DROP TYPE "public"."lakala_onboarding_status";--> statement-breakpoint
DROP TYPE "public"."lakala_realname_status";