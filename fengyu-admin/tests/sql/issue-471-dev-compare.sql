BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
WITH periods(label, start_date, end_date) AS (
  VALUES ('pre', DATE '2026-07-01', DATE '2026-07-03'),
         ('cross', DATE '2026-07-01', DATE '2026-07-31'),
         ('post', DATE '2026-07-04', DATE '2026-07-31')
), base AS (
  SELECT p.label, p.start_date, p.end_date,
    (SELECT COUNT(*) FROM client_wechat_users c
      WHERE c.became_member_at::date BETWEEN p.start_date AND p.end_date) AS denominator,
    (SELECT COALESCE(SUM(spe.amount::numeric), 0)
      FROM sale_order_performance_events spe
      JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at::date BETWEEN p.start_date AND p.end_date
        AND spe.sale_order_type IN ('销售单','转换单') AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付','回款','退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN p.start_date AND p.end_date) AS spe_amount,
    (SELECT COUNT(*) FROM sale_orders o
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at::date BETWEEN p.start_date AND p.end_date
        AND o.status IN ('已支付','部分支付','已完成')
        AND o.sale_order_type IN ('销售单','转换单') AND o.legacy_source = 'workfine'
        AND o.performance_attribution_date BETWEEN p.start_date AND p.end_date) AS wf_orders,
    (SELECT COALESCE(SUM(CASE
        WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
        THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
        ELSE o.received::numeric END), 0)
      FROM sale_orders o JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at::date BETWEEN p.start_date AND p.end_date
        AND o.status IN ('已支付','部分支付','已完成')
        AND o.sale_order_type IN ('销售单','转换单') AND o.legacy_source = 'workfine'
        AND o.performance_attribution_date BETWEEN p.start_date AND p.end_date) AS wf_before,
    (SELECT COALESCE(SUM(CASE
        WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
        THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
        ELSE o.received::numeric END), 0)
      FROM sale_orders o JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at::date BETWEEN p.start_date AND p.end_date
        AND o.status IN ('已支付','部分支付','已完成')
        AND o.sale_order_type IN ('销售单','转换单') AND o.legacy_source = 'workfine'
        AND o.performance_attribution_date BETWEEN p.start_date AND p.end_date
        AND o.performance_attribution_date <= DATE '2026-07-03') AS wf_after
  FROM periods p
)
SELECT label, denominator, spe_amount, wf_orders, wf_before, wf_after,
  spe_amount + wf_before AS numerator_before,
  spe_amount + wf_after AS numerator_after,
  CASE WHEN denominator > 0 THEN ROUND((spe_amount + wf_before) / denominator, 2) END AS avg_before,
  CASE WHEN denominator > 0 THEN ROUND((spe_amount + wf_after) / denominator, 2) END AS avg_after
FROM base ORDER BY CASE label WHEN 'pre' THEN 1 WHEN 'cross' THEN 2 ELSE 3 END;
-- 两个来源的 sale_order_id 天然不同。按同顾客、同归属日、同金额找疑似业务重复，
-- 分开报告割点前仍可能计入与割点后已由日期条件剔除的候选；人工确认才可定性重复。
WITH wf AS (
  SELECT o.sale_order_id, o.client_user_id, o.performance_attribution_date AS day,
    COALESCE((CASE WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
      THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
      ELSE o.received::numeric END), 0) AS amount
  FROM sale_orders o
  WHERE o.legacy_source = 'workfine' AND o.status IN ('已支付','部分支付','已完成')
    AND o.sale_order_type IN ('销售单','转换单')
), online AS (
  SELECT o.sale_order_id, o.client_user_id, spe.performance_date AS day,
    SUM(spe.amount::numeric) AS amount
  FROM sale_order_performance_events spe
  JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
  WHERE spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.status = '已支付'
    AND spe.sale_order_type IN ('销售单','转换单')
    AND spe.change_type IN ('首次支付','回款','退款')
  GROUP BY o.sale_order_id, o.client_user_id, spe.performance_date
)
SELECT COUNT(*) FILTER (WHERE wf.day <= DATE '2026-07-03') AS possible_pairs_counted_before_cutoff,
  COUNT(*) FILTER (WHERE wf.day > DATE '2026-07-03') AS possible_pairs_excluded_after_cutoff
FROM wf JOIN online USING (client_user_id, day, amount);
ROLLBACK;
