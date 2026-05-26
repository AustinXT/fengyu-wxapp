-- order_type: 英文 → 中文
UPDATE commission_rate_matrix SET order_type = '销售单' WHERE order_type = 'sale';
UPDATE commission_rate_matrix SET order_type = '服务单' WHERE order_type = 'service';

-- role_type: 技师 → 美容师 + 养生师（复制行后更新原行）
INSERT INTO commission_rate_matrix (org_id, order_type, role_type, sales_category, amount_tier_min, amount_tier_max, commission_rate)
SELECT org_id, order_type, '养生师', sales_category, amount_tier_min, amount_tier_max, commission_rate
FROM commission_rate_matrix
WHERE role_type = '技师';

UPDATE commission_rate_matrix SET role_type = '美容师' WHERE role_type = '技师';
