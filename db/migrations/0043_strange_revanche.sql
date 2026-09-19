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

-- 2) doc_type 收敛：`供应链采购订单` 并入 `采购订单`（#194）。
--    单号 id 一律不动（存量 PCG-* 前缀保留），类型判断已由上面的行级 market_id 接管。
--    收紧 chk_inventory_docs_type（移除 `供应链采购订单`、加入 `市场报货汇总`）放在下一条
--    migration，必须等本条的数据收敛先落库，否则加约束时存量行会违反。
UPDATE inventory_docs
   SET doc_type = '采购订单'
 WHERE doc_type = '供应链采购订单';