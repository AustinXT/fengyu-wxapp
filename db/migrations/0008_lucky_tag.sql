ALTER TABLE "inventory_stock_lots" ADD COLUMN "supplier_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_doc_items_id_doc" ON "inventory_doc_items" USING btree ("id","doc_id");--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_from_item_doc_fk" FOREIGN KEY ("from_item_id","from_doc_id") REFERENCES "public"."inventory_doc_items"("id","doc_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_to_item_doc_fk" FOREIGN KEY ("to_item_id","to_doc_id") REFERENCES "public"."inventory_doc_items"("id","doc_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_parent_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("parent_location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_doc_item_doc_fk" FOREIGN KEY ("doc_item_id","doc_id") REFERENCES "public"."inventory_doc_items"("id","doc_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_stock_lots" ADD CONSTRAINT "inventory_stock_lots_supplier_id_inventory_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."inventory_suppliers"("supplier_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_stock_lots" ADD CONSTRAINT "inventory_stock_lots_source_doc_id_inventory_docs_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_lots_supplier" ON "inventory_stock_lots" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_lots_source_doc" ON "inventory_stock_lots" USING btree ("source_doc_id");--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_item_pair" CHECK (("inventory_doc_links"."from_item_id" IS NULL) = ("inventory_doc_links"."to_item_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_quantity_shape" CHECK (("inventory_doc_links"."from_item_id" IS NULL AND "inventory_doc_links"."quantity" IS NULL)
        OR ("inventory_doc_links"."from_item_id" IS NOT NULL AND "inventory_doc_links"."quantity" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "chk_inventory_doc_links_relation_type" CHECK ("inventory_doc_links"."relation_type" IN (
        '门店报货汇总','市场报货采购订单','品项公司报货采购订单',
        '采购订单发货','采购订单赠送发货','发货收货','采购订单供应链采购入库',
        '门店报货配货','门店报货赠送配货','退货回库','库存转换','历史关联'
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_type" CHECK ("inventory_docs"."doc_type" IN (
        '门店报货','市场报货','品项公司报货需求','采购订单','供应链采购订单',
        '供应链采购入库','品项公司发货','市场采购入库','自采产品入库','分院配货',
        '院入库','分院调货出库','分院调货入库','市场间调货出库','市场间调货入库',
        '员工购出库','内部领用','非凤御市场出库','市场退货','市场退货入库',
        '供应链退货入库','院退货','院顾客产品出库','院顾客退货','市场产品报损',
        '院产品报损','市场产品盘溢','市场库存盘点','分院库存盘点','库存转换出库',
        '库存转换入库','期初库存'
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "chk_inventory_locations_parent_not_self" CHECK ("inventory_locations"."parent_location_id" IS NULL OR "inventory_locations"."parent_location_id" <> "inventory_locations"."location_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "chk_inventory_movements_direction_delta" CHECK (("inventory_movements"."direction" = '入库' AND "inventory_movements"."quantity_delta" > 0)
        OR ("inventory_movements"."direction" = '出库' AND "inventory_movements"."quantity_delta" < 0)
        OR ("inventory_movements"."direction" = '调整' AND "inventory_movements"."quantity_delta" <> 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "chk_inventory_movements_balance" CHECK ("inventory_movements"."quantity_after" = "inventory_movements"."quantity_before" + "inventory_movements"."quantity_delta") NOT VALID;
