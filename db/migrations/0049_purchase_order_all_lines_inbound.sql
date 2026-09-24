-- #335 采购订单的所有行（不论市场来源）都走供应链采购入库，行金额统一按供应链采购价。
--
-- 1) 事前断言：存量采购行（非赠送）缺供应链采购价就中止，列出单号与行 id 由人工逐条处理，
--    不静默置 0（issue 验收要求）。
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(format('%s#%s', item.doc_id, item.id), ', ' ORDER BY item.doc_id, item.id)
    INTO missing
    FROM inventory_doc_items item
    JOIN inventory_docs doc ON doc.id = item.doc_id
   WHERE doc.doc_type = '采购订单'
     AND NOT item.is_gift
     AND item.supply_chain_unit_cost IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0049: 以下采购订单明细缺少供应链采购价，请先补齐再迁移：%', missing;
  END IF;
END;
$$;--> statement-breakpoint

-- 2) 金额兜底的价基分档：`采购订单` 不再按行级 market_id 分档，一律取供应链采购价
--    （市场结算价只作 market_* 参考列）。函数体复制自 0043，只改采购订单一档。
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
$$;--> statement-breakpoint

-- 3) 存量市场行的实际单价原本写的是市场实际单价，触发器优先取它，必须一并改成供应链采购价。
--    标准价同步为供应链采购价、折扣置空（与品项公司自用行的写法一致）。
--    改 actual_unit_price 会触发金额重算（BEFORE 触发器）与单头汇总刷新（AFTER 触发器）。
--    单据状态不动（#335 Q1=B：存量纯市场单保持「已完成」）。
--    market_* 参考列只补不改：市场行的参考列为空时，先把原实际单价（即市场结算价）存进去，
--    覆盖 actual_unit_price 后才不丢市场价；自用行不碰。单独一条，免得被下一条的门控漏掉
--    「市场结算价恰好等于供应链采购价」的行。
UPDATE inventory_doc_items item
   SET market_actual_unit_price = item.actual_unit_price
  FROM inventory_docs doc
 WHERE doc.id = item.doc_id
   AND doc.doc_type = '采购订单'
   AND NOT item.is_gift
   AND item.market_id IS NOT NULL
   AND item.market_actual_unit_price IS NULL
   AND item.actual_unit_price IS NOT NULL;--> statement-breakpoint

UPDATE inventory_doc_items item
   SET actual_unit_price = item.supply_chain_unit_cost,
       standard_unit_price = item.supply_chain_unit_cost,
       unit_discount = NULL
  FROM inventory_docs doc
 WHERE doc.id = item.doc_id
   AND doc.doc_type = '采购订单'
   AND NOT item.is_gift
   AND (item.actual_unit_price, item.standard_unit_price, item.unit_discount)
       IS DISTINCT FROM (item.supply_chain_unit_cost, item.supply_chain_unit_cost, NULL::numeric);--> statement-breakpoint

-- 3b) #335 起采购行 fulfilled_quantity 只记「已入库量」。上线前市场行的这一列记的是发货量，
--     在途（待收货）单若不重置，会提前完结、超量入库或误标「部分入库」。
--     按已完成的入库血缘重算；已完成 / 已取消的单据不动（Q1=B：存量保持原状）。
--     prod / dev 迁移时实测均无待收货的含市场行采购单，这一步是防御。
WITH received AS (
  SELECT item.id,
         COALESCE(SUM(link.quantity), 0) AS quantity
    FROM inventory_doc_items item
    JOIN inventory_docs doc ON doc.id = item.doc_id
    LEFT JOIN (
      inventory_doc_links link
      JOIN inventory_docs receipt_doc
        ON receipt_doc.id = link.to_doc_id
       AND receipt_doc.status = '已完成'
    ) ON link.from_item_id = item.id
     AND link.relation_type = '采购订单供应链采购入库'
   WHERE doc.doc_type = '采购订单'
     AND doc.status = '待收货'
     AND item.market_id IS NOT NULL
   GROUP BY item.id
)
UPDATE inventory_doc_items target
   SET fulfilled_quantity = received.quantity
  FROM received
 WHERE target.id = received.id
   AND COALESCE(target.fulfilled_quantity, 0) IS DISTINCT FROM received.quantity;--> statement-breakpoint

-- 4) 事后断言：明细金额 = 数量 × 供应链采购价，单头金额 = 明细之和。
DO $$
DECLARE
  bad_items text;
  bad_docs text;
BEGIN
  SELECT string_agg(format('%s#%s', item.doc_id, item.id), ', ')
    INTO bad_items
    FROM inventory_doc_items item
    JOIN inventory_docs doc ON doc.id = item.doc_id
   WHERE doc.doc_type = '采购订单'
     AND NOT item.is_gift
     AND item.amount IS DISTINCT FROM ROUND(item.quantity * item.supply_chain_unit_cost, 2);
  IF bad_items IS NOT NULL THEN
    RAISE EXCEPTION '0049: 采购订单明细金额与供应链采购价不符：%', bad_items;
  END IF;
  SELECT string_agg(doc.id, ', ')
    INTO bad_docs
    FROM inventory_docs doc
   WHERE doc.doc_type = '采购订单'
     AND doc.total_amount IS DISTINCT FROM (
       SELECT CASE WHEN COUNT(item.amount) = 0 THEN NULL ELSE SUM(item.amount) END
         FROM inventory_doc_items item
        WHERE item.doc_id = doc.id
     );
  IF bad_docs IS NOT NULL THEN
    RAISE EXCEPTION '0049: 采购订单单头金额与明细之和不符：%', bad_docs;
  END IF;
END;
$$;
