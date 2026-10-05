#!/usr/bin/env node

/**
 * recalc-all-customer-types.js — 一次性回填存量顾客的 customer_type / member_level / became_member_at
 *
 * 背景：
 *   db/scripts/sync-workfine.js 把 WorkFine 历史顾客 INSERT/UPSERT 进 client_wechat_users 时
 *   不写 customer_type 列，所有行落 schema 默认值 '流量客'。staffApi/order.js 的
 *   recalcCustomerType 仅在 confirmOffline / approveRefund / createRepayment / payNotify
 *   四个支付链路触发，从未对历史订单回放过；导致即便顾客早已跨过会员阈值，customer_type
 *   仍停留在 '流量客'，cron-worker 的 STEP 1/2/3（refresh-customer-status / refresh-member-levels /
 *   grant-birthday-benefits）由于全部以 customer_type='会员客' 为前置条件，长期空跑。
 *
 * 修复策略（"系统补激活"，不发权益）：
 *   等价于把 staffApi recalcCustomerType 的判定逻辑全量回放到所有顾客身上：
 *     1. 存在一张销售单，其**非体验部分毛实收** ≥ new_member_threshold ⇒ 会员客
 *     2. 否则存在一张单其非体验部分毛实收 > 0 ⇒ 小美客
 *     3. 否则存在一张单其体验部分毛实收 > 0 ⇒ 体验客
 *     4. 否则 ⇒ 流量客
 *   （#187 2026-09-18：判定金额从 total_amount 换成毛实收 = sale_items.received 净额
 *    + 该行逐项退款额，按 sale_amount 封顶；无明细行的历史单回退订单级 received。）
 *   按计算值双向对齐 customer_type（#257）；甲方测试账号「谢廷(测试)」排除。
 *   member_level 与已有 became_member_at 不因降档清空；再达标归因留待 E 阶段。
 *
 * 同事务额外维护：
 *   - 会员客升级行：member_level 仅在原值为 NULL 时按滚动 12 个月净消费写入
 *     初始等级（黑/金/粉/星/初钻），与 cron-worker determineMemberLevel 同源。
 *   - became_member_at 仅在原值为 NULL 时写入 first_qualified_at（首笔达标单
 *     COALESCE(paid_at, created_at)；选单口径 DISTINCT ON + ORDER BY paid_at
 *     ASC NULLS LAST，与 recalc-became-member-at.js 同源）。
 *   - 不发消息 / 积分 / 优惠券（与 cron-worker.processUpgrade 区别在此；理由：历史存量发"恭喜
 *     升级"会失真，且优惠券有效期会从今天起算）。
 *
 * 用法：
 *   # 默认 dry-run，仅打印将要执行的迁移统计
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-all-customer-types.js
 *
 *   # 显式提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/recalc-all-customer-types.js --apply
 *
 * 顺序：
 *   先在dev 库 101.34.242.103:5433/fengyu_wxapp 跑 --apply 验证；生产库 118.178.196.26:5433/fengyu_wxapp 再跑一次（必跑）。两端均 5433/fengyu_wxapp，仅 IP 区分。
 *
 * 幂等：
 *   - customer_type 双向同步；二次运行时已是目标态的不再 UPDATE。
 *   - member_level / became_member_at 仅在原 NULL 时写入；不覆盖历史值。
 */

const { Pool } = require('pg')
const { assertDbTargetOrExit } = require('./_lib/assert-db-target')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[RECALC-CUSTOMER-TYPE] ${new Date().toISOString()} ${msg}`)
}

// 阈值仅从 system_configs.new_member_threshold 读取；不写死兜底值。
// 缺失或非法时由 main() 提前 fail-fast，不再走 silent COALESCE。
const FETCH_THRESHOLD_SQL = `
SELECT value::numeric AS v
  FROM system_configs
 WHERE key = 'new_member_threshold'
 LIMIT 1
