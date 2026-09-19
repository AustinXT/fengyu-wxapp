ALTER TABLE "inventory_docs" DROP CONSTRAINT "chk_inventory_docs_type";--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_type" CHECK ("inventory_docs"."doc_type" IN (
        '门店报货','市场报货','市场报货汇总','品项公司报货需求','采购订单',
        '供应链采购入库','品项公司发货','市场采购入库','自采产品入库','分院配货',
        '院入库','分院调货出库','分院调货入库','市场间调货出库','市场间调货入库',
        '员工购出库','供应链员工购出库','内部领用','非凤御市场出库','市场退货','市场退货入库',
        '供应链退货入库','院退货','院顾客产品出库','院顾客退货','市场产品报损',
        '院产品报损','市场产品盘溢','市场库存盘点','分院库存盘点','库存转换出库',
        '库存转换入库','期初库存'
      ));