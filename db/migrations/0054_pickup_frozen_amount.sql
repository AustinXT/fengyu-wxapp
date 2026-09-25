-- #341 提货时冻结顾客实际单价与出库金额（店长产品出库提成的数据来源）。
-- 两列可空：上线前的历史提货记录不回填（用户拍板 Q4=B），测试夹具的旧式 INSERT 也照常可用。
-- CHECK：两列同生同灭，且金额 = ROUND(冻结单价 × 提货数量, 2)，写入端算错直接被拒；
-- 第二支显式要求 amount IS NOT NULL，否则「只写单价」时 `=` 得 UNKNOWN 会被 CHECK 放行。
ALTER TABLE "pickup_records" ADD COLUMN "pickup_unit_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pickup_records" ADD COLUMN "pickup_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "chk_pickup_amount_frozen" CHECK (("pickup_records"."pickup_unit_price" IS NULL AND "pickup_records"."pickup_amount" IS NULL) OR ("pickup_records"."pickup_unit_price" IS NOT NULL AND "pickup_records"."pickup_amount" IS NOT NULL AND "pickup_records"."pickup_amount" = ROUND("pickup_records"."pickup_unit_price" * "pickup_records"."pickup_quantity", 2)));