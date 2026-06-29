-- =============================================================================
-- 回填脚本：admin 端 timestamp without tz 历史 UTC 字面 → 北京墙钟字面（follow-up #2）
-- =============================================================================
--
-- 背景：
--   admin（postgres.js）历史写入 timestamp without tz 列时，`new Date()` 被序列化为 UTC ISO，
--   PG 当墙钟字面落库 → 比真实北京时刻**早 8h**（28800s）。clientApi/staffApi reader
--   假设库存北京字面 → 读出 +8h 偏移。代码侧已由 lib/db-time.ts（nowTs/beijingTs）根治，
--   本脚本修正**历史存量**数据。
--
-- ⚠️ 严肃警告（执行前必读）：
--   1. **prod 执行前必须 pg_dump 全量备份**（`pg_dump -f pre-backfill-$(date +%F).sql`）。
--   2. **先 SELECT 预演**（每段都带预演 SELECT）核对命中行数与样本，确认无误再取消注释 UPDATE。
--   3. **在事务里跑**：`BEGIN; <UPDATEs...> ; SELECT 校验; COMMIT; / ROLLBACK;`。
--   4. **双库都要跑**：开发库 5434/fengyu 与 生产库 5433/fengyu_wxapp（两库均有 admin 写入存量）。
--   5. **幂等**：每条 UPDATE 的 WHERE 都锚定「diff ≈ -8h」，shift +8h 后 diff ≈ 0 不再命中，
--      重复执行不会二次偏移。但仍强烈建议一次跑完即核对，勿反复。
--
-- 锚定原理：
--   `created_at` 列由 PG `defaultNow()` 写入（server_timezone=Asia/Shanghai，北京字面，**可靠**）。
--   admin 写入的业务时间列（如 sale_order_datetime）在同一 INSERT 内与 created_at 同时刻，
--   却被存成 UTC 字面 → `业务列 - created_at` ≈ -28800s（±60s 容忍时钟漂移）。
--   cloud function（client/staff）写入的业务列是北京字面 → diff ≈ 0，**不会**命中（安全）。
--
-- 窗口：-28860 .. -28740（28800 ± 60s）。如命中数异常请先放宽窗口 SELECT 排查，勿盲跑。
-- =============================================================================


-- #############################################################################
-- 0. 预演总览：每张表预期命中行数（执行任何 UPDATE 前先看这里）
-- #############################################################################

-- 0.1 sale_orders.sale_order_datetime（admin 写入，精确锚）
-- SELECT count(*) AS hit_sale_order_datetime
--   FROM sale_orders
--  WHERE extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740;

-- 0.2 sale_orders.paid_at（admin 写入；仅限上面 0.1 命中的订单——同源）
-- SELECT count(*) AS hit_paid_at
--   FROM sale_orders
--  WHERE paid_at IS NOT NULL
--    AND extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740;

-- 0.3 sale_order_payments.paid_at（admin 录入的线下/回款流水；source_end='admin'）
-- SELECT count(*) AS hit_sop_paid_at
--   FROM sale_order_payments sop
--  JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
--  WHERE sop.paid_at IS NOT NULL
--    AND sop.source_end = 'admin'
--    AND extract(epoch FROM (so.sale_order_datetime - so.created_at)) BETWEEN -28860 AND -28740;

-- 0.4 user_coupons.used_at（admin 开单核销写）
-- SELECT count(*) AS hit_used_at
--   FROM user_coupons uc
--  WHERE used_at IS NOT NULL
--    AND extract(epoch FROM (used_at - created_at)) BETWEEN -28860 AND -28740;


-- #############################################################################
-- 1. sale_orders.sale_order_datetime  +8h（精确锚；admin 写入）
-- #############################################################################
-- 预演样本（核对 sale_order_id / 两个时间列字面）：
-- SELECT sale_order_id, sale_order_datetime, created_at,
--        extract(epoch FROM (sale_order_datetime - created_at)) AS diff_s
--   FROM sale_orders
--  WHERE extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740
--  ORDER BY created_at DESC LIMIT 20;

UPDATE sale_orders
   SET sale_order_datetime = sale_order_datetime + interval '8 hours'
 WHERE extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740;


