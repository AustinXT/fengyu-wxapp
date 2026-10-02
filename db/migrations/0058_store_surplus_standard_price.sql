ALTER TABLE "inventory_doc_links" DROP CONSTRAINT "chk_inventory_doc_links_relation_type";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "chk_inventory_docs_type";--> statement-breakpoint
ALTER TABLE "inventory_skus" DROP CONSTRAINT "chk_inventory_skus_prices_nonnegative";--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD COLUMN "standard_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_relation_type" CHECK ("inventory_doc_links"."relation_type" IN (
        '门店报货汇总','市场报货汇总','市场报货采购订单','报货汇总采购订单','品项公司报货采购订单',
        '采购订单发货','采购订单赠送发货','市场报货发货','市场报货赠送发货','发货收货','采购订单供应链采购入库',
        '门店报货配货','门店报货赠送配货','退货回库','库存转换','盘点盘溢','历史关联'
      ));--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_type" CHECK ("inventory_docs"."doc_type" IN (
        '门店报货','市场报货','市场报货汇总','品项公司报货需求','采购订单',
        '供应链采购入库','品项公司发货','市场采购入库','自采产品入库','分院配货',
        '院入库','分院调货出库','分院调货入库','市场间调货出库','市场间调货入库',
        '员工购出库','供应链员工购出库','内部领用','非凤御市场出库','市场退货','市场退货入库',
        '供应链退货入库','院退货','院顾客产品出库','院顾客退货','市场产品报损',
        '院产品报损','市场产品盘溢','院产品盘溢','市场库存盘点','分院库存盘点','库存转换出库',
        '库存转换入库','期初库存'
      ));--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "chk_inventory_skus_prices_nonnegative" CHECK (COALESCE("inventory_skus"."standard_price", 0) >= 0
       AND "inventory_skus"."standard_price" IS DISTINCT FROM 'NaN'::numeric
       AND COALESCE("inventory_skus"."retail_price", 0) >= 0
       AND COALESCE("inventory_skus"."accounting_price", 0) >= 0
       AND COALESCE("inventory_skus"."supply_chain_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."market_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."store_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."market_staff_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."item_company_purchase_price", 0) >= 0);
--> statement-breakpoint

-- #353：最新血缘函数来自 0052；盘溢的累计上限是正差异，不是实盘数。
CREATE OR REPLACE FUNCTION inventory_validate_doc_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_doc_type text;
  target_doc_type text;
  source_quantity numeric;
  linked_quantity numeric;
  surplus_source record;
  surplus_target record;