`

// 把 recalcCustomerType + member-level 判定 + 首次达阈值时间一次性算出来，
// 存进 _recalc_target 临时表（单事务可见），后续 UPDATE 直接 JOIN 临时表。
// 阈值由 caller 通过 $1 参数传入（已在 main() 里 fail-fast 校验过非空非零）。
const BUILD_TARGET_TABLE_SQL = `
CREATE TEMP TABLE _recalc_target ON COMMIT DROP AS
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
), threshold AS (SELECT $1::numeric AS v),
qualified_orders AS (
  -- 非体验部分毛实收达阈值的订单。保留 paid_at / created_at 原始列供 member_first
  -- 按 paid_at ASC NULLS LAST 选单（与 recalc-became-member-at.js 同口径）。
  SELECT client_user_id, sale_order_id, qualified_at
    FROM order_amounts
   WHERE non_trial >= (SELECT v FROM threshold)
),
member_first AS (
  -- 选单口径与 recalc-became-member-at.js 的 BUILD_TARGET_SQL 同源：
  -- DISTINCT ON + ORDER BY paid_at ASC NULLS LAST, created_at ASC。
  -- 不用 MIN(COALESCE(paid_at, created_at))：当某顾客有多张达标单、其中一张
  -- paid_at IS NULL 但 created_at 早于另一张 paid_at 非空单时，MIN 会选前者、
  -- ORDER BY paid_at NULLS LAST 选后者，两脚本会给不同的 became_member_at。
  SELECT DISTINCT ON (client_user_id)
         client_user_id AS user_id,
         qualified_at AS first_qualified_at, sale_order_id AS first_qualified_order
    FROM qualified_orders
   ORDER BY client_user_id, qualified_at ASC NULLS LAST, sale_order_id ASC
),
-- 2026-04-26 sku-capability 切换：xiaomei/tiyan 直接用 sale_items.is_experience 判定
-- 充值卡 SKU 的 is_experience=false → 充值卡购买视同"小美客"消费（D1=A）
-- #187 起改判金额：存在一张单其 non_trial > 0（小美客）/ trial > 0（体验客），
-- 与其余七处副本的 non_trial > 0 / trial > 0 分支同口径。
xiaomei_users AS (
  SELECT DISTINCT client_user_id AS user_id
    FROM order_amounts
   WHERE non_trial > 0
),
tiyan_users AS (
  SELECT DISTINCT client_user_id AS user_id
    FROM order_amounts
   WHERE trial > 0
),
spend_12m AS (
  -- 2026-09-19 修既有 bug（#187 闸门 2 codex 发现）：本段原查 paid_amount 列，
  -- 而该列在 2026-04-26 sale-order-domain-refactor 里已 DROP（与 received 重复，见
  -- db/schema/order.ts 的 received 注释）。结果是整个脚本一跑就报
  -- column paid_amount does not exist，全库回算根本执行不了。
  -- 口径对齐 cron steps/refresh-member-levels.ts：净消费 = GREATEST(received - refunded_amount, 0)，
  -- 单据范围含 '销售单' 与 '转换单'（原脚本只算销售单，与 cron 不一致，一并对齐）。
  SELECT client_user_id AS user_id,
         COALESCE(SUM(GREATEST(received::numeric - refunded_amount::numeric, 0)), 0) AS spend
    FROM sale_orders
   WHERE sale_order_type IN ('销售单', '转换单')
     AND paid_at >= (NOW() - INTERVAL '12 months')
     AND client_user_id IS NOT NULL
   GROUP BY client_user_id
)
SELECT u.user_id,
       u.customer_type AS old_type,
       u.member_level  AS old_level,
       u.became_member_at AS old_became,
       CASE
         WHEN m.user_id IS NOT NULL THEN '会员客'
         WHEN x.user_id IS NOT NULL THEN '小美客'
         WHEN t.user_id IS NOT NULL THEN '体验客'
         ELSE '流量客'
       END::customer_type AS new_type,
       CASE
         WHEN m.user_id IS NOT NULL THEN
           CASE
             WHEN COALESCE(s.spend, 0) >= 100000 THEN '黑钻'
             WHEN COALESCE(s.spend, 0) >= 60000  THEN '金钻'
             WHEN COALESCE(s.spend, 0) >= 30000  THEN '粉钻'
             WHEN COALESCE(s.spend, 0) >= 10000  THEN '星钻'
             WHEN COALESCE(s.spend, 0) >= (SELECT v FROM threshold) THEN '初钻'
             ELSE NULL
           END
         ELSE NULL
       END::member_level AS new_level,
       m.first_qualified_at, m.first_qualified_order
  FROM client_wechat_users u
  LEFT JOIN member_first m ON m.user_id = u.user_id
  LEFT JOIN xiaomei_users x ON x.user_id = u.user_id
  LEFT JOIN tiyan_users  t ON t.user_id = u.user_id
  LEFT JOIN spend_12m    s ON s.user_id = u.user_id
 WHERE u.name IS DISTINCT FROM '谢廷(测试)'
