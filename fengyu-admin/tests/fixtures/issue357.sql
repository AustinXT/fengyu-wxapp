BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM inventory_doc_links WHERE from_doc_id LIKE 'V357-%' OR to_doc_id LIKE 'V357-%';
DELETE FROM inventory_doc_items WHERE doc_id LIKE 'V357-%';
DELETE FROM inventory_docs WHERE id LIKE 'V357-%';
DELETE FROM inventory_locations WHERE location_id LIKE 'V357-%';
DELETE FROM org_nodes WHERE id LIKE 'V357-%';
DELETE FROM inventory_skus WHERE sku_id = 'V357-SKU';
DELETE FROM staff_wechat_users WHERE employee_id = 'V357-E';
INSERT INTO org_nodes (id, name, type, parent_id) VALUES
  ('V357-HQ', '测试总部', '总部', NULL),
  ('V357-MA', '测试市场 A', '市场', 'V357-HQ'),
  ('V357-STORE', '测试门店', '门店', 'V357-MA');
INSERT INTO staff_wechat_users (employee_id) VALUES ('V357-E');
INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id) VALUES
  ('V357-HQ', '总部', '测试总部', 'V357-HQ', NULL),
  ('V357-MA', '市场', '测试市场 A', 'V357-MA', 'V357-HQ'),
  ('V357-STORE', '门店', '测试门店', 'V357-STORE', 'V357-MA');
INSERT INTO inventory_skus (sku_id, product_code, product_name) VALUES ('V357-SKU', 'V357-P', '测试商品');
INSERT INTO inventory_cutover_states (cutover_key, status) VALUES ('workfine_inventory', '已初始化')
ON CONFLICT (cutover_key) DO UPDATE SET status = EXCLUDED.status;
INSERT INTO inventory_docs (id, doc_type, status, source_org_node_id, target_org_node_id, doc_date, total_quantity, created_by) VALUES
  ('V357-S', '门店报货', '已完成', 'V357-STORE', 'V357-MA', '2026-09-20', 10, 'V357-E'),
  ('V357-M', '市场报货', '已完成', 'V357-MA', 'V357-HQ', '2026-09-21', 10, 'V357-E'),
  ('V357-A', '市场报货汇总', '已完成', NULL, 'V357-HQ', '2026-09-22', 10, 'V357-E'),
  ('V357-P', '采购订单', '待收货', NULL, 'V357-HQ', '2026-09-23', 4, 'V357-E'),
  ('V357-Q', '供应链采购入库', '已完成', NULL, 'V357-HQ', '2026-09-24', 2, 'V357-E'),
  ('V357-H', '品项公司发货', '待收货', 'V357-HQ', 'V357-MA', '2026-09-25', 5, 'V357-E'),
  ('V357-R', '市场采购入库', '已完成', 'V357-HQ', 'V357-MA', '2026-09-26', 2, 'V357-E'),
  ('V357-A0', '市场报货汇总', '已完成', NULL, 'V357-HQ', '2026-09-27', 10, 'V357-E'),
  ('V357-A10', '市场报货汇总', '已完成', NULL, 'V357-HQ', '2026-09-28', 10, 'V357-E'),
  ('V357-AX', '市场报货汇总', '已取消', NULL, 'V357-HQ', '2026-09-29', 10, 'V357-E'),
  ('V357-RX', '品项公司报货需求', '已取消', NULL, 'V357-HQ', '2026-09-29', 10, 'V357-E'),
  ('V357-D', '市场报货', '草稿', 'V357-MA', NULL, '2026-09-29', 10, 'V357-E'),
  ('V357-DX', '市场报货', '已取消', 'V357-MA', NULL, '2026-09-29', 10, 'V357-E'),
  ('V357-MC', '市场报货', '已完成', 'V357-MA', 'V357-HQ', '2026-09-30', 10, 'V357-E'),
  ('V357-HC', '品项公司发货', '已取消', 'V357-HQ', 'V357-MA', '2026-09-30', 10, 'V357-E'),
  ('V357-SC', '门店报货', '已完成', 'V357-STORE', 'V357-MA', '2026-09-30', 10, 'V357-E'),
  ('V357-AC', '分院配货', '已取消', 'V357-MA', 'V357-STORE', '2026-09-30', 10, 'V357-E');
INSERT INTO inventory_doc_items (id, doc_id, sku_id, sku_name, quantity, fulfilled_quantity) VALUES
  (357001, 'V357-S', 'V357-SKU', '测试商品', 10, 0),
  (357002, 'V357-M', 'V357-SKU', '测试商品', 10, 0),
  (357003, 'V357-A', 'V357-SKU', '测试商品', 10, 4),
  (357004, 'V357-P', 'V357-SKU', '测试商品', 4, 2),
  (357005, 'V357-Q', 'V357-SKU', '测试商品', 2, 2),
  (357006, 'V357-H', 'V357-SKU', '测试商品', 3, 2),
  (357007, 'V357-R', 'V357-SKU', '测试商品', 2, 0),
  (357008, 'V357-A0', 'V357-SKU', '测试商品', 10, 0),
  (357009, 'V357-A10', 'V357-SKU', '测试商品', 10, 10),
  (357016, 'V357-AX', 'V357-SKU', '测试商品', 10, 0),
  (357017, 'V357-RX', 'V357-SKU', '测试商品', 10, 0),
  (357010, 'V357-D', 'V357-SKU', '测试商品', 10, 0),
  (357015, 'V357-DX', 'V357-SKU', '测试商品', 10, 0),
  (357011, 'V357-MC', 'V357-SKU', '测试商品', 10, 0),
  (357012, 'V357-HC', 'V357-SKU', '测试商品', 10, 0),
  (357013, 'V357-SC', 'V357-SKU', '测试商品', 10, 0),
  (357014, 'V357-AC', 'V357-SKU', '测试商品', 10, 0);
INSERT INTO inventory_doc_items (id, doc_id, sku_id, sku_name, quantity, fulfilled_quantity, is_gift)
VALUES (357018, 'V357-H', 'V357-SKU', '测试商品', 2, 0, true);
INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity) VALUES
  ('V357-S', 'V357-M', '门店报货汇总', 357001, 357002, 10),
  ('V357-M', 'V357-A', '市场报货汇总', 357002, 357003, 10),
  ('V357-A', 'V357-P', '报货汇总采购订单', 357003, 357004, 4),
  ('V357-M', 'V357-P', '市场报货采购订单', 357002, 357004, 4),
  ('V357-P', 'V357-Q', '采购订单供应链采购入库', 357004, 357005, 2),
  ('V357-M', 'V357-H', '市场报货发货', 357002, 357006, 3),
  ('V357-M', 'V357-H', '市场报货赠送发货', 357002, 357018, 2),
  ('V357-H', 'V357-R', '发货收货', 357006, 357007, 2),
  ('V357-MC', 'V357-HC', '市场报货发货', 357011, 357012, 10),
  ('V357-SC', 'V357-AC', '门店报货配货', 357013, 357014, 10);
COMMIT;
