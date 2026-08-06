-- Custom SQL migration file, put your code below! --
-- 来源：notes/tickets/2026-04-26-recharge-card-as-sku-flag.md §2.4 / §6 第 3 周
-- 严格独立 D4 兜底：sale_items 中同一 sale_order_id 不能混合 is_recharge_card true / false
--
-- 应用层（admin / staff / client）已加显式校验 + 事务内 bool_and() 双层防护，
-- 本 trigger 是 DB 兜底：跨实现/未来新接入路径漏校验时由 DB 拒绝。
--
-- 选用 CONSTRAINT TRIGGER + DEFERRABLE INITIALLY DEFERRED：
--   - DEFERRED 让校验延后到 COMMIT 时跑，允许事务内多行 INSERT 中间态混合
--   - 单行 trigger 模式即可，不需要 STATEMENT 级（每行 fire，最后一行触发收尾即可）

CREATE OR REPLACE FUNCTION check_no_mixed_recharge() RETURNS trigger AS $$
DECLARE
  has_recharge boolean;
  has_normal boolean;
  target_order varchar(30);
BEGIN
  -- 取出当前正在写入/更新的行所属订单
  IF TG_OP = 'DELETE' THEN
    target_order := OLD.sale_order_id;
  ELSE
    target_order := NEW.sale_order_id;
  END IF;

  SELECT bool_or(is_recharge_card), bool_or(NOT is_recharge_card)
    INTO has_recharge, has_normal
  FROM sale_items
  WHERE sale_order_id = target_order;

  IF has_recharge AND has_normal THEN
    RAISE EXCEPTION 'MIXED_RECHARGE_NOT_ALLOWED: sale_order_id=%', target_order
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER trg_check_no_mixed_recharge
  AFTER INSERT OR UPDATE OF is_recharge_card ON sale_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_no_mixed_recharge();
