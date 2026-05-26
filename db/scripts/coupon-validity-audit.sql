-- coupon-validity-audit.sql
-- ============================================================
-- 优惠券模板有效期脏数据预检 + 365-fallback 已发放券稽核
-- 关联 ticket: notes/tickets/coupon-template-validity-validation.md §5.1
-- 关联 PR:    941e214 merge: 补齐优惠券模板有效期前后端校验
--
-- 使用场景：
--   1. 在发布 §5.4（删除 issueCoupon/batchIssueCoupons 的 365 天 fallback）
--      **之前**运行 Q1，确认活跃脏模板为 0 行。非 0 时必须先手工补填
--      或将对应模板停用（操作留痕写 operation_logs）。
--   2. Q2 用于稽核，列出所有"曾经可能走过 fallback"的已发放券。一般
--      不回改 expire_at，仅作存档。
--
-- 运行方式（以本地 docker 开发环境为例）：
--   psql "$PG_CONNECTION_STRING" -f db/scripts/coupon-validity-audit.sql
-- ============================================================

-- Q1 活跃脏模板：必须为 0 行后才能上线 §5.4
SELECT template_id,
       name,
       coupon_type,
       validity_mode,
       valid_days,
       valid_from,
       valid_to,
       is_active
FROM coupon_templates
WHERE is_active = true
  AND (
    validity_mode IS NULL
    OR (validity_mode = 'days'  AND valid_days IS NULL)
    OR (validity_mode = 'fixed' AND (valid_from IS NULL OR valid_to IS NULL OR valid_from >= valid_to))
  );

-- Q2 已走过 365 fallback 的已发放券（稽核用，一般不回改 expire_at）
SELECT uc.coupon_id,
       uc.template_id,
       uc.user_id,
       uc.expire_at,
       uc.created_at
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
WHERE ct.validity_mode IS NULL
   OR (ct.validity_mode = 'days'  AND ct.valid_days IS NULL)
   OR (ct.validity_mode = 'fixed' AND ct.valid_to IS NULL);
