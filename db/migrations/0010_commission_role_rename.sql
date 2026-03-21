-- 统一角色类型：推广 → 推广师，删除顾问
UPDATE commission_rate_matrix SET role_type = '推广师', updated_at = NOW() WHERE role_type = '推广';
DELETE FROM commission_rate_matrix WHERE role_type = '顾问';

-- 员工技能标签同步
UPDATE staff_wechat_users SET skills = array_replace(skills, '推广', '推广师') WHERE '推广' = ANY(skills);