`

const PREVIEW_TRANSITIONS_SQL = `
SELECT old_type, new_type, COUNT(*)::int AS cnt
  FROM _recalc_target
 WHERE old_type IS DISTINCT FROM new_type
 GROUP BY old_type, new_type
 ORDER BY old_type, new_type
`

const PREVIEW_LEVEL_SQL = `
SELECT new_level, COUNT(*)::int AS cnt
  FROM _recalc_target
 WHERE new_type = '会员客'
   AND old_level IS NULL
   AND new_level IS NOT NULL
 GROUP BY new_level
 ORDER BY new_level
`

const PREVIEW_BECAME_SQL = `
SELECT COUNT(*)::int AS cnt
  FROM _recalc_target
 WHERE new_type = '会员客'
   AND old_became IS NULL
   AND first_qualified_at IS NOT NULL
`

// #257：离线通道双向对齐，目标态不变时不写；实时路径仍只负责升级。
const UPDATE_TYPE_SQL = `
UPDATE client_wechat_users u
   SET customer_type = t.new_type,
       updated_at = NOW()
  FROM _recalc_target t
 WHERE u.user_id = t.user_id
   AND u.name IS DISTINCT FROM '谢廷(测试)'
   AND u.customer_type IS DISTINCT FROM t.new_type
`

const UPDATE_LEVEL_SQL = `
UPDATE client_wechat_users u
   SET member_level = t.new_level,
       updated_at = NOW()
  FROM _recalc_target t
 WHERE u.user_id = t.user_id
   AND t.new_type = '会员客'
   AND u.member_level IS NULL
   AND t.new_level IS NOT NULL
`

const UPDATE_BECAME_SQL = `
UPDATE client_wechat_users u
   SET became_member_at = t.first_qualified_at,
       updated_at = NOW()
  FROM _recalc_target t
 WHERE u.user_id = t.user_id
   AND t.new_type = '会员客'
   AND u.became_member_at IS NULL
   AND t.first_qualified_at IS NOT NULL
