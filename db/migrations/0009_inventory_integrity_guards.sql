-- 0008 先以 NOT VALID 加入跨表约束；本迁移在保留历史数据可审计性的前提下
-- 回填、校验并启用不能由 Drizzle schema 表达的跨行完整性守卫。

-- 自由文本血缘只有在能无损转换为 inventory_doc_links 时才能删除。先拒绝孤儿和自环，
-- 避免迁移时静默丢失关联语义。
DO $$
DECLARE
  invalid_text_link_count integer;
  malformed_link_count integer;
BEGIN
  SELECT COUNT(*)::int
    INTO invalid_text_link_count
    FROM inventory_docs doc
   WHERE (doc.related_doc_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM inventory_docs source_doc
             WHERE source_doc.id = doc.related_doc_id
               AND source_doc.id <> doc.id
          ))
      OR (doc.request_doc_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM inventory_docs source_doc
             WHERE source_doc.id = doc.request_doc_id
               AND source_doc.id <> doc.id
          ));
  IF invalid_text_link_count > 0 THEN
    RAISE EXCEPTION '发现 % 条无法迁移的 related_doc_id/request_doc_id（孤儿或自环）；请先人工修复后重试', invalid_text_link_count;
  END IF;

  SELECT COUNT(*)::int
    INTO malformed_link_count
    FROM inventory_doc_links
   WHERE (from_item_id IS NULL) IS DISTINCT FROM (to_item_id IS NULL)
      OR (from_item_id IS NULL) IS DISTINCT FROM (quantity IS NULL);
  IF malformed_link_count > 0 THEN
    RAISE EXCEPTION '发现 % 条明细形态不完整的库存血缘；请先补齐或人工标记为历史关联后重试', malformed_link_count;
  END IF;
END;
$$;

-- 已存在任何同向链路时不重复插入。没有明细和数量的旧链路统一降级为只读历史关联，
-- 后续不会被当成可履约数量使用。
INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type)
SELECT source_doc.id, doc.id, '历史关联'
  FROM inventory_docs doc
  JOIN inventory_docs source_doc ON source_doc.id = doc.related_doc_id
 WHERE doc.related_doc_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM inventory_doc_links link
      WHERE link.from_doc_id = doc.related_doc_id
        AND link.to_doc_id = doc.id
   );

INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type)
SELECT source_doc.id, doc.id, '历史关联'
  FROM inventory_docs doc
  JOIN inventory_docs source_doc ON source_doc.id = doc.request_doc_id
 WHERE doc.request_doc_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM inventory_doc_links link
      WHERE link.from_doc_id = doc.request_doc_id
        AND link.to_doc_id = doc.id
   );

UPDATE inventory_doc_links
   SET relation_type = '历史关联'
 WHERE from_item_id IS NULL
   AND to_item_id IS NULL
   AND quantity IS NULL
   AND relation_type <> '历史关联';

-- 优先用流水中的第一笔入库补齐来源单据，再由来源单据和供应商名称回填供应商主键。
-- 无可靠供应商主键时仍保留名称快照，并参与批次键，避免继续误合并。
WITH inbound_source AS (
  SELECT DISTINCT ON (movement.lot_id)
         movement.lot_id,
         movement.doc_id
    FROM inventory_movements movement
   WHERE movement.direction = '入库'
     AND movement.doc_id IS NOT NULL
   ORDER BY movement.lot_id, movement.created_at, movement.id
)
UPDATE inventory_stock_lots lot
   SET source_doc_id = source.doc_id
  FROM inbound_source source
 WHERE lot.id = source.lot_id
   AND lot.source_doc_id IS NULL;

UPDATE inventory_stock_lots lot
   SET supplier_id = doc.supplier_id
  FROM inventory_docs doc
 WHERE lot.source_doc_id = doc.id
   AND lot.supplier_id IS NULL
   AND doc.supplier_id IS NOT NULL;

UPDATE inventory_stock_lots lot
   SET supplier_id = supplier.supplier_id
  FROM inventory_suppliers supplier
 WHERE lot.supplier_id IS NULL
   AND NULLIF(BTRIM(lot.supplier), '') IS NOT NULL
   AND supplier.name = BTRIM(lot.supplier);

