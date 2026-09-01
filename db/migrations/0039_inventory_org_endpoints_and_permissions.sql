ALTER TABLE "inventory_docs" RENAME COLUMN "source_location_id" TO "source_org_node_id";--> statement-breakpoint
ALTER TABLE "inventory_docs" RENAME COLUMN "target_location_id" TO "target_org_node_id";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "chk_inventory_docs_location_pair";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "chk_inventory_docs_type";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "inventory_docs_source_location_id_inventory_locations_location_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "inventory_docs_target_location_id_inventory_locations_location_id_fk";
--> statement-breakpoint
DROP INDEX "idx_inventory_docs_source";--> statement-breakpoint
DROP INDEX "idx_inventory_docs_target";--> statement-breakpoint
DROP INDEX "idx_inventory_locations_org";--> statement-breakpoint
ALTER TABLE "permission_role_definitions" ADD COLUMN "allowed_scope_types" text[] DEFAULT ARRAY['总部','市场','门店']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD COLUMN "market_purchase_price_mode" text;--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD COLUMN "market_purchase_price_override_reason" text;--> statement-breakpoint
-- 顺序经手工调整：被 FK 引用的列必须先建唯一索引（drizzle-kit 默认把 ADD FK 排在 CREATE UNIQUE INDEX 之前，空库按序执行会报
-- "there is no unique constraint matching given keys"；与归档 0023 同类的语句级重排）。
CREATE UNIQUE INDEX "uq_inventory_locations_org" ON "inventory_locations" USING btree ("org_node_id");--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_source_org_node_id_inventory_locations_org_node_id_fk" FOREIGN KEY ("source_org_node_id") REFERENCES "public"."inventory_locations"("org_node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_target_org_node_id_inventory_locations_org_node_id_fk" FOREIGN KEY ("target_org_node_id") REFERENCES "public"."inventory_locations"("org_node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_source_org_node" ON "inventory_docs" USING btree ("source_org_node_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_target_org_node" ON "inventory_docs" USING btree ("target_org_node_id");--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_org_endpoint" CHECK ("inventory_docs"."source_org_node_id" IS NOT NULL OR "inventory_docs"."target_org_node_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_type" CHECK ("inventory_docs"."doc_type" IN (
        '门店报货','市场报货','品项公司报货需求','采购订单','供应链采购订单',
        '供应链采购入库','品项公司发货','市场采购入库','自采产品入库','分院配货',
        '院入库','分院调货出库','分院调货入库','市场间调货出库','市场间调货入库',
        '员工购出库','供应链员工购出库','内部领用','非凤御市场出库','市场退货','市场退货入库',
        '供应链退货入库','院退货','院顾客产品出库','院顾客退货','市场产品报损',
        '院产品报损','市场产品盘溢','市场库存盘点','分院库存盘点','库存转换出库',
        '库存转换入库','期初库存'
      ));--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "chk_inventory_skus_market_price_mode" CHECK ((
        "inventory_skus"."source_type" = '供应链'
        AND "inventory_skus"."market_purchase_price_mode" IN ('公式','手工覆盖')
      ) OR (
        "inventory_skus"."source_type" <> '供应链'
        AND "inventory_skus"."market_purchase_price_mode" IS NULL
        AND "inventory_skus"."market_purchase_price_override_reason" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "chk_inventory_skus_market_price_override" CHECK ("inventory_skus"."market_purchase_price_mode" <> '手工覆盖'
        OR (
          "inventory_skus"."market_purchase_price" IS NOT NULL
          AND NULLIF(BTRIM("inventory_skus"."market_purchase_price_override_reason"), '') IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "chk_inventory_skus_market_price_formula" CHECK ("inventory_skus"."market_purchase_price_mode" <> '公式'
        OR (
          "inventory_skus"."market_purchase_price_override_reason" IS NULL
          AND (
            "inventory_skus"."accounting_price" IS NULL
            OR "inventory_skus"."market_purchase_discount" IS NULL
            OR "inventory_skus"."market_purchase_price" = ROUND(
              "inventory_skus"."accounting_price" * CASE
                WHEN "inventory_skus"."market_purchase_discount" > 1
                  THEN "inventory_skus"."market_purchase_discount" / 100
                ELSE "inventory_skus"."market_purchase_discount"
              END,
              2
            )
          )
        ));

-- ====================================================================
-- 以下为手写追加段（db/CLAUDE.md 末尾追加模式）：
-- 由 dev 线旧 0037_bright_the_liberteens / 0038_mixed_stellaris /
-- 0040_inventory_doc_org_endpoints / 0041_repair_performance_attribution_audit_marker
-- 重排合并而来（这些旧 migration 从未 apply 到任何库；prod/test 已应用 main 序列至 0038）。
-- 已剔除被 0040 最终版取代的 market_id 过渡函数段（引用 RENAME 前的 location_id 列名）。
-- ====================================================================

-- 供应链 SKU 历史价分流：公式一致的继续使用公式，其余保留现值并标记手工覆盖。
UPDATE inventory_skus
   SET market_purchase_price = CASE
         WHEN market_purchase_price IS NULL
          AND accounting_price IS NOT NULL
          AND market_purchase_discount IS NOT NULL
         THEN ROUND(accounting_price * CASE
           WHEN market_purchase_discount > 1 THEN market_purchase_discount / 100
           ELSE market_purchase_discount
         END, 2)
         ELSE market_purchase_price
       END,
       market_purchase_price_mode = CASE
         WHEN market_purchase_price IS NULL THEN '公式'
         WHEN accounting_price IS NOT NULL
          AND market_purchase_discount IS NOT NULL
          AND market_purchase_price = ROUND(accounting_price * CASE
            WHEN market_purchase_discount > 1 THEN market_purchase_discount / 100
            ELSE market_purchase_discount
          END, 2)
         THEN '公式'
         ELSE '手工覆盖'
       END,
       market_purchase_price_override_reason = CASE
         WHEN market_purchase_price IS NULL THEN NULL
         WHEN accounting_price IS NOT NULL
          AND market_purchase_discount IS NOT NULL
          AND market_purchase_price = ROUND(accounting_price * CASE
            WHEN market_purchase_discount > 1 THEN market_purchase_discount / 100
            ELSE market_purchase_discount
          END, 2)
         THEN NULL
         WHEN accounting_price IS NULL OR market_purchase_discount IS NULL
         THEN '历史数据缺少完整核算公式'
         ELSE '历史数据保留'
       END
 WHERE source_type = '供应链';

UPDATE inventory_skus
   SET market_purchase_price_mode = NULL,
       market_purchase_price_override_reason = NULL
 WHERE source_type <> '供应链';

-- 新写入必须显式满足价格来源约束；CHECK 对 NULL 的三值逻辑不能单独承担该职责。
CREATE OR REPLACE FUNCTION inventory_validate_sku_market_price_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  formula_price numeric;
BEGIN
  IF NEW.market_purchase_discount IS NOT NULL
     AND (NEW.market_purchase_discount < 0 OR NEW.market_purchase_discount > 100) THEN
    RAISE EXCEPTION '市场折扣必须在 0 到 100 之间';
  END IF;
  IF NEW.source_type <> '供应链' THEN
    IF NEW.market_purchase_price_mode IS NOT NULL
       OR NEW.market_purchase_price_override_reason IS NOT NULL THEN
      RAISE EXCEPTION '非供应链 SKU 不允许设置市场公式价模式';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.market_purchase_price_mode NOT IN ('公式', '手工覆盖') THEN
    RAISE EXCEPTION '供应链 SKU 必须明确市场进货价来源';
  END IF;

  IF NEW.market_purchase_price_mode = '公式' THEN
    IF NEW.market_purchase_price_override_reason IS NOT NULL THEN
      RAISE EXCEPTION '公式价不能填写覆盖原因';
    END IF;
    IF NEW.accounting_price IS NOT NULL AND NEW.market_purchase_discount IS NOT NULL THEN
      formula_price := ROUND(NEW.accounting_price * CASE
        WHEN NEW.market_purchase_discount > 1 THEN NEW.market_purchase_discount / 100
        ELSE NEW.market_purchase_discount
      END, 2);
      NEW.market_purchase_price := formula_price;
    END IF;
  ELSIF NEW.market_purchase_price IS NULL
     OR NULLIF(BTRIM(NEW.market_purchase_price_override_reason), '') IS NULL THEN
    RAISE EXCEPTION '手工覆盖市场进货价必须填写价格和原因';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_skus_validate_market_price_mode
BEFORE INSERT OR UPDATE OF source_type, accounting_price, market_purchase_discount,
  market_purchase_price, market_purchase_price_mode, market_purchase_price_override_reason
ON inventory_skus
FOR EACH ROW EXECUTE FUNCTION inventory_validate_sku_market_price_mode();

-- 角色层级约束：库存动作与组织 scope 必须处于同一业务层级。
CREATE OR REPLACE FUNCTION permission_validate_role_scope_types()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  has_supply_chain boolean;
  has_market boolean;
  has_store boolean;
  tier_count integer;
BEGIN
  IF CARDINALITY(NEW.allowed_scope_types) = 0
     OR EXISTS (
       SELECT 1 FROM unnest(NEW.allowed_scope_types) value
        WHERE value NOT IN ('总部','市场','门店')
     ) THEN
    RAISE EXCEPTION '角色允许的 scope 类型不合法';
  END IF;

  IF NEW.is_super_admin THEN
    NEW.allowed_scope_types := ARRAY['总部']::text[];
    RETURN NEW;
  END IF;

  has_supply_chain := NEW.actions && ARRAY[
    'inventory:supply_chain_operate', 'inventory:supply_chain_approve',
    'inventory:supply_chain_price_view', 'inventory:supply_chain_master_data_manage',
    'inventory:shipment_cancel_approve'
  ]::text[];
  has_market := NEW.actions && ARRAY[
    'inventory:market_operate', 'inventory:market_approve',
    'inventory:market_price_view', 'inventory:market_sku_manage',
    'inventory:self_purchase_receive', 'inventory:shipment_cancel_request'
  ]::text[];
  has_store := NEW.actions && ARRAY['inventory:store_operate']::text[];
  tier_count := has_supply_chain::int + has_market::int + has_store::int;

  IF tier_count > 1 THEN
    RAISE EXCEPTION '普通角色不能混合多个进销存层级动作';
  END IF;
  IF has_supply_chain AND NEW.allowed_scope_types <> ARRAY['总部']::text[] THEN
    RAISE EXCEPTION '供应链库存角色只能绑定总部';
  END IF;
  IF has_market AND NEW.allowed_scope_types <> ARRAY['市场']::text[] THEN
    RAISE EXCEPTION '市场库存角色只能绑定市场';
  END IF;
  IF has_store AND NEW.allowed_scope_types <> ARRAY['门店']::text[] THEN
    RAISE EXCEPTION '门店库存角色只能绑定门店';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_permission_role_definitions_scope_types
BEFORE INSERT OR UPDATE OF actions, allowed_scope_types, is_super_admin
ON permission_role_definitions
FOR EACH ROW EXECUTE FUNCTION permission_validate_role_scope_types();

CREATE OR REPLACE FUNCTION permission_validate_role_assignment_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  node_type text;
  allowed_types text[];
BEGIN
  SELECT type INTO node_type FROM org_nodes WHERE id = NEW.scope_id;
  SELECT allowed_scope_types INTO allowed_types
    FROM permission_role_definitions WHERE role_key = NEW.role;
  IF node_type IS NULL OR allowed_types IS NULL OR NOT (node_type = ANY(allowed_types)) THEN
    RAISE EXCEPTION '角色 % 不能绑定到 % 型组织节点', NEW.role, COALESCE(node_type, '<不存在>');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_permission_roles_validate_scope_type
BEFORE INSERT OR UPDATE OF role, scope_id ON permission_roles
FOR EACH ROW EXECUTE FUNCTION permission_validate_role_assignment_scope();

UPDATE permission_role_definitions
   SET allowed_scope_types = CASE
     WHEN is_super_admin THEN ARRAY['总部']::text[]
     ELSE ARRAY['总部','市场','门店']::text[]
   END,
       actions = CASE
         WHEN is_super_admin THEN actions
         ELSE ARRAY(
           SELECT action FROM unnest(actions) action
            WHERE action NOT LIKE 'inventory:%'
            ORDER BY action
         )
       END,
       updated_at = NOW();

DO $$
DECLARE
  invalid_assignment_count integer;
BEGIN
  SELECT COUNT(*)::int INTO invalid_assignment_count
    FROM permission_roles assignment
    JOIN permission_role_definitions definition ON definition.role_key = assignment.role
    JOIN org_nodes node ON node.id = assignment.scope_id
   WHERE NOT (node.type::text = ANY(definition.allowed_scope_types));
  IF invalid_assignment_count > 0 THEN
    RAISE EXCEPTION '发现 % 条角色绑定与 allowed_scope_types 冲突，请先修复后重试', invalid_assignment_count;
  END IF;
END;
$$;

INSERT INTO permission_role_definitions (
  role_key, name, description, actions, allowed_scope_types,
  can_access_admin, is_super_admin, is_store_manager, created_by, updated_by
) VALUES
  (
    'inventory_supply_chain_operator', '供应链库存员', '办理总部供应链进销存并审核市场退货',
    ARRAY[
      'inventory:export','inventory:list','inventory:shipment_cancel_approve',
      'inventory:stock_list','inventory:supply_chain_approve',
      'inventory:supply_chain_master_data_manage','inventory:supply_chain_operate',
      'inventory:supply_chain_price_view'
    ]::text[],
    ARRAY['总部']::text[], true, false, false, 'migration:0037', 'migration:0037'
  ),
  (
    'inventory_market_finance', '市场库存财务', '办理本市场及所属门店进销存业务',
    ARRAY[
      'inventory:export','inventory:list','inventory:market_approve',
      'inventory:market_operate','inventory:market_price_view',
      'inventory:market_sku_manage','inventory:self_purchase_receive',
      'inventory:shipment_cancel_request','inventory:stock_list'
    ]::text[],
    ARRAY['市场']::text[], true, false, false, 'migration:0037', 'migration:0037'
  ),
  (
    'inventory_store_operator', '门店库存员', '办理绑定门店进销存业务，不查看价格金额',
    ARRAY['inventory:list','inventory:stock_list','inventory:store_operate']::text[],
    ARRAY['门店']::text[], false, false, false, 'migration:0037', 'migration:0037'
  )
ON CONFLICT (role_key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      actions = EXCLUDED.actions,
      allowed_scope_types = EXCLUDED.allowed_scope_types,
      can_access_admin = EXCLUDED.can_access_admin,
      is_super_admin = EXCLUDED.is_super_admin,
      is_store_manager = EXCLUDED.is_store_manager,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW();

UPDATE permission_role_definitions
   SET actions = ARRAY(
     SELECT DISTINCT action
       FROM unnest(actions || ARRAY[
         'inventory:export','inventory:list','inventory:market_approve',
         'inventory:market_operate','inventory:market_price_view',
         'inventory:market_sku_manage','inventory:self_purchase_receive',
         'inventory:shipment_cancel_approve','inventory:shipment_cancel_request',
         'inventory:stock_list','inventory:store_operate',
         'inventory:supply_chain_approve','inventory:supply_chain_master_data_manage',
         'inventory:supply_chain_operate','inventory:supply_chain_price_view'
       ]::text[]) action
      ORDER BY action
   ),
       allowed_scope_types = ARRAY['总部']::text[],
       updated_at = NOW()
 WHERE is_super_admin;

-- 明细金额和单头汇总由数据库统一维护，避免 admin/staff 两套实现漂移。
CREATE OR REPLACE FUNCTION inventory_set_doc_item_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_doc_type text;
  effective_price numeric;
BEGIN
  SELECT doc_type INTO item_doc_type FROM inventory_docs WHERE id = NEW.doc_id;
  IF NEW.is_gift THEN
    NEW.amount := 0;
    RETURN NEW;
  END IF;

  effective_price := NEW.actual_unit_price;
  IF effective_price IS NULL THEN
    IF item_doc_type IN (
      '供应链采购订单','供应链采购入库','供应链员工购出库','内部领用',
      '非凤御市场出库','供应链退货入库','品项公司报货需求'
    ) THEN
      effective_price := NEW.supply_chain_unit_cost;
    ELSIF item_doc_type IN (
      '采购订单','品项公司发货','市场采购入库','市场退货','市场退货入库'
    ) THEN
      effective_price := NEW.market_actual_unit_price;
    ELSE
      effective_price := COALESCE(
        NEW.store_actual_unit_price,
        NEW.market_actual_unit_price,
        NEW.supply_chain_unit_cost
      );
    END IF;
  END IF;
  NEW.amount := CASE
    WHEN effective_price IS NULL THEN NULL
    ELSE ROUND(NEW.quantity * effective_price, 2)
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_doc_items_set_amount
BEFORE INSERT OR UPDATE OF doc_id, quantity, is_gift, actual_unit_price,
  supply_chain_unit_cost, market_actual_unit_price, store_actual_unit_price
ON inventory_doc_items
FOR EACH ROW EXECUTE FUNCTION inventory_set_doc_item_amount();

CREATE OR REPLACE FUNCTION inventory_refresh_doc_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_doc_id text;
BEGIN
  affected_doc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.doc_id ELSE NEW.doc_id END;
  UPDATE inventory_docs doc
     SET total_quantity = totals.total_quantity,
         total_amount = totals.total_amount,
         updated_at = NOW()
    FROM (
      SELECT COALESCE(SUM(quantity), 0) AS total_quantity,
             CASE WHEN COUNT(amount) = 0 THEN NULL ELSE SUM(amount) END AS total_amount
        FROM inventory_doc_items
       WHERE doc_id = affected_doc_id
    ) totals
   WHERE doc.id = affected_doc_id;
  IF TG_OP = 'UPDATE' AND OLD.doc_id IS DISTINCT FROM NEW.doc_id THEN
    UPDATE inventory_docs doc
       SET total_quantity = totals.total_quantity,
           total_amount = totals.total_amount,
           updated_at = NOW()
      FROM (
        SELECT COALESCE(SUM(quantity), 0) AS total_quantity,
               CASE WHEN COUNT(amount) = 0 THEN NULL ELSE SUM(amount) END AS total_amount
          FROM inventory_doc_items
         WHERE doc_id = OLD.doc_id
      ) totals
     WHERE doc.id = OLD.doc_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_doc_items_refresh_totals
AFTER INSERT OR UPDATE OR DELETE ON inventory_doc_items
FOR EACH ROW EXECUTE FUNCTION inventory_refresh_doc_totals();

-- 触发金额与汇总回填；不会改变库存数量或流水。
UPDATE inventory_doc_items SET quantity = quantity;

INSERT INTO system_configs (key, value, updated_at)
SELECT 'permission_matrix', jsonb_object_agg(role_key, to_jsonb(actions))::text, NOW()
  FROM permission_role_definitions
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at;

DROP TRIGGER IF EXISTS trg_inventory_docs_set_market_id ON inventory_docs;
--> statement-breakpoint
UPDATE "inventory_docs" AS d
   SET "source_org_node_id" = l."org_node_id"
  FROM "inventory_locations" AS l
 WHERE d."source_org_node_id" = l."location_id"
   AND l."org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs" AS d
   SET "target_org_node_id" = l."org_node_id"
  FROM "inventory_locations" AS l
 WHERE d."target_org_node_id" = l."location_id"
   AND l."org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "target_org_node_id" = "source_org_node_id"
 WHERE "doc_type" IN (
   '员工购出库', '供应链员工购出库', '内部领用',
   '市场产品报损', '院产品报损', '库存转换出库'
 )
   AND "source_org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "source_org_node_id" = "target_org_node_id"
 WHERE "doc_type" IN ('市场产品盘溢', '库存转换入库', '期初库存')
   AND "target_org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "source_org_node_id" = COALESCE("source_org_node_id", "target_org_node_id"),
       "target_org_node_id" = COALESCE("source_org_node_id", "target_org_node_id")
 WHERE "doc_type" IN ('品项公司报货需求', '市场库存盘点', '分院库存盘点');

-- 单据端点已经切换为 org_nodes.id；市场归属必须从组织节点而非库存内部主键派生。
-- 0037 版函数沿用 location_id 参数命名，此处按 org_node 语义重建并统一参数名，
-- 避免后续维护者按参数名误传 inventory_locations.location_id。
CREATE OR REPLACE FUNCTION inventory_location_market_id(input_org_node_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE location_type
    WHEN '市场' THEN org_node_id
    WHEN '门店' THEN parent_location_id
    ELSE NULL
  END
    FROM inventory_locations
   WHERE org_node_id = input_org_node_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inventory_expected_doc_market_id(
  input_doc_type text,
  input_source_org_node_id text,
  input_target_org_node_id text
)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  source_market text;
  target_market text;
BEGIN
  source_market := inventory_location_market_id(input_source_org_node_id);
  target_market := inventory_location_market_id(input_target_org_node_id);
  IF input_doc_type = '市场间调货入库' THEN RETURN target_market; END IF;
  IF input_doc_type = '市场间调货出库' THEN RETURN source_market; END IF;
  RETURN COALESCE(source_market, target_market);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inventory_set_doc_market_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.market_id := inventory_expected_doc_market_id(
    NEW.doc_type, NEW.source_org_node_id, NEW.target_org_node_id
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_inventory_docs_set_market_id ON inventory_docs;
--> statement-breakpoint
CREATE TRIGGER trg_inventory_docs_set_market_id
BEFORE INSERT OR UPDATE OF doc_type, source_org_node_id, target_org_node_id, market_id
ON inventory_docs
FOR EACH ROW EXECUTE FUNCTION inventory_set_doc_market_id();
--> statement-breakpoint
-- 存量单据 market_id 回填改为分批提交：避免单事务全表 UPDATE 长持锁与 WAL 膨胀。
-- 当前试运营期表为空，一笔即可完成；正式运营后重放（或新环境导入数据后补跑）也不会锁表过久。
-- PROCEDURE 内 COMMIT 需要独立调用（drizzle-kit 逐条 statement 执行，满足该前提）。
CREATE OR REPLACE PROCEDURE inventory_backfill_doc_market_id(batch_size int DEFAULT 2000)
LANGUAGE plpgsql
AS $$
DECLARE
  rows_updated int;
BEGIN
  LOOP
    UPDATE inventory_docs
       SET market_id = inventory_expected_doc_market_id(
         doc_type, source_org_node_id, target_org_node_id
       )
     WHERE ctid IN (
       SELECT ctid
         FROM inventory_docs
        WHERE market_id IS DISTINCT FROM inventory_expected_doc_market_id(
                doc_type, source_org_node_id, target_org_node_id
              )
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
     );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL inventory_backfill_doc_market_id();
--> statement-breakpoint
DROP PROCEDURE inventory_backfill_doc_market_id(int);

-- 0035 已发布版本的审计标记沿用了重排前的 0034 名称；通过前向迁移修正，避免改写历史 migration hash。
UPDATE permission_role_definitions
SET updated_by = 'migration:0035_restore_performance_attribution_permission'
WHERE updated_by = 'migration:0034_restore_performance_attribution_permission'
  AND actions @> ARRAY['sale_order:performance_attribution_update']::text[];
