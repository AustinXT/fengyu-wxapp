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

-- 3) doc_type 收敛：`供应链采购订单` 并入 `采购订单`（#194）。
--    单号 id 一律不动（存量 PCG-* 前缀保留），类型判断已由上面的行级 market_id 接管。
--    收紧 chk_inventory_docs_type（移除 `供应链采购订单`、加入 `市场报货汇总`）放在下一条
--    migration，必须等本条的数据收敛先落库，否则加约束时存量行会违反。
--
--    ⚠️ 必须临时摘掉上面那个守卫：它里面有「库存单据创建后禁止修改单据类型」一条，
--    而这次收敛干的正是改类型。空库上这条 UPDATE 影响 0 行、根本不触发 trigger，
--    真实库（dev 有 7 张待收货的供应链采购订单）则会被直接 RAISE 拦下。
ALTER TABLE inventory_docs DISABLE TRIGGER trg_inventory_docs_validate_lifecycle;--> statement-breakpoint
UPDATE inventory_docs
   SET doc_type = '采购订单'
 WHERE doc_type = '供应链采购订单';--> statement-breakpoint
ALTER TABLE inventory_docs ENABLE TRIGGER trg_inventory_docs_validate_lifecycle;