BEGIN
  IF NEW.relation_type = '盘点盘溢' THEN
    SELECT i.*, d.doc_type, d.status, d.source_org_node_id, d.target_org_node_id
      INTO surplus_source FROM inventory_doc_items i JOIN inventory_docs d ON d.id = i.doc_id
     WHERE i.id = NEW.from_item_id AND i.doc_id = NEW.from_doc_id FOR UPDATE OF i;
    SELECT i.*, d.doc_type, d.status, d.source_org_node_id, d.target_org_node_id
      INTO surplus_target FROM inventory_doc_items i JOIN inventory_docs d ON d.id = i.doc_id
     WHERE i.id = NEW.to_item_id AND i.doc_id = NEW.to_doc_id;
    IF surplus_source.id IS NULL OR surplus_target.id IS NULL
       OR surplus_source.status <> '已完成' OR surplus_target.status <> '已完成'
       OR NOT ((surplus_source.doc_type = '市场库存盘点' AND surplus_target.doc_type = '市场产品盘溢')
            OR (surplus_source.doc_type = '分院库存盘点' AND surplus_target.doc_type = '院产品盘溢'))
       OR surplus_source.source_org_node_id IS NULL OR surplus_target.target_org_node_id IS NULL
       OR surplus_source.source_org_node_id IS DISTINCT FROM surplus_source.target_org_node_id
       OR surplus_target.source_org_node_id IS DISTINCT FROM surplus_target.target_org_node_id
       OR surplus_source.source_org_node_id IS DISTINCT FROM surplus_target.target_org_node_id
       OR surplus_source.quantity = 'NaN'::numeric OR surplus_source.stock_snapshot = 'NaN'::numeric
       OR surplus_target.quantity = 'NaN'::numeric OR NEW.quantity = 'NaN'::numeric
       OR surplus_source.sku_id IS DISTINCT FROM surplus_target.sku_id
       OR surplus_source.stock_snapshot IS NULL
       OR surplus_source.quantity <= surplus_source.stock_snapshot
       OR NEW.quantity IS NULL OR NEW.quantity <= 0
       OR NEW.quantity IS DISTINCT FROM surplus_target.quantity THEN
      RAISE EXCEPTION 'INVALID_PARAMS: 盘点盘溢来源、主体、SKU 或差异数量无效';
    END IF;
    SELECT COALESCE(SUM(l.quantity), 0) INTO linked_quantity
      FROM inventory_doc_links l JOIN inventory_docs d ON d.id = l.to_doc_id
     WHERE l.from_item_id = NEW.from_item_id AND l.relation_type = '盘点盘溢'
       AND l.id IS DISTINCT FROM NEW.id AND d.status <> '已取消';
    IF linked_quantity + NEW.quantity > surplus_source.quantity - surplus_source.stock_snapshot THEN
      RAISE EXCEPTION 'CONFLICT: 盘溢数量超出来源盘点剩余正差异';
    END IF;
    RETURN NEW;
  END IF;

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
    OR (NEW.relation_type = '市场报货汇总'
      AND source_doc_type = '市场报货' AND target_doc_type = '市场报货汇总')
    OR (NEW.relation_type = '报货汇总采购订单'
      AND source_doc_type = '市场报货汇总' AND target_doc_type = '采购订单')
    OR (NEW.relation_type = '市场报货采购订单'
      AND source_doc_type = '市场报货' AND target_doc_type = '采购订单')
    OR (NEW.relation_type = '品项公司报货采购订单'
      AND source_doc_type = '品项公司报货需求' AND target_doc_type = '采购订单')
    OR (NEW.relation_type IN ('采购订单发货', '采购订单赠送发货')
      AND source_doc_type = '采购订单' AND target_doc_type = '品项公司发货')
    OR (NEW.relation_type IN ('市场报货发货', '市场报货赠送发货')
      AND source_doc_type = '市场报货' AND target_doc_type = '品项公司发货')
    OR (NEW.relation_type = '发货收货' AND (
      (source_doc_type = '品项公司发货' AND target_doc_type = '市场采购入库')
      OR (source_doc_type = '分院配货' AND target_doc_type = '院入库')
      OR (source_doc_type = '分院调货出库' AND target_doc_type = '分院调货入库')
      OR (source_doc_type = '市场间调货出库' AND target_doc_type = '市场间调货入库')
    ))
    OR (NEW.relation_type = '采购订单供应链采购入库'
      AND source_doc_type = '采购订单' AND target_doc_type = '供应链采购入库')
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

  -- 赠送不与来源明细对等（报 10 可送 12、多次发货累计赠送可超过报货量，#336），
  -- 三种赠送关系不做累计校验；上面的来源行锁照旧保留，与正常关系的写入同样串行。
  IF NEW.relation_type IN ('市场报货赠送发货', '门店报货赠送配货', '采购订单赠送发货') THEN
    RETURN NEW;
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
--> statement-breakpoint

-- 最新金额函数来自 0049；保留采购订单供应链计价。
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
    IF item_doc_type IN ('市场产品盘溢', '院产品盘溢') THEN
      effective_price := NEW.standard_unit_price;
    ELSIF item_doc_type IN (
      '供应链采购入库','供应链员工购出库','内部领用',
      '非凤御市场出库','供应链退货入库','品项公司报货需求','采购订单'
    ) THEN
      -- 采购订单（#335）：所有行都经供应链采购入库进总部库存，「采购数量」只表示对外采购量，
      -- 金额按供应链采购价计；市场行的市场结算价只保留在 market_* 参考列。
      effective_price := NEW.supply_chain_unit_cost;
    ELSIF item_doc_type IN (
      '市场报货汇总','品项公司发货','市场采购入库','市场退货','市场退货入库'
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
