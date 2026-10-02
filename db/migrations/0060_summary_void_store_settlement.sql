-- #356 汇总作废 + #364 本店货款结算权限；由真实 db:migrate 整批事务执行。
-- 限制锁等待，失败时触发函数、权限定义、镜像与 journal 一并回滚。
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint

-- 沿用 0043 的其它状态转换，仅允许零履约、无活跃采购引用的汇总作废。
CREATE OR REPLACE FUNCTION inventory_validate_doc_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = '待收货' AND NEW.doc_type NOT IN (
    '采购订单', '品项公司发货', '分院配货', '分院调货出库', '市场间调货出库'
  ) THEN
    RAISE EXCEPTION '单据类型 % 不支持待收货状态', NEW.doc_type;
  END IF;
  IF NEW.status = '待审批' AND NEW.doc_type NOT IN (
    '市场退货', '院退货', '市场产品报损', '院产品报损', '品项公司发货'
  ) THEN
    RAISE EXCEPTION '单据类型 % 不支持待审批状态', NEW.doc_type;
  END IF;
  IF NEW.status = '已驳回' AND NEW.doc_type NOT IN (
    '市场退货', '院退货', '市场产品报损', '院产品报损', '品项公司发货'
  ) THEN
    RAISE EXCEPTION '单据类型 % 不支持已驳回状态', NEW.doc_type;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.doc_type <> OLD.doc_type THEN
      RAISE EXCEPTION '库存单据创建后禁止修改单据类型';
    END IF;
    IF NEW.doc_type = '市场报货汇总' AND OLD.status = '已完成' AND NEW.status = '已取消' THEN
      IF NULLIF(BTRIM(NEW.cancellation_reason), '') IS NULL THEN
        RAISE EXCEPTION '市场报货汇总作废原因不能为空';
      END IF;
      IF EXISTS (
        SELECT 1 FROM inventory_doc_links link
          JOIN inventory_docs purchase ON purchase.id = link.to_doc_id
         WHERE link.from_doc_id = OLD.id
           AND link.relation_type = '报货汇总采购订单'
           AND purchase.doc_type = '采购订单' AND purchase.status <> '已取消'
      ) THEN
        RAISE EXCEPTION '市场报货汇总已被未取消的采购订单引用，不能作废';
      END IF;
      IF EXISTS (
        SELECT 1 FROM inventory_doc_items item
         WHERE item.doc_id = OLD.id AND item.fulfilled_quantity > 0
      ) THEN
        RAISE EXCEPTION '市场报货汇总已有履约数量，不能作废';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = '草稿' AND NEW.status IN ('待审批', '待收货', '已完成', '已取消'))
      OR (OLD.status = '待审批' AND NEW.status IN ('已完成', '已驳回', '待收货', '已取消'))
      OR (OLD.status = '待收货' AND NEW.status IN ('待审批', '已完成', '已取消'))
      OR (NEW.doc_type = '市场报货汇总' AND OLD.status = '已完成' AND NEW.status = '已取消')
    ) THEN
      RAISE EXCEPTION '非法库存单据状态转换：% -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

-- 保留既有结算入口：超管、manager，以及同角色持库存列表与金额档的定义。
-- 不授予额外库存/价格动作，不改变 allowed_scope_types；动作去重排序。
UPDATE permission_role_definitions
   SET actions = ARRAY(
         SELECT DISTINCT action
           FROM unnest(actions || ARRAY['inventory:store_settlement_view']::text[]) AS granted(action)
          ORDER BY action
       ),
       updated_at = NOW(),
       updated_by = 'migration:0060_summary_void_store_settlement'
 WHERE (
         is_super_admin
         OR role_key = 'manager'
         OR (
           actions @> ARRAY['inventory:list']::text[]
           AND actions && ARRAY['inventory:supply_chain_price_view', 'inventory:market_price_view']::text[]
         )
       )
   AND NOT (actions @> ARRAY['inventory:store_settlement_view']::text[]);
--> statement-breakpoint

-- 与应用角色编辑使用同一镜像锁；锁与刷新分为两条语句，取锁后才读新快照。
SELECT pg_advisory_xact_lock(hashtext('permission_matrix:mirror')::bigint);
INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;
