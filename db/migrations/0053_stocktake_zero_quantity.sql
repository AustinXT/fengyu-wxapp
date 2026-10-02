-- #351 盘点单实盘数允许 0：CHECK 放宽为 >= 0，非盘点类型「> 0」改由 trigger 兜底。
-- DROP/ADD CONSTRAINT 取 inventory_doc_items 的 ACCESS EXCLUSIVE（ADD 全表校验），CREATE TRIGGER 取
-- SHARE ROW EXCLUSIVE，且都持有到整批迁移提交 —— drizzle 把所有待应用迁移放进同一个事务。
-- 3 秒拿不到锁就放弃（与 0041 / 0042 / 0051 同构），不让锁队列把建单/收货堵住。
-- ⚠ 必须单事务执行（drizzle migrate 即是）：若按 breakpoint 逐条自动提交，DROP 与 ADD 之间负数可写入、
--   ADD 与 CREATE TRIGGER 之间非盘点 0 可写入。
-- 约束名复用：trigger 报错沿用 chk_inventory_doc_items_qty（CHECK 文本是 >= 0，报错文案写「must be > 0」），
--   是有意让既有 23514 + 约束名的处理路径不变；排障时两边文案不一致属预期。
-- ⚠ 上线顺序：先迁本迁移、再发 admin / staffApi —— 未迁库时盘点 0 会被旧 CHECK 以 23514 拒掉。
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "inventory_doc_items" DROP CONSTRAINT "chk_inventory_doc_items_qty";--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "chk_inventory_doc_items_qty" CHECK ("inventory_doc_items"."quantity" >= 0);--> statement-breakpoint
-- ↓ 以下为手工追加（#351），drizzle-kit 生成部分在上方两行，未改动。
-- CHECK 放宽后，非盘点类型「数量必须 > 0」由下面的 trigger 兜底（inventory_doc_items 没有 doc_type 列，
-- 只能按 doc_id 回查单头）。独立函数，不改 0049 的 inventory_set_doc_item_amount。
-- 报错沿用 check_violation(23514) + 原约束名，调用方对 CHECK 失败的既有处理不变。
CREATE OR REPLACE FUNCTION inventory_assert_doc_item_quantity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_doc_type text;
BEGIN
  -- NULL 交给 NOT NULL 报 23502，这里不抢着报 check_violation
  IF NEW.quantity IS NULL THEN
    RETURN NEW;
  END IF;
  -- numeric 的 'NaN' 在 PG 里大于一切有限数：不先拦，`> 0` 会放它过去（两端 Number.isFinite 本就拒它）
  IF NEW.quantity = 'NaN'::numeric THEN
    RAISE EXCEPTION 'inventory_doc_items.quantity must be a finite number (doc %)', NEW.doc_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_inventory_doc_items_qty';
  END IF;
  IF NEW.quantity > 0 THEN
    RETURN NEW;
  END IF;
  SELECT doc_type INTO item_doc_type FROM inventory_docs WHERE id = NEW.doc_id;
  -- 单头不存在交给 FK 报 23503（FK 在语句末尾才校验，BEFORE trigger 先跑，不放行会报成误导的 23514）
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF item_doc_type IN ('市场库存盘点', '分院库存盘点') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'inventory_doc_items.quantity must be > 0 for doc_type % (doc %)', item_doc_type, NEW.doc_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_inventory_doc_items_qty';
END;
$$;--> statement-breakpoint
CREATE TRIGGER trg_inventory_doc_items_assert_quantity
BEFORE INSERT OR UPDATE OF doc_id, quantity
ON inventory_doc_items
FOR EACH ROW EXECUTE FUNCTION inventory_assert_doc_item_quantity();
-- 单头改 doc_type（盘点单改成非盘点单绕过行级 trigger）的口子已由 inventory_validate_doc_lifecycle
-- 「库存单据创建后禁止修改单据类型」堵住，这里不再另加 trigger。