UPDATE inventory_stock_lots
   SET lot_key = lot_key
      || '|supplier:' || COALESCE(supplier_id, supplier, '')
      || '|source:' || COALESCE(source_doc_id, '')
 WHERE lot_key NOT LIKE '%|supplier:%|source:%';

-- 历史库存流水必须本身连续，并且最后一笔余额与批次余额一致。发现异常时中止，
-- 由数据修复流程处理，不能让新触发器掩盖既有不一致。
DO $$
DECLARE
  bad_movement_sequence_count integer;
  bad_lot_balance_count integer;
  bad_movement_doc_pair_count integer;
BEGIN
  WITH sequenced AS (
    SELECT movement.lot_id,
           movement.quantity_before,
           LAG(movement.quantity_after) OVER (
             PARTITION BY movement.lot_id
             ORDER BY movement.created_at, movement.id
           ) AS previous_after,
           ROW_NUMBER() OVER (
             PARTITION BY movement.lot_id
             ORDER BY movement.created_at, movement.id
           ) AS sequence_no
      FROM inventory_movements movement
  )
  SELECT COUNT(*)::int
    INTO bad_movement_sequence_count
    FROM sequenced
   WHERE (previous_after IS NOT NULL AND quantity_before <> previous_after)
      OR (sequence_no = 1 AND quantity_before <> 0);
  IF bad_movement_sequence_count > 0 THEN
    RAISE EXCEPTION '发现 % 条库存流水前后余额不连续；请先通过专项修复单校正后重试', bad_movement_sequence_count;
  END IF;

  WITH latest_movement AS (
    SELECT DISTINCT ON (movement.lot_id)
           movement.lot_id,
           movement.quantity_after
      FROM inventory_movements movement
     ORDER BY movement.lot_id, movement.created_at DESC, movement.id DESC
  )
  SELECT COUNT(*)::int
    INTO bad_lot_balance_count
    FROM inventory_stock_lots lot
    LEFT JOIN latest_movement latest ON latest.lot_id = lot.id
   WHERE (latest.lot_id IS NOT NULL AND lot.quantity_on_hand <> latest.quantity_after)
      OR (latest.lot_id IS NULL AND lot.quantity_on_hand <> 0);
  IF bad_lot_balance_count > 0 THEN
    RAISE EXCEPTION '发现 % 个批次余额与库存流水不一致；请先通过专项修复单校正后重试', bad_lot_balance_count;
  END IF;

  SELECT COUNT(*)::int
    INTO bad_movement_doc_pair_count
    FROM inventory_movements
   WHERE (doc_item_id IS NULL) IS DISTINCT FROM (doc_id IS NULL);
  IF bad_movement_doc_pair_count > 0 THEN
    RAISE EXCEPTION '发现 % 条库存流水缺少单据或明细配对；请先修复后重试', bad_movement_doc_pair_count;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION inventory_validate_doc_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_doc_type text;
  target_doc_type text;
  source_quantity numeric;
  linked_quantity numeric;
