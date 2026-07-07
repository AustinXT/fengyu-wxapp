










CREATE OR REPLACE FUNCTION check_no_mixed_recharge() RETURNS trigger AS $$
DECLARE
  has_recharge boolean;
  has_normal boolean;
  target_order varchar(30);
BEGIN

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
