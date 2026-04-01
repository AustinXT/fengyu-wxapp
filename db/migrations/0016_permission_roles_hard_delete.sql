-- 权限角色改为硬删除，移除 is_void / voided_at 软删除字段

-- 1. 删除含 is_void=false 的已撤销记录（清理历史数据）
DELETE FROM permission_roles WHERE is_void = true;

-- 2. 删除旧的部分唯一索引
DROP INDEX IF EXISTS uq_perm_roles_emp_role_scope;

-- 3. 删除 is_void 和 voided_at 列
ALTER TABLE permission_roles DROP COLUMN is_void;
ALTER TABLE permission_roles DROP COLUMN voided_at;

-- 4. 创建新的唯一索引（无 WHERE 条件）
CREATE UNIQUE INDEX uq_perm_roles_emp_role_scope ON permission_roles (employee_id, role, scope_id);
