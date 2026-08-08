-- ============================================================================
-- seed-fyfix-staff.sql — e2e 服务员工 fixture（让营业额分配/服务提成能选到员工）
--
-- 背景（2026-06-09）：seed-e2e-fixtures 建的 FY-TEST-* 账号 skills 全为 NULL，营业额分配
-- detail 页先选技能标签（美容师/养生师/推广师）再按 skills 筛选该门店员工——无技能员工时
-- 员工 select 为空 → 比例 select 不 enable → link-1 等分配步骤 selectOption 超时。
--
-- 本脚本给 store-nc01 补 3 个服务员工（带 skills）+ 给店长 FY-TEST-MGR 补技能，使
-- getEmployees()（scope 内）返回的 store-nc01 员工含「美容师/养生师」技能，分配可选。
-- 不建 admin_passwords（分配对象无需登录）。
--
-- skills 为 text[]（格式 {美容师,养生师}）；phone 唯一，用 139001390{10,11,12} 避开账号 00-07。
-- 幂等：ON CONFLICT DO UPDATE。
-- ============================================================================
BEGIN;

-- 技能标签查找表（skill_tags）：营业额分配/服务提成 detail 页技能标签 select 的选项来源
-- （actions/skill-tags.ts getActiveSkillTags 查 is_valid=true）。fengyu_wxapp 该表为空会导致
-- 技能标签 select 无选项、分配步骤 selectOption('美容师') 超时。
INSERT INTO skill_tags (id, name, sort_order, is_valid, created_at, updated_at) VALUES
  ('stag-fyfix-mr', '美容师',   1, true, NOW(), NOW()),
  ('stag-fyfix-ys', '养生师',   2, true, NOW(), NOW()),
  ('stag-fyfix-tg', '推广师',   3, true, NOW(), NOW()),
  ('stag-fyfix-px', '品项老师', 4, true, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- 给店长补技能（让其也可作分配对象）
UPDATE staff_wechat_users
  SET skills = ARRAY['美容师','养生师','推广师']::text[], updated_at = NOW()
  WHERE employee_id = 'FY-TEST-MGR';

-- store-nc01 服务员工（营业额分配/服务提成的分配对象，按 skills 筛选）
INSERT INTO staff_wechat_users
  (employee_id, name, phone, store_id, org_node_id, gender, position_name, skills, is_resigned, created_at, updated_at)
VALUES
  ('FY-TEST-EMP-MR1', '测试美容师A', '13900139010', 'store-nc01', 'org-store-nc01', '女', '美容师', ARRAY['美容师']::text[],            false, NOW(), NOW()),
  ('FY-TEST-EMP-MR2', '测试美容师B', '13900139011', 'store-nc01', 'org-store-nc01', '女', '美容师', ARRAY['美容师','养生师']::text[], false, NOW(), NOW()),
  ('FY-TEST-EMP-YS1', '测试养生师A', '13900139012', 'store-nc01', 'org-store-nc01', '女', '养生师', ARRAY['养生师']::text[],            false, NOW(), NOW())
ON CONFLICT (employee_id) DO UPDATE SET
  skills = EXCLUDED.skills, store_id = EXCLUDED.store_id, org_node_id = EXCLUDED.org_node_id,
  position_name = EXCLUDED.position_name, is_resigned = false, updated_at = NOW();

-- promoter 员工（link-16 顾客 promoter 重分配；client_wechat_users 仅保存姓名快照）
INSERT INTO staff_wechat_users
  (employee_id, name, phone, store_id, org_node_id, gender, position_name, skills, is_resigned, created_at, updated_at)
VALUES
  ('FY-260101-0001', '张明', '13900139013', 'store-nc01', 'org-store-nc01', '男', '推广师', ARRAY['推广师']::text[], false, NOW(), NOW()),
  ('FY-260101-0002', '刘芳', '13900139014', 'store-nc01', 'org-store-nc01', '女', '推广师', ARRAY['推广师']::text[], false, NOW(), NOW())
ON CONFLICT (employee_id) DO UPDATE SET
  name = EXCLUDED.name, store_id = EXCLUDED.store_id, org_node_id = EXCLUDED.org_node_id,
  position_name = EXCLUDED.position_name, is_resigned = false, updated_at = NOW();

-- 提成矩阵行（link-15 矩阵编辑即时生效 + 历史快照保护；spec TARGET_MATRIX_ID=1）
-- 南昌市场(6707cc8b88579108) / 销售单 / 美容师 / 自销自耗 / [0,5000) = 0.08
INSERT INTO commission_rate_matrix
  (id, org_id, order_type, role_type, sales_category, amount_tier_min, amount_tier_max, commission_rate, created_at, updated_at)
VALUES
  (1, '6707cc8b88579108', '销售单', '美容师', '自销自耗', 0, 5000, 0.0800, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  org_id = EXCLUDED.org_id, order_type = EXCLUDED.order_type, role_type = EXCLUDED.role_type,
  sales_category = EXCLUDED.sales_category, amount_tier_min = EXCLUDED.amount_tier_min,
  amount_tier_max = EXCLUDED.amount_tier_max, commission_rate = 0.0800, updated_at = NOW();
-- 重置序列，避免后续 nextval 与显式 id=1 冲突
SELECT setval('commission_rate_matrix_id_seq', GREATEST(1, (SELECT MAX(id) FROM commission_rate_matrix)));

COMMIT;

SELECT employee_id, store_id, position_name, skills::text FROM staff_wechat_users
  WHERE employee_id LIKE 'FY-TEST-EMP-%' OR employee_id = 'FY-TEST-MGR' ORDER BY employee_id;
