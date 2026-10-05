#!/usr/bin/env node

/**
 * recalc-became-member-at.js — 一次性重算存量会员客的 became_member_at
 *
 * 背景：
 *   became_member_at 原口径 =「系统检测到首次跃迁为会员客的 NOW()」。对靠历史订单
 *   审核首次成为会员的客户，该值落在「审核操作当天」而非真实首单消费日（订单
 *   paid_at 已写成历史销售日，但 became_member_at 仍是 NOW()），导致会员报表的
 *   「本月新会员 / 历史会员数」按审核日计入、历史分布失真。
 *
 *   在线写入口径已改为「确立会员资格的首笔达标单时间」（实际付款跨阈值时间，历史无receipt已结清销售单才回退父单时间；
 *   staffApi/clientApi/payNotify/admin orders.ts/admin recompute-customer-tags 五端镜像）。
 *   本脚本对存量会员客做同样重算，使存量值 == 在线值。
 *
 * 选单口径（与在线 became_member_at 子查询同源；#187 起按非体验部分毛实收达标）：
 *   status IN ('部分支付','已支付','已完成') AND sale_order_type IN ('销售单','转换单') AND non_trial >= threshold
 *   （non_trial = Σ 非体验行的 received 净额 + 该行逐项退款额）
 *   ORDER BY qualified_at ASC NULLS LAST, sale_order_id ASC，每会员客取最早一单，取其
 *   COALESCE(paid_at, created_at)。不用 MIN(COALESCE)：MIN 在「某达标单 paid_at=NULL
 *   且 created_at 早于另一张达标单 paid_at」时会选不同的单，导致存量 ≠ 新单。
 *
 *   不带 `paid_at <= became_member_at` 守卫：本脚本是纯重算覆写（不是
 *   backfill-membership-upgrade-doc-type 的「选跃迁那一刻的单」语义），守卫会与
 *   旧 became_member_at 形成循环依赖。
 *
 * #257 A+B：仅对当前会员客且有达标单者维护归因；先执行分类双向对齐，再执行本脚本；排除甲方测试账号。
 * 仅维护仍达标者的既有首次达标归因，不清空降级者的历史归因；再达标定义留待 E。
 *
 * 幂等：UPDATE WHERE became_member_at IS DISTINCT FROM new_became，二次运行命中 0 行。
 *   不 bump updated_at（与在线五端 became_member_at UPDATE 对齐）。
 *
 * 边界：
 *   - 会员客但当前阈值无达标单（阈值历史上调过的存量会员）→ 不在 _target，保留原值
 *     不动（只由 ANOMALY 计数告警）。不可恢复（无阈值历史）。
 *   - paid_at 全 NULL 的达标单：COALESCE 回退 created_at（NOT NULL），new_became 恒非空。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 抽样）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-became-member-at.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-became-member-at.js --apply
 *
 * 顺序：先 dev（101.34.242.103:5433/fengyu_wxapp）--apply 验证；再 prod
 *   （118.178.196.26:5433/fengyu_wxapp）--apply。两库均 5433/fengyu_wxapp，仅 IP 区分。
 *   prod --apply 前先 `bash db/scripts/dump-prod.sh -t client_wechat_users` 备份（覆写不可逆）。
 *   e2e 绝不碰生产 IP 118.178.196.26。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[RECALC-BECAME-MEMBER-AT] ${new Date().toISOString()} ${msg}`)
}

// 阈值仅从 system_configs.new_member_threshold 读取；缺失或非法时 fail-fast。
const FETCH_THRESHOLD_SQL = `
SELECT value::numeric AS v
  FROM system_configs
 WHERE key = 'new_member_threshold'
 LIMIT 1
`

// 每个会员客取首笔达标单时间。DISTINCT ON + ORDER BY 与在线 became_member_at 子查询
// 同 WHERE/ORDER/投影 ⇒ 存量值 == 在线值。不带 paid_at<=became_member_at 守卫（纯重算覆写）。
// #187（2026-09-18）：达标口径从订单应付额 total_amount 换成**单笔订单的非体验部分毛实收**
// （sale_items.received 净额 + 该行逐项退款额），与五端运行时 RECALC_CUSTOMER_TYPE_CTE 同判定语义；
// 此处是全库批量版（无 client_user_id 参数过滤、多带输出列）。
const BUILD_TARGET_SQL = `
CREATE TEMP TABLE _target ON COMMIT DROP AS
WITH membership_settings AS (
  SELECT NULL::text AS client_user_id, $1::numeric AS threshold
), membership_scope AS (
  SELECT o.* FROM sale_orders o CROSS JOIN membership_settings cfg
  WHERE (cfg.client_user_id IS NULL OR o.client_user_id = cfg.client_user_id)
    AND o.client_user_id IS NOT NULL
    AND o.status IN ('部分支付', '已支付', '已完成')
    AND o.sale_order_type IN ('销售单', '转换单')
), refund_by_item AS (
  SELECT sop.sale_order_id, elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0)) AS refunded
  FROM sale_order_payments sop
  JOIN membership_scope o ON o.sale_order_id = sop.sale_order_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
         THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END
  ) elem
  WHERE o.sale_order_type = '销售单' AND sop.change_type = '退款'
    AND sop.status = '已支付' AND elem ->> 'refSaleItemId' <> 'OVERPAY'
  GROUP BY 1, 2
), membership_sales AS (
  -- #187：销售单继续按行净额加退款、成交额封顶；无明细历史单保留原回退。
  SELECT o.sale_order_id,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_order_id = o.sale_order_id)
              THEN GREATEST(o.received::numeric, 0)
              ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(r.refunded, 0), si.sale_amount::numeric))
                            FILTER (WHERE si.is_experience = false), 0) END AS non_trial,
         COALESCE(SUM(LEAST(si.received::numeric + COALESCE(r.refunded, 0), si.sale_amount::numeric))
                  FILTER (WHERE si.is_experience = true), 0) AS trial
  FROM membership_scope o
  LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id AND si.item_direction = '购买'
  LEFT JOIN refund_by_item r ON r.sale_order_id = o.sale_order_id AND r.sale_item_id = si.sale_item_id
  WHERE o.sale_order_type = '销售单'
  GROUP BY o.sale_order_id, o.received
), membership_receipts AS (
  -- 同场现金+卡的 receipt 已含实际扣卡；只读 receipt 一次，不再另加款项金额。
  SELECT o.sale_order_id, p.id AS payment_id, p.paid_at, r.sale_item_id, r.amount::numeric
  FROM membership_scope o
  JOIN sale_order_payments p ON p.sale_order_id = o.sale_order_id
  JOIN sale_payment_item_receipts r ON r.sale_payment_id = p.id AND r.sale_order_id = o.sale_order_id
  WHERE p.status = '已支付' AND p.change_type IN ('首次支付','回款','储值卡抵扣')
  /* membership-receipt-preview */
), membership_receipt_rows AS (
  SELECT r.*, si.sale_amount::numeric AS cap, si.is_experience, si.item_direction, o.sale_order_type,
         SUM(r.amount) OVER (PARTITION BY r.sale_order_id, r.payment_id) AS event_total,
         SUM(GREATEST(-r.amount, 0)) FILTER (WHERE si.item_direction = '转出')
           OVER (PARTITION BY r.sale_order_id, r.payment_id) AS old_assets,
         SUM(GREATEST(r.amount, 0)) FILTER (WHERE si.item_direction = '转入')
           OVER (PARTITION BY r.sale_order_id, r.payment_id) AS in_total,
         SUM(CASE WHEN si.item_direction = '转入' THEN GREATEST(r.amount, 0) ELSE 0 END)
           OVER (PARTITION BY r.sale_order_id, r.payment_id ORDER BY r.sale_item_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS in_cumulative
  FROM membership_receipts r
  JOIN membership_scope o ON o.sale_order_id = r.sale_order_id
  JOIN sale_items si ON si.sale_item_id = r.sale_item_id AND si.sale_order_id = r.sale_order_id
), membership_normalized AS (
  -- 旧 signed receipt：新增实收按转入权重拆分；旧资产的体验属性不能污染新收款。
  -- 新增量 receipt 保留有符号分币差；不改写历史 receipt/分配/资产。
  SELECT r.*,
         CASE WHEN sale_order_type = '转换单' AND old_assets > 0
              THEN ROUND(GREATEST(event_total, 0) * in_cumulative / NULLIF(in_total, 0), 2)
                 - ROUND(GREATEST(event_total, 0) * (in_cumulative - GREATEST(amount, 0)) / NULLIF(in_total, 0), 2)
              ELSE amount END AS new_receipt
  FROM membership_receipt_rows r
  WHERE (sale_order_type = '销售单' AND item_direction = '购买')
     OR (sale_order_type = '转换单' AND item_direction = '转入')
), membership_item_running AS (
  SELECT r.*,
         LEAST(GREATEST(cap, 0), GREATEST(0, SUM(COALESCE(new_receipt, 0)) OVER (
           PARTITION BY sale_order_id, sale_item_id ORDER BY paid_at ASC NULLS LAST, payment_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))) AS item_gross
  FROM membership_normalized r
), membership_item_deltas AS (
  SELECT r.*, item_gross - LAG(item_gross, 1, 0::numeric) OVER (
    PARTITION BY sale_order_id, sale_item_id ORDER BY paid_at ASC NULLS LAST, payment_id) AS delta
  FROM membership_item_running r
), membership_events AS (
  SELECT sale_order_id, payment_id, paid_at,
         COALESCE(SUM(delta) FILTER (WHERE is_experience = false), 0) AS non_trial,
         COALESCE(SUM(delta) FILTER (WHERE is_experience = true), 0) AS trial
  FROM membership_item_deltas GROUP BY sale_order_id, payment_id, paid_at
), membership_timeline AS (
  SELECT sale_order_id, payment_id, paid_at,
         SUM(non_trial) OVER (PARTITION BY sale_order_id ORDER BY paid_at ASC NULLS LAST, payment_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS non_trial
  FROM membership_events
), membership_receipt_totals AS (
  SELECT sale_order_id, SUM(amount) AS gross FROM membership_receipts GROUP BY sale_order_id
), membership_event_totals AS (
  SELECT sale_order_id, SUM(non_trial) AS non_trial, SUM(trial) AS trial
  FROM membership_events GROUP BY sale_order_id
), membership_amounts AS (
  SELECT o.sale_order_id, o.client_user_id, o.paid_at, o.created_at, o.status, o.sale_order_type,
         CASE WHEN o.sale_order_type = '销售单' THEN s.non_trial
              WHEN r.gross <= o.received::numeric + 0.01 THEN COALESCE(e.non_trial, 0) ELSE 0 END AS non_trial,
         CASE WHEN o.sale_order_type = '销售单' THEN s.trial
              WHEN r.gross <= o.received::numeric + 0.01 THEN COALESCE(e.trial, 0) ELSE 0 END AS trial,
         ABS(COALESCE(r.gross, 0) - o.received::numeric) <= 0.01 AS receipts_complete,
         r.gross IS NOT NULL AS has_receipts
  FROM membership_scope o
  LEFT JOIN membership_sales s ON s.sale_order_id = o.sale_order_id
  LEFT JOIN membership_receipt_totals r ON r.sale_order_id = o.sale_order_id
  LEFT JOIN membership_event_totals e ON e.sale_order_id = o.sale_order_id
), order_amounts AS (
  SELECT a.*,
         CASE WHEN a.non_trial >= cfg.threshold THEN
           COALESCE(
             (SELECT MIN(t.paid_at) FROM membership_timeline t
               WHERE t.sale_order_id = a.sale_order_id AND t.non_trial >= cfg.threshold
                 AND a.receipts_complete),
             CASE WHEN NOT a.has_receipts AND a.sale_order_type = '销售单'
                        AND a.status IN ('已支付','已完成')
                  THEN COALESCE(a.paid_at, a.created_at) END
           ) END AS qualified_at
  FROM membership_amounts a CROSS JOIN membership_settings cfg
)
SELECT DISTINCT ON (oa.client_user_id)
       oa.client_user_id AS user_id,
       oa.qualified_at AS new_became,
       u.became_member_at AS old_became
  FROM order_amounts oa
  JOIN client_wechat_users u ON u.user_id = oa.client_user_id
 WHERE u.customer_type = '会员客'
   AND u.name IS DISTINCT FROM '谢廷(测试)'
   AND oa.non_trial >= $1::numeric
   AND oa.qualified_at IS NOT NULL
 ORDER BY oa.client_user_id, oa.qualified_at ASC NULLS LAST, oa.sale_order_id ASC
`

const PREVIEW_SQL = `
SELECT
  COUNT(*)::int                                                           AS target_users,
  SUM((old_became IS DISTINCT FROM new_became)::int)::int                 AS users_to_change,
  SUM((old_became IS NULL)::int)::int                                     AS users_pre_null,
  SUM((old_became IS NOT NULL AND new_became >  old_became)::int)::int    AS users_new_later,
  SUM((old_became IS NOT NULL AND new_became <  old_became)::int)::int    AS users_new_earlier
  FROM _target
`

const SAMPLE_SQL = `
SELECT user_id, old_became, new_became FROM _target
 WHERE old_became IS DISTINCT FROM new_became
 ORDER BY user_id
 LIMIT 20
`

// 幂等覆写；不 bump updated_at。
const UPDATE_SQL = `
UPDATE client_wechat_users u
   SET became_member_at = t.new_became
  FROM _target t
 WHERE u.user_id = t.user_id
   AND u.became_member_at IS DISTINCT FROM t.new_became
`

// 会员客但当前阈值无达标单（阈值历史上调过的存量会员）→ 保留原值不动。
// 另报两个数据质量边角（非本脚本职责，仅诊断）。
// #187：达标口径直接复用 _target（BUILD_TARGET_SQL 已按 non_trial >= 阈值筛过、
// 且只收当前 customer_type='会员客'），避免这里再抄一遍判定 SQL 造成口径二次漂移。
const ANOMALY_SQL = `
SELECT
  (SELECT COUNT(*)::int FROM client_wechat_users u
    WHERE u.customer_type = '会员客'
      AND u.name IS DISTINCT FROM '谢廷(测试)'
      AND NOT EXISTS (SELECT 1 FROM _target t WHERE t.user_id = u.user_id)) AS member_no_qualifying,
  (SELECT COUNT(*)::int FROM client_wechat_users
    WHERE customer_type='会员客' AND became_member_at IS NULL) AS member_became_null,
  (SELECT COUNT(*)::int FROM client_wechat_users
    WHERE customer_type <> '会员客' AND became_member_at IS NOT NULL) AS nonmember_with_became
`

// UPDATE 后「有达标单且非测试账号的会员客」不应再缺 became_member_at（>0 则 ROLLBACK + exit 1）。
// 同样复用 _target：UPDATE_SQL 覆盖的正是 _target 全集，故此处 >0 即真异常。
const SELFCHECK_SQL = `
SELECT COUNT(*)::int AS member_qualifying_still_null
  FROM client_wechat_users u
 WHERE u.customer_type = '会员客' AND u.became_member_at IS NULL
   AND EXISTS (SELECT 1 FROM _target t WHERE t.user_id = u.user_id)
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${apply ? 'APPLY（实际写入）' : 'DRY-RUN（默认；加 --apply 提交）'}`)

  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()
  try {
    const thRes = await client.query(FETCH_THRESHOLD_SQL)
    if (!thRes.rows[0] || !thRes.rows[0].v || Number(thRes.rows[0].v) <= 0) {
      console.error('FATAL: system_configs.new_member_threshold 缺失或非法')
      process.exit(1)
    }
    const threshold = Number(thRes.rows[0].v)
    log(`new_member_threshold = ${threshold}`)

    await client.query('BEGIN')
    await client.query(BUILD_TARGET_SQL, [threshold])

    const preview = await client.query(PREVIEW_SQL)
    const p = preview.rows[0]
    log(`命中：${p.target_users} 会员客；将变更 ${p.users_to_change} 行（原 NULL ${p.users_pre_null}；前移 ${p.users_new_earlier}；后移 ${p.users_new_later}）`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('抽样（前 20 行 user_id | old → new）：')
      for (const r of sample.rows) {
        log(`  ${r.user_id} | ${r.old_became} → ${r.new_became}`)
      }
    }

    const anom = await client.query(ANOMALY_SQL)
    const a = anom.rows[0]
    log(`ANOMALY：会员客但当前阈值无达标单（保留原值）${a.member_no_qualifying} 人；会员客 became_member_at IS NULL ${a.member_became_null} 人；非会员客却带 became_member_at ${a.nonmember_with_became} 人`)

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      log(`APPLY 完成：已更新 ${upd.rowCount} 行 became_member_at`)

      const sc = await client.query(SELFCHECK_SQL)
      if (sc.rows[0].member_qualifying_still_null > 0) {
        await client.query('ROLLBACK')
        console.error(`FATAL: SELFCHECK 失败：仍有 ${sc.rows[0].member_qualifying_still_null} 个「有达标单的会员客」became_member_at 为 NULL，已回滚`)
        process.exit(1)
      }
      await client.query('COMMIT')
      log('SELFCHECK 通过；事务已提交')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN：已回滚，未写入。加 --apply 提交。')
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    console.error('FATAL:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

if (require.main === module) main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})

module.exports = { BUILD_TARGET_SQL, UPDATE_SQL, FETCH_THRESHOLD_SQL }