BEGIN
  IF NEW.relation_type = '历史关联' THEN
    IF NEW.from_item_id IS NOT NULL OR NEW.to_item_id IS NOT NULL OR NEW.quantity IS NOT NULL THEN
      RAISE EXCEPTION '历史关联不能包含库存明细或数量';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.from_item_id IS NULL OR NEW.to_item_id IS NULL OR NEW.quantity IS NULL THEN
    RAISE EXCEPTION '库存单据关联必须同时包含来源明细、目标明细和数量';
  END IF;

  SELECT doc_type INTO source_doc_type
    FROM inventory_docs
   WHERE id = NEW.from_doc_id;
  SELECT doc_type INTO target_doc_type
    FROM inventory_docs
   WHERE id = NEW.to_doc_id;

  IF NOT (
    (NEW.relation_type = '门店报货汇总'
      AND source_doc_type = '门店报货' AND target_doc_type = '市场报货')
    OR (NEW.relation_type = '市场报货采购订单'
      AND source_doc_type = '市场报货' AND target_doc_type = '采购订单')
    OR (NEW.relation_type = '品项公司报货采购订单'
      AND source_doc_type = '品项公司报货需求' AND target_doc_type = '供应链采购订单')
    OR (NEW.relation_type IN ('采购订单发货', '采购订单赠送发货')
      AND source_doc_type = '采购订单' AND target_doc_type = '品项公司发货')
    OR (NEW.relation_type = '发货收货' AND (
      (source_doc_type = '品项公司发货' AND target_doc_type = '市场采购入库')
      OR (source_doc_type = '分院配货' AND target_doc_type = '院入库')
      OR (source_doc_type = '分院调货出库' AND target_doc_type = '分院调货入库')
      OR (source_doc_type = '市场间调货出库' AND target_doc_type = '市场间调货入库')
    ))
    OR (NEW.relation_type = '采购订单供应链采购入库'
      AND source_doc_type = '供应链采购订单' AND target_doc_type = '供应链采购入库')
    OR (NEW.relation_type IN ('门店报货配货', '门店报货赠送配货')
      AND source_doc_type = '门店报货' AND target_doc_type = '分院配货')
    OR (NEW.relation_type = '退货回库' AND (
      (source_doc_type = '院退货' AND target_doc_type = '市场退货入库')
      OR (source_doc_type = '市场退货' AND target_doc_type = '供应链退货入库')
    ))
    OR (NEW.relation_type = '库存转换'
      AND source_doc_type = '库存转换出库' AND target_doc_type = '库存转换入库')
  ) THEN
    RAISE EXCEPTION '单据关联类型 % 不支持 % -> %',
      NEW.relation_type, COALESCE(source_doc_type, '<缺失>'), COALESCE(target_doc_type, '<缺失>');
  END IF;

  -- 锁来源明细而不是只做共享读取：同一明细的并发链路写入会串行化，
  -- 之后的累计查询可见前一个已提交写入，不能绕过数量上限。
  SELECT quantity INTO source_quantity
    FROM inventory_doc_items
   WHERE id = NEW.from_item_id
     AND doc_id = NEW.from_doc_id
   FOR UPDATE;
  IF source_quantity IS NULL THEN
    RAISE EXCEPTION '关联来源明细 % 不属于单据 %', NEW.from_item_id, NEW.from_doc_id;
  END IF;

  -- 汇总、配货和收货是不同阶段的链路，不能彼此互相占用额度；
  -- 同一关系可以分批履约，但累计不能超过该来源明细。
  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(SUM(quantity), 0) INTO linked_quantity
      FROM inventory_doc_links link
      JOIN inventory_docs linked_doc ON linked_doc.id = link.to_doc_id
     WHERE link.from_item_id = NEW.from_item_id
       AND link.relation_type = NEW.relation_type
       AND link.id <> OLD.id
       AND linked_doc.status <> '已取消';
  ELSE
    SELECT COALESCE(SUM(quantity), 0) INTO linked_quantity
      FROM inventory_doc_links link
      JOIN inventory_docs linked_doc ON linked_doc.id = link.to_doc_id
     WHERE link.from_item_id = NEW.from_item_id
       AND link.relation_type = NEW.relation_type
       AND linked_doc.status <> '已取消';
  END IF;
  IF linked_quantity + NEW.quantity > source_quantity + 0.000001 THEN
    RAISE EXCEPTION '关联数量超出来源明细：来源 %, 现有关联 %, 本次 %',
      source_quantity, linked_quantity, NEW.quantity;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_doc_links_validate
BEFORE INSERT OR UPDATE ON inventory_doc_links
FOR EACH ROW EXECUTE FUNCTION inventory_validate_doc_link();

