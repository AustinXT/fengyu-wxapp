-- #341 提货时冻结顾客实际单价与出库金额（店长产品出库提成的数据来源）。
-- 两列可空：上线前的历史提货记录不回填（用户拍板 Q4=B），测试夹具的旧式 INSERT 也照常可用。
-- CHECK：两列同生同灭，且金额 = ROUND(冻结单价 × 提货数量, 2)，写入端算错直接被拒；
-- 第二支显式要求 amount IS NOT NULL，否则「只写单价」时 `=` 得 UNKNOWN 会被 CHECK 放行。
-- ADD COLUMN ×2 + ADD CONSTRAINT（全表校验，存量行均为双 NULL）取 pickup_records 的 ACCESS EXCLUSIVE，
-- 且持有到整批迁移提交（drizzle 单事务）。3 秒拿不到锁就放弃（与 0041 / 0042 / 0051 / 0053 同构），
-- 不让锁队列把提货 / 提货记录列表 / 导出堵住。
-- 兜底 trigger（BEFORE INSERT）：写入端没带冻结列（两列都为 NULL）时，按 sale_items.unit_real_price 补齐。
--   覆盖两类情形：① 发版空档里尚未升级的 staffApi / admin 用旧 INSERT 写入——否则这些行两列为 NULL，
--   与「上线前历史行」无法区分，店长提成会静默漏算；② 将来新增的写入口忘了接冻结金额。
--   提货事务已对该 sale_items 行 FOR UPDATE，trigger 读到的就是锁内单价，与应用层冻结值同源。
--   只作用于 INSERT：存量历史行不回填（拍板 Q4=B）。应用层仍显式写两列，CHECK 校验两者一致。
-- ⚠ 上线顺序：先迁本迁移，再发 admin 与 staffApi —— 未迁库时新代码写新列报 42703（提货全挂）。
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "pickup_records" ADD COLUMN "pickup_unit_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pickup_records" ADD COLUMN "pickup_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "chk_pickup_amount_frozen" CHECK (("pickup_records"."pickup_unit_price" IS NULL AND "pickup_records"."pickup_amount" IS NULL) OR ("pickup_records"."pickup_unit_price" IS NOT NULL AND "pickup_records"."pickup_amount" IS NOT NULL AND "pickup_records"."pickup_amount" = ROUND("pickup_records"."pickup_unit_price" * "pickup_records"."pickup_quantity", 2)));--> statement-breakpoint
CREATE OR REPLACE FUNCTION pickup_records_fill_frozen_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pickup_unit_price IS NULL AND NEW.pickup_amount IS NULL THEN
    SELECT si.unit_real_price INTO NEW.pickup_unit_price
      FROM sale_items si
     WHERE si.sale_item_id = NEW.sale_item_id;
    -- 明细不存在时单价仍为 NULL → 金额 NULL，随后由 sale_item_id 外键拒绝，不会写出半截数据
    NEW.pickup_amount := ROUND(NEW.pickup_unit_price * NEW.pickup_quantity, 2);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER trg_pickup_records_fill_frozen_amount
BEFORE INSERT ON pickup_records
FOR EACH ROW EXECUTE FUNCTION pickup_records_fill_frozen_amount();
