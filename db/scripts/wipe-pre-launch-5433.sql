-- ⚠ 历史脚本（已执行完毕）：下文的 47.113.202.7 / 5434 是当时的旧拓扑，保留原文以还原语境。
--   该机已于 2026-09-01 全面弃用，当前拓扑见 db/CLAUDE.md，**不要照抄下面的连接串**。
-- ============================================================
-- 试运营前 · 生产库（5433/fengyu_wxapp）数据清空脚本
-- 目标库: postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp
-- 用途: 清空模拟运营产生的交易数据 + 测试夹具，保留真实配置主数据
-- 决策: 资产全清零 / 删6家测试门店+对应组织节点 / 删8个FY-TEST员工 /
--       删8个e2e测试顾客 / 保留3个"测试-"员工(944/945/15258844354)迁出测试门店
--
-- 本脚本不含 BEGIN/COMMIT —— 由调用方注入事务控制:
--   预演: psql ... -v ON_ERROR_STOP=1 -1 -c "BEGIN" -f 本文件 -c "ROLLBACK"
--   执行: psql ... -v ON_ERROR_STOP=1 -1 -c "BEGIN" -f 本文件 -c "COMMIT"
-- ============================================================

-- ========== 第 1 步: 断引用（解除配置表对将被删配置行的 FK 引用）==========

-- 1.1 顾客绑定到测试门店的 → 置空（实测33个顾客指向5个测试门店）
UPDATE client_wechat_users SET bound_store_id = NULL, updated_at = NOW()
WHERE bound_store_id IN (
  'store-nc01','b79a82e33d6cf4f3','store-nc02',
  'store-1779379727652','store-1779843765096'
);

-- 1.2 3个保留"测试-"员工迁出测试门店（store_id置空, org_node_id→ORG-HQ）
UPDATE staff_wechat_users SET store_id = NULL, org_node_id = 'ORG-HQ', updated_at = NOW()
WHERE employee_id IN ('EMP-ADMIN-001','FY-260522001','FY-260522003');

-- 1.3 3个保留员工 permission_roles.scope 从测试门店节点迁到 ORG-HQ
--     (唯一约束 uq_perm_roles_emp_role_scope = employee_id+role+scope_id，ORG-HQ 下无同 role 冲突)
UPDATE permission_roles SET scope_id = 'ORG-HQ', updated_at = NOW()
WHERE scope_id = 'org-门店-1779379417145'
  AND employee_id IN ('EMP-ADMIN-001','FY-260522001','FY-260522003');

-- ========== 第 2 步: TRUNCATE 27 张运营/交易表（RESTART IDENTITY 重置序列）==========

TRUNCATE TABLE
  sale_orders,
  sale_items,
  sale_allocations,
  sale_order_payments,
  sale_payment_allocatable_items,
  service_orders,
  service_items,
  service_reviews,
  service_commissions,
  appointments,
  store_unbind_requests,
  pickup_records,
  card_transactions,
  prepaid_cards,
  point_transactions,
  user_coupons,
  inventory_movements,
  inventory_doc_links,
  inventory_stock_reservations,
  inventory_doc_items,
  inventory_docs,
  inventory_stock_lots,
  inventory_cutover_states,
  inventory_import_refs,
  operation_logs,
  messages,
  login_attempts
RESTART IDENTITY;

-- ========== 第 3 步: 重置保留顾客的资产/分类缓存字段（运营累积，全部归零）==========

UPDATE client_wechat_users SET
  points_balance = 0,
  points_updated_at = NULL,
  member_level = NULL,
  member_level_locked_until = NULL,
  member_level_upgraded_at = NULL,
  old_member_level = NULL,
  customer_type = '流量客',
  became_member_at = NULL,
  spending_tier = '<1990',
  monthly_activity = NULL,
  customer_status = NULL,
  is_cross_store_temp = false,
  updated_at = NOW();

-- ========== 第 4 步: 删测试配置行（子→父 FK 顺序）==========

-- 4.1 删 8 个 FY-TEST-* 的 admin 登录账号（FK→staff，必须先于 staff 删除）
DELETE FROM admin_passwords WHERE employee_id LIKE 'FY-TEST-%';

-- 4.2 删 8 个 FY-TEST-* 的权限角色（FK→staff 与→org_nodes，须先于二者删除）
DELETE FROM permission_roles WHERE employee_id LIKE 'FY-TEST-%';

-- 4.3 删 8 个 e2e 前缀测试顾客（含 Fixture测试客）
DELETE FROM client_wechat_users WHERE user_id IN (
  'FY-FIX-CLIENT-01','FY-TEST-CLIENT-NC02','FY-TEST-CLIENT-OM',
  'FY-TEST-CRON-01','FY-TEST-CRON-02','FY-TEST-CRON-03',
  'FY-TEST-CRON-04','FY-TEST-CRON-05'
);

-- 4.4 删 8 个 FY-TEST-* 测试员工（须先于 stores 删除：staff.store_id→stores）
DELETE FROM staff_wechat_users WHERE employee_id LIKE 'FY-TEST-%';

-- 4.5 删 5 个测试门店（须先于 org_nodes 删除：stores.org_node_id→org_nodes）
DELETE FROM stores WHERE store_id IN (
  'store-nc01','b79a82e33d6cf4f3','store-nc02',
  'store-1779379727652','store-1779843765096'
);

-- 4.6 删 9 个测试组织节点（org_nodes.parent_id 自引用 → 按 门店→市场→总部 反向删）
DELETE FROM org_nodes WHERE id IN (
  'org-store-nc01','org-store-other','org-store-nc02',
  'org-门店-1779379417145','org-门店-1779843606172'
);
DELETE FROM org_nodes WHERE id IN (
  '6707cc8b88579108','ec9ca0f5c96be174','org-市场-1779843548707'
);
DELETE FROM org_nodes WHERE id IN ('16d1184b46db099a');

-- ============================================================
-- 预期结果: 运营表全空; stores=38; staff=155; client=107;
--          顾客资产全归零; admin_passwords/system_configs/商品/拉卡拉商户不变
-- ============================================================