CREATE OR REPLACE FUNCTION inventory_apply_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lot inventory_stock_lots%ROWTYPE;
BEGIN
  -- AFTER INSERT 让 ON CONFLICT DO NOTHING 保持真正幂等：冲突行不会触发余额变更。
  SELECT * INTO lot
    FROM inventory_stock_lots
   WHERE id = NEW.lot_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '库存流水引用的批次不存在：%', NEW.lot_id;
  END IF;
  IF lot.location_id <> NEW.location_id OR lot.sku_id <> NEW.sku_id THEN
    RAISE EXCEPTION '库存流水的库存主体或 SKU 与批次不一致';
  END IF;
  IF lot.quantity_on_hand <> NEW.quantity_before THEN
    RAISE EXCEPTION '库存流水前余额不匹配：批次当前 %, 流水声明 %',
      lot.quantity_on_hand, NEW.quantity_before;
  END IF;
  IF NEW.quantity_after <> NEW.quantity_before + NEW.quantity_delta THEN
    RAISE EXCEPTION '库存流水前余额、变动和后余额不一致';
  END IF;
  IF NEW.quantity_after < 0 THEN
    RAISE EXCEPTION '库存流水不能将批次余额扣为负数';
  END IF;

  UPDATE inventory_stock_lots
     SET quantity_on_hand = NEW.quantity_after,
         updated_at = NOW()
   WHERE id = NEW.lot_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_movements_apply_lot
AFTER INSERT ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION inventory_apply_movement();

CREATE OR REPLACE FUNCTION inventory_guard_lot_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.quantity_on_hand <> 0 THEN
    RAISE EXCEPTION '新库存批次必须从零余额开始，并通过 inventory_movements 入账';
  END IF;
  -- 直接 UPDATE 的触发器深度为 1；只有库存流水触发器中的嵌套 UPDATE 才允许改余额。
  IF TG_OP = 'UPDATE'
     AND NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION '库存余额只能通过 inventory_movements 写入';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_stock_lots_guard_balance
BEFORE INSERT OR UPDATE ON inventory_stock_lots
FOR EACH ROW EXECUTE FUNCTION inventory_guard_lot_balance();

CREATE OR REPLACE FUNCTION inventory_block_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '库存流水为只追加记录，禁止 %', TG_OP;
END;
$$;

CREATE TRIGGER trg_inventory_movements_append_only
BEFORE UPDATE OR DELETE ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION inventory_block_movement_mutation();

CREATE OR REPLACE FUNCTION inventory_validate_doc_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = '待收货' AND NEW.doc_type NOT IN (
    '供应链采购订单', '品项公司发货', '分院配货', '分院调货出库', '市场间调货出库'
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
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = '草稿' AND NEW.status IN ('待审批', '待收货', '已完成', '已取消'))
      OR (OLD.status = '待审批' AND NEW.status IN ('已完成', '已驳回', '待收货', '已取消'))
      OR (OLD.status = '待收货' AND NEW.status IN ('待审批', '已完成', '已取消'))
    ) THEN
      RAISE EXCEPTION '非法库存单据状态转换：% -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_docs_validate_lifecycle
BEFORE INSERT OR UPDATE ON inventory_docs
FOR EACH ROW EXECUTE FUNCTION inventory_validate_doc_lifecycle();

CREATE OR REPLACE FUNCTION inventory_validate_location_tree()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  node_type text;
  node_parent_id text;
  node_parent_type text;
  node_name text;
  node_is_active boolean;
  store_org_node_id text;
  store_name text;
  store_is_active boolean;
