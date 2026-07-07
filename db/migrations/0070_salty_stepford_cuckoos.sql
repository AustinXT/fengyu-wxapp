ALTER TABLE "lakala_merchants" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint


UPDATE "lakala_merchants" lm SET
  "merchant_no" = COALESCE(s."lakala_merchant_no", lm."merchant_no"),
  "term_no"     = COALESCE(s."lakala_term_no", lm."term_no"),
  "enabled"     = s."lakala_enabled"
FROM "stores" s WHERE s."lakala_merchant_id" = lm."id";