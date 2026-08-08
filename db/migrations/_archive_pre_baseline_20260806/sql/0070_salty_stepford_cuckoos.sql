ALTER TABLE "lakala_merchants" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 数据回填：把 stores 的收款快照（merchant_no/term_no/enabled）灌入关联的 lakala_merchants
-- （收款运行时读 stores，故以 stores 值为权威；现状一店一档 1:1，UPDATE FROM 安全）
UPDATE "lakala_merchants" lm SET
  "merchant_no" = COALESCE(s."lakala_merchant_no", lm."merchant_no"),
  "term_no"     = COALESCE(s."lakala_term_no", lm."term_no"),
  "enabled"     = s."lakala_enabled"
FROM "stores" s WHERE s."lakala_merchant_id" = lm."id";