BEGIN
  IF NEW.parent_location_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT location_id, parent_location_id
        FROM inventory_locations
       WHERE location_id = NEW.parent_location_id
      UNION
      SELECT location.location_id, location.parent_location_id
        FROM inventory_locations location
        JOIN ancestors ancestor ON location.location_id = ancestor.parent_location_id
    )
    SELECT 1 FROM ancestors WHERE location_id = NEW.location_id
  ) THEN
    RAISE EXCEPTION '库存主体父级关系形成环：%', NEW.location_id;
  END IF;

  IF NEW.location_type IN ('总部', '市场') THEN
    SELECT node.type, node.parent_id, parent.type, node.name, node.is_active
      INTO node_type, node_parent_id, node_parent_type, node_name, node_is_active
      FROM org_nodes node
      LEFT JOIN org_nodes parent ON parent.id = node.parent_id
     WHERE node.id = NEW.org_node_id;
    IF node_type IS NULL
       OR NEW.location_id <> NEW.org_node_id
       OR NEW.store_id IS NOT NULL
       OR NEW.parent_location_id IS DISTINCT FROM node_parent_id
       OR NEW.name IS DISTINCT FROM node_name
       OR NEW.is_active IS DISTINCT FROM node_is_active
       OR (NEW.location_type = '总部' AND (
            node_type IS DISTINCT FROM '总部' OR node_parent_id IS NOT NULL
          ))
       OR (NEW.location_type = '市场' AND (
            node_type IS DISTINCT FROM '市场' OR node_parent_type IS DISTINCT FROM '总部'
          )) THEN
      RAISE EXCEPTION '库存主体 % 与组织树映射不一致', NEW.location_id;
    END IF;
  ELSIF NEW.location_type = '门店' THEN
    SELECT s.org_node_id,
           node.type,
           node.parent_id,
           parent.type,
           s.store_name,
           COALESCE(node.is_active, false) AND NOT s.is_closed
      INTO store_org_node_id,
           node_type,
           node_parent_id,
           node_parent_type,
           store_name,
           store_is_active
      FROM stores s
      LEFT JOIN org_nodes node ON node.id = s.org_node_id
      LEFT JOIN org_nodes parent ON parent.id = node.parent_id
     WHERE s.store_id = NEW.location_id;
    IF store_org_node_id IS NULL
       OR node_type IS DISTINCT FROM '门店'
       OR node_parent_type IS DISTINCT FROM '市场'
       OR NEW.store_id <> NEW.location_id
       OR NEW.org_node_id IS DISTINCT FROM store_org_node_id
       OR NEW.parent_location_id IS DISTINCT FROM node_parent_id
       OR NEW.name IS DISTINCT FROM store_name
       OR NEW.is_active IS DISTINCT FROM store_is_active THEN
      RAISE EXCEPTION '门店库存主体 % 与门店、组织树映射不一致', NEW.location_id;
    END IF;
  ELSE
    RAISE EXCEPTION '无效库存主体类型：%', NEW.location_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_locations_validate_tree
BEFORE INSERT OR UPDATE ON inventory_locations
FOR EACH ROW EXECUTE FUNCTION inventory_validate_location_tree();

-- 源组织表发生变更时同步库存主体，而不是等待下一次库存业务调用。库存主体自身的
-- BEFORE trigger 会再次校验映射，形成数据库内闭环。
CREATE OR REPLACE FUNCTION inventory_sync_location_from_org_node()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.type IN ('总部', '市场')
     AND NEW.type NOT IN ('总部', '市场')
     AND EXISTS (
       SELECT 1 FROM inventory_locations WHERE org_node_id = OLD.id
     ) THEN
    RAISE EXCEPTION '组织节点 % 已作为库存主体，不能改为非库存主体类型', OLD.id;
  END IF;

  IF NEW.type IN ('总部', '市场') THEN
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO inventory_locations (
        location_id, location_type, name, org_node_id, parent_location_id, is_active
      )
      SELECT parent.id, parent.type, parent.name, parent.id, parent.parent_id, parent.is_active
        FROM org_nodes parent
       WHERE parent.id = NEW.parent_id
         AND parent.type IN ('总部', '市场')
      ON CONFLICT (location_id) DO UPDATE
        SET location_type = EXCLUDED.location_type,
            name = EXCLUDED.name,
            org_node_id = EXCLUDED.org_node_id,
            parent_location_id = EXCLUDED.parent_location_id,
            is_active = EXCLUDED.is_active,
            updated_at = NOW();
    END IF;

    INSERT INTO inventory_locations (
      location_id, location_type, name, org_node_id, parent_location_id, is_active
    ) VALUES (
      NEW.id, NEW.type, NEW.name, NEW.id, NEW.parent_id, NEW.is_active
    )
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW();
  END IF;

  IF EXISTS (SELECT 1 FROM stores WHERE org_node_id = NEW.id) THEN
    INSERT INTO inventory_locations (
      location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active
    )
    SELECT store.store_id,
           '门店',
           store.store_name,
           store.org_node_id,
           store.store_id,
           node.parent_id,
           COALESCE(node.is_active, false) AND NOT store.is_closed
      FROM stores store
      JOIN org_nodes node ON node.id = store.org_node_id
     WHERE store.org_node_id = NEW.id
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_org_nodes_sync_inventory_locations
AFTER INSERT OR UPDATE OF name, type, parent_id, is_active ON org_nodes
FOR EACH ROW EXECUTE FUNCTION inventory_sync_location_from_org_node();