`

const SELFCHECK_SQL = `
SELECT
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type = '会员客' AND became_member_at IS NULL AND name IS DISTINCT FROM '谢廷(测试)')::int AS member_no_became,
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type != '会员客' AND member_level IS NOT NULL)::int AS nonmember_with_level
`

/** Caller owns BEGIN/COMMIT/ROLLBACK; reuse the authoritative batch SQL (#256). */
async function recalcCustomerTypesInTransaction(client, userIds) {
  const { rows } = await client.query(FETCH_THRESHOLD_SQL)
  const threshold = rows[0] ? Number(rows[0].v) : NaN
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error('system_configs.new_member_threshold 缺失或非法，拒绝补算顾客分类')
  }
  await client.query(BUILD_TARGET_TABLE_SQL, [threshold])
  // 默认CLI仍全库；同步传入已锁定的身份范围，不写无关顾客。
  if (userIds !== undefined) {
    if (!Array.isArray(userIds) || userIds.some(id => typeof id !== 'string' || !id)) throw new Error('非法顾客补算范围')
    await client.query('DELETE FROM _recalc_target WHERE NOT (user_id = ANY($1::text[]))', [userIds])
  }
  const type = await client.query(UPDATE_TYPE_SQL)
  const level = await client.query(UPDATE_LEVEL_SQL)
  const became = await client.query(UPDATE_BECAME_SQL)
  const check = await client.query(SELFCHECK_SQL)
  // 人工会员可能没有历史达标消费；不可因不可补齐的既有行阻断档案同步。
  return { typeCount: type.rowCount, levelCount: level.rowCount, becameCount: became.rowCount, selfCheck: check.rows[0] }
}

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
    // fail-fast：阈值必须从 system_configs 读到合法正数，否则拒绝执行
    const thRows = (await client.query(FETCH_THRESHOLD_SQL)).rows
    const threshold = thRows[0] ? Number(thRows[0].v) : NaN
    if (!Number.isFinite(threshold) || threshold <= 0) {
      log(`✗ system_configs.new_member_threshold 缺失或非法（取到 ${JSON.stringify(thRows[0])}）；脚本拒绝执行`)
      process.exitCode = 1
      return
    }
    log(`阈值: ${threshold}（来自 system_configs.new_member_threshold）`)

    await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    log('构建 _recalc_target 临时表...')
    const targetSelect = BUILD_TARGET_TABLE_SQL.replace(/^\s*CREATE TEMP TABLE _recalc_target ON COMMIT DROP AS\s*/, '')
    if (apply) await client.query(BUILD_TARGET_TABLE_SQL, [threshold])
    const queryTarget = (query) => apply
      ? client.query(query)
      : client.query(`WITH _recalc_target AS (${targetSelect}) ${query}`, [threshold])

    const transitions = await queryTarget(PREVIEW_TRANSITIONS_SQL)
    log(`customer_type 待双向对齐分布:`)
    let totalChanged = 0
    for (const r of transitions.rows) {
      log(`  ${r.old_type} → ${r.new_type}: ${r.cnt}`)
      totalChanged += r.cnt
    }
    log(`  合计待 UPDATE customer_type: ${totalChanged} 行`)

    const levels = await queryTarget(PREVIEW_LEVEL_SQL)
    log(`member_level 初始化分布（会员客 ∩ old_level=NULL）:`)
    let totalLevel = 0
    for (const r of levels.rows) {
      log(`  ${r.new_level || 'NULL（消费<阈值，跳过）'}: ${r.cnt}`)
      totalLevel += r.cnt
    }
    log(`  合计待 UPDATE member_level: ${totalLevel} 行`)

    const became = await queryTarget(PREVIEW_BECAME_SQL)
    log(`became_member_at 待回填: ${became.rows[0].cnt} 行`)

    if (!apply) {
      log('DRY-RUN 完成；事务即将 ROLLBACK，未实际写入。')
      await client.query('ROLLBACK')
      return
    }

    log('开始 UPDATE customer_type ...')
    const r1 = await client.query(UPDATE_TYPE_SQL)
    log(`  UPDATE customer_type: ${r1.rowCount} 行`)

    log('开始 UPDATE member_level ...')
    const r2 = await client.query(UPDATE_LEVEL_SQL)
    log(`  UPDATE member_level: ${r2.rowCount} 行`)

    log('开始 UPDATE became_member_at ...')
    const r3 = await client.query(UPDATE_BECAME_SQL)
    log(`  UPDATE became_member_at: ${r3.rowCount} 行`)

    const check = await client.query(SELFCHECK_SQL)
    const { member_no_became, nonmember_with_level } = check.rows[0]
    log(`自检: 会员客∧became=NULL=${member_no_became}; 非会员客∧member_level≠NULL=${nonmember_with_level}`)
    if (Number(member_no_became) > 0) {
      log('✗ 自检失败：仍有会员客缺失 became_member_at（不应发生）')
      await client.query('ROLLBACK')
      process.exitCode = 1
      return
    }

    await client.query('COMMIT')
    log('✓ COMMIT 完成')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('回填失败，事务已 ROLLBACK:', err)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

if (require.main === module) {
  assertDbTargetOrExit(process.env.DATABASE_URL)
  main().catch((err) => {
    console.error('未捕获异常:', err)
    process.exit(1)
  })
}

module.exports = { recalcCustomerTypesInTransaction, BUILD_TARGET_TABLE_SQL, PREVIEW_TRANSITIONS_SQL, UPDATE_TYPE_SQL, UPDATE_LEVEL_SQL, UPDATE_BECAME_SQL, FETCH_THRESHOLD_SQL }
