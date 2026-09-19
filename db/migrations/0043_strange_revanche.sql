ALTER TABLE "inventory_doc_links" DROP CONSTRAINT "chk_inventory_doc_links_relation_type";--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "supplier_id" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD COLUMN "market_id" text;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_supplier_id_inventory_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."inventory_suppliers"("supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_market_id_org_nodes_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_supplier" ON "inventory_doc_items" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_market" ON "inventory_doc_items" USING btree ("market_id");--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_relation_type" CHECK ("inventory_doc_links"."relation_type" IN (
        '门店报货汇总','市场报货汇总','市场报货采购订单','报货汇总采购订单','品项公司报货采购订单',
        '采购订单发货','采购订单赠送发货','发货收货','采购订单供应链采购入库',
        '门店报货配货','门店报货赠送配货','退货回库','库存转换','历史关联'
      ));--> statement-breakpoint
-- ↓↓↓ 以下为手写数据回填（#194），drizzle-kit 生成的部分到上一条为止 ↓↓↓

-- 1) 存量采购订单明细行补齐行级供应商 / 市场归属，来源是各自单头。
--    收敛之后下游按行级 market_id 分流（非空走品项公司发货、NULL 走供应链采购入库），
--    存量行不回填就会在发货 / 入库时被判成另一条链路。
--    `供应链采购订单` 单头 market_id 本就是 NULL，回填后行级同为 NULL，正是供应链链路行的标识。
UPDATE inventory_doc_items i
   SET supplier_id = COALESCE(i.supplier_id, d.supplier_id),
       market_id   = COALESCE(i.market_id, d.market_id)
  FROM inventory_docs d
 WHERE i.doc_id = d.id
   AND d.doc_type IN ('采购订单', '供应链采购订单');--> statement-breakpoint

-- 2) 生命周期守卫跟随收敛：`待收货` 白名单里的 `供应链采购订单` 换成 `采购订单`。
--    这个 BEFORE trigger 由 0009 建立，Drizzle schema 表达不了它，只能在 migration 里改。
--    不改的话，合并后**含供应链行的采购订单**建单即被 RAISE 拦下（它的状态正是待收货）。
--    其余三段判断逐字保留 0009 原文，只动第一段的类型清单。
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
$$;--> statement-breakpoint

-- 3) 血缘白名单跟随收敛（#193 #194）。0009 的 `inventory_validate_doc_link` 里写死了
--    relation_type ↔ (来源单类型 → 目标单类型) 的配对表，Drizzle schema 同样表达不了它。
--    不改的话整条链路会在 DB 层被 RAISE 拦死，三处都会中招：
--      · 新的 `市场报货汇总` / `报货汇总采购订单` 根本不在表里；
--      · `品项公司报货采购订单` 的目标此前写死 `供应链采购订单`，收敛后目标是 `采购订单`；
--      · `采购订单供应链采购入库` 的来源同理。
--    白名单之外的部分（历史关联分支、来源明细行锁、累计数量不得超来源）逐字保留 0009 原文。
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
$$;--> statement-breakpoint

-- 4) 金额兜底的价基分档跟随收敛（#193 #194）。0039 的 `inventory_set_doc_item_amount`
--    在 `actual_unit_price` 为空时按 doc_type 选价基：`供应链采购订单` 那一档随收敛消失，
--    而合并后的 `采购订单` 一张单含两类行，doc_type 已不足以分档 —— 改按行级 market_id 分。
--    新增的 `市场报货汇总` 此前会落进 ELSE 分支、用**门店进货价**算金额（比写 0 更误导）。
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
      '非凤御市场出库','供应链退货入库','品项公司报货需求'
    ) THEN
      effective_price := NEW.supply_chain_unit_cost;
    ELSIF item_doc_type = '采购订单' THEN
      -- 合并后（#194）一张采购单可同时含两类行，doc_type 已不足以分档：
      -- 有市场归属的行按市场实际单价，品项公司自用行（market_id 为空）按供应链成本
      -- —— 后者正是收敛前那一档的语义。
      IF NEW.market_id IS NULL THEN
        effective_price := NEW.supply_chain_unit_cost;
      ELSE
        effective_price := NEW.market_actual_unit_price;
      END IF;
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

-- 5) doc_type 收敛：`供应链采购订单` 并入 `采购订单`（#194）。
--    单号 id 一律不动（存量 PCG-* 前缀保留），类型判断已由上面的行级 market_id 接管。
--    收紧 chk_inventory_docs_type（移除 `供应链采购订单`、加入 `市场报货汇总`）放在下一条
--    migration，必须等本条的数据收敛先落库，否则加约束时存量行会违反。
--
--    ⚠️ 必须临时摘掉上面那个守卫：它里面有「库存单据创建后禁止修改单据类型」一条，
--    而这次收敛干的正是改类型。空库上这条 UPDATE 影响 0 行、根本不触发 trigger，
--    真实库（dev 有 7 张待收货的供应链采购订单）则会被直接 RAISE 拦下。
--
--    安全前提是 `drizzle-kit migrate` 把整个文件包进**一个事务**：DISABLE 取的表级锁
--    持有到提交，其它连接在这期间根本进不来。若有人 `psql -f` 逐句执行，
--    DISABLE 与 ENABLE 之间就留出了一个能绕过守卫的窗口 —— 那样必须自己包
--    `BEGIN; ... COMMIT;`。下面第 6 段的断言是这条纪律的兜底。
ALTER TABLE inventory_docs DISABLE TRIGGER trg_inventory_docs_validate_lifecycle;--> statement-breakpoint
UPDATE inventory_docs
   SET doc_type = '采购订单'
 WHERE doc_type = '供应链采购订单';--> statement-breakpoint
ALTER TABLE inventory_docs ENABLE TRIGGER trg_inventory_docs_validate_lifecycle;--> statement-breakpoint

-- 6) 收口断言：确认守卫确实回到了启用态。
--    DISABLE / ENABLE 这对语句在同一事务里是安全的（表级锁持有到提交，别的会话进不来），
--    真正的风险是有人把 migration 拆开手工执行（本项目 0039 有过先例）——
--    一旦 ENABLE 那条没跑成，守卫会**永久关闭**且没有任何告警，此后所有非法
--    doc_type 改写与非法状态跃迁全部静默放行。宁可让迁移在这里失败。
DO $$
BEGIN
  IF (
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_inventory_docs_validate_lifecycle'
  ) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION '库存单据生命周期守卫未恢复启用，迁移中止';
  END IF;
END $$;
