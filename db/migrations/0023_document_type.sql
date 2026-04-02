-- sale_orders: 添加销售单据类型字段
-- 售前：顾客非会员客 且 订单金额 < new_member_threshold
-- 售后：顾客是会员客 或 订单金额 >= new_member_threshold
CREATE TYPE document_type AS ENUM ('售前', '售后');
ALTER TABLE sale_orders ADD COLUMN document_type document_type;

-- 回填主单（普通/体验/内部/福利活动）
WITH threshold AS (
  SELECT COALESCE(
    (SELECT value::numeric FROM system_configs WHERE key = 'new_member_threshold'),
    1990
  ) AS val
)
UPDATE sale_orders so
SET document_type = CASE
  WHEN EXISTS (
    SELECT 1 FROM client_wechat_users c
    WHERE c.user_id = so.client_user_id
      AND c.customer_type = '会员客'
  ) THEN '售后'::document_type
  WHEN so.total_amount::numeric >= (SELECT val FROM threshold)
    THEN '售后'::document_type
  ELSE '售前'::document_type
END
WHERE so.sale_order_type IN ('普通', '体验', '内部', '福利活动');

-- 回填引用单（回款/转换/退款）：继承原单
UPDATE sale_orders so
SET document_type = ref.document_type
FROM sale_orders ref
WHERE so.ref_sale_order_id = ref.sale_order_id
  AND so.sale_order_type IN ('回款', '转换', '退款')
  AND so.document_type IS NULL
  AND ref.document_type IS NOT NULL;

-- 兜底：无引用关系的异常数据
UPDATE sale_orders
SET document_type = '售前'::document_type
WHERE document_type IS NULL;