CREATE OR REPLACE FUNCTION inventory_sync_location_from_store()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.org_node_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM org_nodes node
      JOIN org_nodes parent ON parent.id = node.parent_id
     WHERE node.id = NEW.org_node_id
       AND node.type = '门店'
       AND parent.type = '市场'
  ) THEN
    RAISE EXCEPTION '门店 % 必须关联归属市场下的门店组织节点，才能维护库存主体', NEW.store_id;
  END IF;

  INSERT INTO inventory_locations (
    location_id, location_type, name, org_node_id, parent_location_id, is_active
  )
  SELECT parent.id, parent.type, parent.name, parent.id, parent.parent_id, parent.is_active
    FROM org_nodes node
    JOIN org_nodes parent ON parent.id = node.parent_id
   WHERE node.id = NEW.org_node_id
     AND parent.type IN ('总部', '市场')
  ON CONFLICT (location_id) DO UPDATE
    SET location_type = EXCLUDED.location_type,
        name = EXCLUDED.name,
        org_node_id = EXCLUDED.org_node_id,
        parent_location_id = EXCLUDED.parent_location_id,
        is_active = EXCLUDED.is_active,
        updated_at = NOW();

  INSERT INTO inventory_locations (
    location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active
  )
  SELECT NEW.store_id,
         '门店',
         NEW.store_name,
         NEW.org_node_id,
         NEW.store_id,
         node.parent_id,
         COALESCE(node.is_active, false) AND NOT NEW.is_closed
    FROM org_nodes node
   WHERE node.id = NEW.org_node_id
  ON CONFLICT (location_id) DO UPDATE
    SET location_type = EXCLUDED.location_type,
        name = EXCLUDED.name,
        org_node_id = EXCLUDED.org_node_id,
        store_id = EXCLUDED.store_id,
        parent_location_id = EXCLUDED.parent_location_id,
        is_active = EXCLUDED.is_active,
        updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stores_sync_inventory_locations
AFTER INSERT OR UPDATE OF store_name, org_node_id, is_closed ON stores
FOR EACH ROW EXECUTE FUNCTION inventory_sync_location_from_store();

-- 源组织树的合法层级先于库存主体同步验证；库存主体与来源表不一致时迁移必须中止。
DO $$
DECLARE
  invalid_org_tree_count integer;
  invalid_store_mapping_count integer;
BEGIN
  SELECT COUNT(*)::int
    INTO invalid_org_tree_count
    FROM org_nodes node
    LEFT JOIN org_nodes parent ON parent.id = node.parent_id
   WHERE (node.type = '总部' AND node.parent_id IS NOT NULL)
      OR (node.type = '市场' AND parent.type IS DISTINCT FROM '总部');
  IF invalid_org_tree_count > 0 THEN
    RAISE EXCEPTION '发现 % 个不符合总部 -> 市场层级的组织节点；请先修复后重试', invalid_org_tree_count;
  END IF;

  SELECT COUNT(*)::int
    INTO invalid_store_mapping_count
    FROM stores store
    LEFT JOIN org_nodes node ON node.id = store.org_node_id
    LEFT JOIN org_nodes parent ON parent.id = node.parent_id
   WHERE store.org_node_id IS NULL
      OR node.type IS DISTINCT FROM '门店'
      OR parent.type IS DISTINCT FROM '市场';
  IF invalid_store_mapping_count > 0 THEN
    RAISE EXCEPTION '发现 % 个未映射到市场门店节点的门店；请先修复后重试', invalid_store_mapping_count;
  END IF;
