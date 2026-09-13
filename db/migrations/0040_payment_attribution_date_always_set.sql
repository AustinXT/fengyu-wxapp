-- sale_order_payments.performance_attribution_date 恒有值（2026-09-11 需求）。
--
-- 变更前：首次支付行该列 100% 为 NULL（归属事实只落在 sale_orders 上），未入账
-- （已作废 / 待审批）行也为 NULL。任何按款项级列直接筛选 / 分组的报表都会整段丢数据，
-- 只能各自复刻一份 CASE 表达式 —— 口径散落在 admin、staffApi 与视图三处。
--
-- 变更后（写入侧统一由本 trigger 保证）：
--   首次支付        → 恒等于 sale_orders.performance_attribution_date（含人工调整后的值）
--   同次混合支付卡行 → 跟随同次主流水（首次支付 / 回款），沿用 0038 的配对逻辑
--   其余款项        → 自身已有值优先，否则 paid_at 折上海自然日
--   仍取不到        → created_at 折上海自然日（未入账占位，入账时按 paid_at 重算）
--
-- 未加 NOT NULL 约束：约束一旦上线，任何绕过 trigger 的写入路径都会直接 500，
-- 而三端云函数的 INSERT 都不显式带这一列；先靠 trigger 收敛，稳定后再考虑加约束。

CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.change_type = '首次支付' THEN
    -- 首次支付行是订单级归属日期的镜像。调整机会标记（adjusted_at/by）**不**镜像：
    -- 首次支付不可被单独修改，那一次机会始终记在 sale_orders 上。
    SELECT so.performance_attribution_date
      INTO NEW.performance_attribution_date
      FROM sale_orders so
     WHERE so.sale_order_id = NEW.sale_order_id;
  ELSE
    -- 未入账时写下的归属日期只是按 created_at 折的占位值；真正入账那一刻必须按
    -- paid_at 重算，否则待审批回款会永远停在创建日。已人工调整过的不动，
    -- 同一条 UPDATE 里显式改过这一列的也不动。
    IF TG_OP = 'UPDATE'
       AND OLD.paid_at IS NULL
       AND NEW.paid_at IS NOT NULL
       AND NEW.performance_attribution_adjusted_at IS NULL
       AND NEW.performance_attribution_date IS NOT DISTINCT FROM OLD.performance_attribution_date THEN
      NEW.performance_attribution_date := NULL;
    END IF;

    IF NEW.performance_attribution_date IS NULL THEN
      IF NEW.change_type = '储值卡抵扣' THEN
        SELECT
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_date
            ELSE COALESCE(
              primary_payment.performance_attribution_date,
              (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
              (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
            )
          END,
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_at
            ELSE primary_payment.performance_attribution_adjusted_at
          END,
          CASE
            WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_by
            ELSE primary_payment.performance_attribution_adjusted_by
          END
        INTO
          NEW.performance_attribution_date,
          NEW.performance_attribution_adjusted_at,
          NEW.performance_attribution_adjusted_by
        FROM sale_order_payments primary_payment
        JOIN sale_orders so ON so.sale_order_id = primary_payment.sale_order_id
        WHERE primary_payment.sale_order_id = NEW.sale_order_id
          AND primary_payment.change_type IN ('首次支付', '回款')
          AND primary_payment.status = NEW.status
          AND primary_payment.paid_at IS NOT DISTINCT FROM NEW.paid_at
        ORDER BY
          CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
          primary_payment.id
        LIMIT 1;
      END IF;

      IF NEW.performance_attribution_date IS NULL THEN
        NEW.performance_attribution_date :=
          (COALESCE(NEW.paid_at, NEW.created_at, NOW()) AT TIME ZONE 'Asia/Shanghai')::date;
      END IF;
    END IF;
  END IF;

  -- staff 线下确认会先写卡流水、后写现付主流水；主流水后写时反向同步，保证写入顺序无关。
  -- 首次支付分支不再从 sale_orders 二次取值：上面的镜像已经把它写进 NEW。
  IF NEW.change_type IN ('首次支付', '回款')
     AND NEW.status = '已支付'
     AND NEW.paid_at IS NOT NULL THEN
    UPDATE sale_order_payments card
    SET performance_attribution_date = NEW.performance_attribution_date,
        performance_attribution_adjusted_at = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_at
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_at
        END,
        performance_attribution_adjusted_by = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_by
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_by
        END
    WHERE card.sale_order_id = NEW.sale_order_id
      AND card.change_type = '储值卡抵扣'
      AND card.status = NEW.status
      AND card.paid_at IS NOT DISTINCT FROM NEW.paid_at;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 回填①：首次支付行对齐订单级。
-- 会触发上面的 trigger（UPDATE OF performance_attribution_date），重新取同一个值，幂等。
UPDATE sale_order_payments p
SET performance_attribution_date = so.performance_attribution_date
FROM sale_orders so
WHERE so.sale_order_id = p.sale_order_id
  AND p.change_type = '首次支付'
  AND p.performance_attribution_date IS DISTINCT FROM so.performance_attribution_date;--> statement-breakpoint

-- 回填②：其余缺失行（已作废 / 待审批的回款与退款）按 paid_at → created_at 兜底。
UPDATE sale_order_payments p
SET performance_attribution_date =
      (COALESCE(p.paid_at, p.created_at) AT TIME ZONE 'Asia/Shanghai')::date
WHERE p.change_type <> '首次支付'
  AND p.performance_attribution_date IS NULL;
