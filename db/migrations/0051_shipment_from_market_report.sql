ALTER TABLE "inventory_doc_links" DROP CONSTRAINT "chk_inventory_doc_links_relation_type";--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_relation_type" CHECK ("inventory_doc_links"."relation_type" IN (
        '门店报货汇总','市场报货汇总','市场报货采购订单','报货汇总采购订单','品项公司报货采购订单',
        '采购订单发货','采购订单赠送发货','市场报货发货','市场报货赠送发货','发货收货','采购订单供应链采购入库',
        '门店报货配货','门店报货赠送配货','退货回库','库存转换','历史关联'
      ));--> statement-breakpoint

-- #336：品项公司发货改为直接引用市场报货单。
-- 链接守卫（最后一次定义在 0043）逐字复制后只改两处：
--   · 白名单加 `市场报货发货` / `市场报货赠送发货`：市场报货 → 品项公司发货；
--   · 赠送关系（市场报货赠送发货 / 门店报货赠送配货 / 采购订单赠送发货）不再做「累计不超过来源明细」。
-- 旧的 `采购订单发货` / `采购订单赠送发货` 保留在 CHECK 与白名单里，只供存量只读，不再有新写入。
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