-- #############################################################################
-- 2. sale_orders.paid_at  +8h
--    锚：与 sale_order_datetime 同源（同 INSERT 的 admin 订单）。paid_at 可能晚于 created_at
--    数小时~数天（待支付→确认收款），无法直接用 paid_at-created_at 锚；故借 0.1 的同源订单集合
--    作为代理（admin 写入的订单，其 paid_at 同样被 UTC 字面化）。
--    ⚠️ 启发式：极少数订单可能由 admin 创建但 paid_at 由 payNotify（云函数，北京字面）写入
--       （线上支付单），这些 paid_at 本就正确，+8h 会**过度偏移**。线上支付单 payment_method
--       为微信/支付宝，可按需加 `AND payment_method IN ('线下','储值卡','无')` 收窄。
-- #############################################################################
-- 预演样本：
-- SELECT sale_order_id, payment_method, paid_at, created_at,
--        extract(epoch FROM (sale_order_datetime - created_at)) AS sod_diff_s
--   FROM sale_orders
--  WHERE paid_at IS NOT NULL
--    AND extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740
--  ORDER BY created_at DESC LIMIT 50;

UPDATE sale_orders
   SET paid_at = paid_at + interval '8 hours'
 WHERE paid_at IS NOT NULL
   AND payment_method IN ('线下', '储值卡', '无')   -- 收窄：仅 admin 录入的线下/储值卡/全卡覆盖
   AND extract(epoch FROM (sale_order_datetime - created_at)) BETWEEN -28860 AND -28740;


-- #############################################################################
-- 3. sale_order_payments.paid_at  +8h（admin source_end 的回款/首次支付/储值卡抵扣流水）
-- #############################################################################
UPDATE sale_order_payments sop
   SET paid_at = paid_at + interval '8 hours'
  FROM sale_orders so
 WHERE sop.sale_order_id = so.sale_order_id
   AND sop.paid_at IS NOT NULL
   AND sop.source_end = 'admin'
   AND extract(epoch FROM (so.sale_order_datetime - so.created_at)) BETWEEN -28860 AND -28740;


-- #############################################################################
-- 4. user_coupons.used_at  +8h（admin 开单核销优惠券写入）
--    user_coupons.created_at 为 defaultNow（北京字面，可靠锚）。
-- #############################################################################
UPDATE user_coupons
   SET used_at = used_at + interval '8 hours'
 WHERE used_at IS NOT NULL
   AND extract(epoch FROM (used_at - created_at)) BETWEEN -28860 AND -28740;


-- #############################################################################
-- 5. expire_at（user_coupons.expire_at / 优惠券模板 valid_to 等）—— 不批量回填
-- #############################################################################
-- ⚠️ expire_at 是**未来值**，且 admin 历史发放优惠券（coupons.ts expireAt=new Date()+validDays）
--    与 cron 发放（grant-birthday-benefits 等用 new Date().toISOString() 写 raw SQL，同样偏移）
--    混杂；用 created_at 锚不可靠（validDays 跨度从 1 天到 365 天，diff 不固定 -8h）。
-- 处理方式：**不批量回填**，逐行人工核对。
--   排查 SQL（找出 admin/cron 发放、且过期时刻恰好整 8h 偏移的疑似行，人工复核）：
--   SELECT coupon_id, template_id, user_id, expire_at, created_at, status
--     FROM user_coupons
--    WHERE expire_at IS NOT NULL
--      AND extract(epoch FROM (expire_at - created_at - interval '8 hours')) % 86400 = 0  -- 粗筛
--    ORDER BY created_at DESC;
-- 结论：业务上「券提前/推迟 8h 过期」影响极小（顾客感知弱），且批量修正风险高于收益，
--      留作按需逐行处理。新发放已由代码侧 beijingTs 根治。


-- #############################################################################
-- 6. 其余 admin 写入的 timestamp 列（confirmed_at / voided_at / deleted_at /
--    reviewed_at / last_changed_at / last_failed_at / started_at / staff_completed_at /
--    audit_at / inventory *.confirmed_at 等）
-- #############################################################################
-- 这些列历史数据量小、业务影响有限（多为审计/软删时间戳），且无可靠统一锚（部分表无 created_at
-- 或 created_at 也被 admin 显式写入而失真）。**不批量回填**；如发现具体展示异常，按表逐条排查：
--   通用排查模式（替换 <table>.<col>, <ref_col>）：
--   SELECT id, <col>, <ref_col>,
--          extract(epoch FROM (<col> - <ref_col>)) AS diff_s
--     FROM <table>
--    WHERE <col> IS NOT NULL
--    ORDER BY <ref_col> DESC LIMIT 50;
-- 新写入已由代码侧 nowTs()/beijingTs() 根治（见 fengyu-admin/src/lib/db-time.ts）。


-- =============================================================================
-- 跑完后校验：所有业务时间列 - created_at 应落入合理正值区间（不再有 -28800 整 8h 偏移聚集）。
--   SELECT min(diff_s), max(diff_s), avg(diff_s) FROM (
--     SELECT extract(epoch FROM (sale_order_datetime - created_at)) AS diff_s FROM sale_orders
--   ) t;
-- 预期：min ≈ 0 上下（不再有 -28800 聚集峰）。
-- =============================================================================