END;
$$;

-- 先按总部、市场、门店顺序重建一次映射，避免历史库的同步时序影响父级外键。
INSERT INTO inventory_locations (
  location_id, location_type, name, org_node_id, parent_location_id, is_active
)
SELECT node.id, node.type, node.name, node.id, node.parent_id, node.is_active
  FROM org_nodes node
 WHERE node.type = '总部'
ON CONFLICT (location_id) DO UPDATE
  SET location_type = EXCLUDED.location_type,
      name = EXCLUDED.name,
      org_node_id = EXCLUDED.org_node_id,
      parent_location_id = EXCLUDED.parent_location_id,
      is_active = EXCLUDED.is_active,
      updated_at = NOW();

INSERT INTO inventory_locations (
  location_id, location_type, name, org_node_id, parent_location_id, is_active
)
SELECT node.id, node.type, node.name, node.id, node.parent_id, node.is_active
  FROM org_nodes node
  JOIN org_nodes parent ON parent.id = node.parent_id
 WHERE node.type = '市场'
   AND parent.type = '总部'
ON CONFLICT (location_id) DO UPDATE
  SET location_type = EXCLUDED.location_type,
      name = EXCLUDED.name,
      org_node_id = EXCLUDED.org_node_id,
      parent_location_id = EXCLUDED.parent_location_id,
      is_active = EXCLUDED.is_active,
      updated_at = NOW();

INSERT INTO inventory_locations (
  location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active
)
SELECT store.store_id,
       '门店',
       store.store_name,
       store.org_node_id,
       store.store_id,
       node.parent_id,
       COALESCE(node.is_active, false) AND NOT store.is_closed
  FROM stores store
  JOIN org_nodes node ON node.id = store.org_node_id
  JOIN org_nodes parent ON parent.id = node.parent_id
 WHERE node.type = '门店'
   AND parent.type = '市场'
ON CONFLICT (location_id) DO UPDATE
  SET location_type = EXCLUDED.location_type,
      name = EXCLUDED.name,
      org_node_id = EXCLUDED.org_node_id,
      store_id = EXCLUDED.store_id,
      parent_location_id = EXCLUDED.parent_location_id,
      is_active = EXCLUDED.is_active,
      updated_at = NOW();

-- 让源组织表触发一次同步，再通过库存表的校验触发器审计全部历史记录。
UPDATE org_nodes
   SET name = name
 WHERE type IN ('总部', '市场', '门店');

UPDATE stores
   SET store_name = store_name;

UPDATE inventory_doc_links
   SET relation_type = relation_type;

UPDATE inventory_docs
   SET status = status;

UPDATE inventory_locations
   SET name = name;

ALTER TABLE inventory_doc_links VALIDATE CONSTRAINT inventory_doc_links_from_item_doc_fk;
ALTER TABLE inventory_doc_links VALIDATE CONSTRAINT inventory_doc_links_to_item_doc_fk;
ALTER TABLE inventory_locations VALIDATE CONSTRAINT inventory_locations_parent_location_id_inventory_locations_location_id_fk;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_doc_item_doc_fk;
ALTER TABLE inventory_stock_lots VALIDATE CONSTRAINT inventory_stock_lots_supplier_id_inventory_suppliers_supplier_id_fk;
ALTER TABLE inventory_stock_lots VALIDATE CONSTRAINT inventory_stock_lots_source_doc_id_inventory_docs_id_fk;
ALTER TABLE inventory_doc_links VALIDATE CONSTRAINT chk_inventory_doc_links_item_pair;
ALTER TABLE inventory_doc_links VALIDATE CONSTRAINT chk_inventory_doc_links_quantity_shape;
ALTER TABLE inventory_doc_links VALIDATE CONSTRAINT chk_inventory_doc_links_relation_type;
ALTER TABLE inventory_docs VALIDATE CONSTRAINT chk_inventory_docs_type;
ALTER TABLE inventory_locations VALIDATE CONSTRAINT chk_inventory_locations_parent_not_self;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT chk_inventory_movements_direction_delta;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT chk_inventory_movements_balance;
