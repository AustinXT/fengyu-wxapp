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
 *     1. 单订单 (total_amount) 或单订单+回款链 (total + Σ回款) ≥ new_member_threshold ⇒ 会员客
 *     2. 否则有非卡品 SKU 销售记录 ⇒ 小美客
 *     3. 否则有卡品（除充值卡外）SKU 销售记录 ⇒ 体验客
 *     4. 否则 ⇒ 流量客
 *   仅"向上跃迁"（rank: 流量客<体验客<小美客<会员客），保护已被手工或 payNotify 升级过的行。
 *
 * 同事务额外维护：
 *   - 会员客升级行：member_level 仅在原值为 NULL 时按滚动 12 个月销售额 (paid_amount) 写入
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
 *   - customer_type 仅向上跃迁；二次运行时已是目标态的不再 UPDATE。
 *   - member_level / became_member_at 仅在原 NULL 时写入；不覆盖历史值。
 */

const { Pool } = require('pg')

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
WITH threshold AS (
  SELECT $1::numeric AS v
),
-- #187（2026-09-18）：跃迁判定金额从订单应付额 total_amount 换成
-- **单笔订单的非体验部分毛实收**（sale_items.received 净额 + 该行逐项退款额），
-- 落地 2026-04-26 Q5.2 决策。本段是五端运行时 CTE 的全库批量版：
-- 少了 client_user_id 参数过滤、多带 client_user_id/paid_at/created_at 输出列，
-- 其余判定语义与 staffApi routes/order.js RECALC_CUSTOMER_TYPE_CTE 逐项对齐。
refund_by_item AS (
  -- note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js RECEIVED_REFUNDED_DEDUCT_SQL：
  -- ① 仅退款+已支付流水；② note LIKE '{%' 纯文本守门；③ 嵌套 CASE 令 ::jsonb cast 只在守门通过时求值。
  SELECT elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE((elem ->> 'refundAmount')::numeric, 0)) AS refunded
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
   GROUP BY 1
),
order_amounts AS (
  SELECT o.sale_order_id, o.client_user_id, o.paid_at, o.created_at,
         COALESCE(SUM(si.received::numeric + COALESCE(rbi.refunded, 0))
                  FILTER (WHERE si.is_experience = false), 0) AS non_trial,
         COALESCE(SUM(si.received::numeric + COALESCE(rbi.refunded, 0))
                  FILTER (WHERE si.is_experience = true), 0) AS trial
    FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    LEFT JOIN refund_by_item rbi ON rbi.sale_item_id = si.sale_item_id
    -- 2026-04-26 sale-order-domain-refactor 后，回款下沉到
    -- sale_order_payments.change_type='回款'，sale_order_type 枚举已不含“回款单”。
   WHERE o.status IN ('已支付', '已完成')
     AND o.sale_order_type = '销售单'
     AND o.client_user_id IS NOT NULL
     AND si.item_direction = '购买'
   GROUP BY o.sale_order_id, o.client_user_id, o.paid_at, o.created_at
),
qualified_orders AS (
  -- 非体验部分毛实收达阈值的订单。保留 paid_at / created_at 原始列供 member_first
  -- 按 paid_at ASC NULLS LAST 选单（与 recalc-became-member-at.js 同口径）。
  SELECT client_user_id, sale_order_id, paid_at, created_at
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
         COALESCE(paid_at, created_at) AS first_qualified_at
    FROM qualified_orders
   ORDER BY client_user_id, paid_at ASC NULLS LAST, created_at ASC
),
-- 2026-04-26 sku-capability 切换：xiaomei/tiyan 直接用 sale_items.is_experience 判定
-- 充值卡 SKU 的 is_experience=false → 充值卡购买视同"小美客"消费（D1=A）
-- #187 起改判金额：存在一张单其 non_trial > 0（小美客）/ trial > 0（体验客），
-- 与七处运行时副本的 non_trial > 0 / trial > 0 分支同口径。
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
  SELECT client_user_id AS user_id,
         COALESCE(SUM(paid_amount::numeric), 0) AS spend
    FROM sale_orders
   WHERE sale_order_type = '销售单'
     AND paid_amount > 0
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
       m.first_qualified_at
  FROM client_wechat_users u
  LEFT JOIN member_first m ON m.user_id = u.user_id
  LEFT JOIN xiaomei_users x ON x.user_id = u.user_id
  LEFT JOIN tiyan_users  t ON t.user_id = u.user_id
  LEFT JOIN spend_12m    s ON s.user_id = u.user_id
`

const TYPE_RANK_CASE = `
  CASE customer_type
    WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
    WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
  END
`
const NEW_TYPE_RANK_CASE = `
  CASE new_type
    WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
    WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
  END
`

const PREVIEW_TRANSITIONS_SQL = `
SELECT old_type, new_type, COUNT(*)::int AS cnt
  FROM _recalc_target
 WHERE (CASE old_type
          WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
          WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
        END) < (CASE new_type
          WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
          WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
        END)
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

// 按 rank 严格向上跃迁；对已是目标态或更高的不动
const UPDATE_TYPE_SQL = `
UPDATE client_wechat_users u
   SET customer_type = t.new_type,
       updated_at = NOW()
  FROM _recalc_target t
 WHERE u.user_id = t.user_id
   AND (CASE u.customer_type
          WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
          WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
        END) < (CASE t.new_type
          WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
          WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
        END)
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
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type = '会员客' AND became_member_at IS NULL)::int AS member_no_became,
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type != '会员客' AND member_level IS NOT NULL)::int AS nonmember_with_level
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
    // fail-fast：阈值必须从 system_configs 读到合法正数，否则拒绝执行
    const thRows = (await client.query(FETCH_THRESHOLD_SQL)).rows
    const threshold = thRows[0] ? Number(thRows[0].v) : NaN
    if (!Number.isFinite(threshold) || threshold <= 0) {
      log(`✗ system_configs.new_member_threshold 缺失或非法（取到 ${JSON.stringify(thRows[0])}）；脚本拒绝执行`)
      process.exitCode = 1
      return
    }
    log(`阈值: ${threshold}（来自 system_configs.new_member_threshold）`)

    await client.query('BEGIN')
    log('构建 _recalc_target 临时表...')
    await client.query(BUILD_TARGET_TABLE_SQL, [threshold])

    const transitions = await client.query(PREVIEW_TRANSITIONS_SQL)
    log(`customer_type 待跃迁分布:`)
    let totalUp = 0
    for (const r of transitions.rows) {
      log(`  ${r.old_type} → ${r.new_type}: ${r.cnt}`)
      totalUp += r.cnt
    }
    log(`  合计待 UPDATE customer_type: ${totalUp} 行`)

    const levels = await client.query(PREVIEW_LEVEL_SQL)
    log(`member_level 初始化分布（会员客 ∩ old_level=NULL）:`)
    let totalLevel = 0
    for (const r of levels.rows) {
      log(`  ${r.new_level || 'NULL（消费<阈值，跳过）'}: ${r.cnt}`)
      totalLevel += r.cnt
    }
    log(`  合计待 UPDATE member_level: ${totalLevel} 行`)

    const became = await client.query(PREVIEW_BECAME_SQL)
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

main().catch((err) => {
  console.error('未捕获异常:', err)
  process.exit(1)
})
