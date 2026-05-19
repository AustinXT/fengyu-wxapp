-- ============================================================================
-- fengyu-staff/tests/scope-isolation/seed-openids.sql
--
-- 为 admin 端 e2e-chains 已 seed 的 FY-TEST-* 员工分配确定性 openid，
-- 让 staff 端 _testOpenid 通道可以认领它们。
--
-- 命名约定：openid = 'staff-scope-{employee_id}'，与生产真实 wxapp openid 不冲突。
--
-- 幂等：ON CONFLICT 时也强制覆盖 openid（防止之前 seed 用了别的值）。
-- ============================================================================

BEGIN;

-- 4 个跨 scope 角色的 openid
UPDATE staff_wechat_users SET openid='staff-scope-FY-TEST-MGR'  WHERE employee_id='FY-TEST-MGR';
UPDATE staff_wechat_users SET openid='staff-scope-FY-TEST-MGR2' WHERE employee_id='FY-TEST-MGR2';
UPDATE staff_wechat_users SET openid='staff-scope-FY-TEST-MKT'  WHERE employee_id='FY-TEST-MKT';
UPDATE staff_wechat_users SET openid='staff-scope-FY-TEST-ADM'  WHERE employee_id='FY-TEST-ADM';

COMMIT;

-- 验证
SELECT employee_id, openid, store_id, org_node_id
FROM staff_wechat_users
WHERE employee_id IN ('FY-TEST-MGR','FY-TEST-MGR2','FY-TEST-MKT','FY-TEST-ADM')
ORDER BY employee_id;
