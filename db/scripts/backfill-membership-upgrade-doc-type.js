#!/usr/bin/env node

/**
 * backfill-membership-upgrade-doc-type.js — 一次性回填存量「成为会员那一单」的
 * is_membership_upgrade 标记 + document_type='售前一次'
 *
 * 背景：
 *   document_type 创建判定原含「金额达标算售后」分支 B，导致「成为会员那一单」
 *   （下单时仍非会员客、因金额达标触发分支 B）被判成「售后」。已改为仅按下单时
 *   会员身份判（分支 B 移除，售前=非会员客，售后=会员客）。本脚本修正存量：给每个
 *   已是会员客的顾客，把其 paid_at 最早的达标销售单改 document_type='售前一次' 并补打
 *   is_membership_upgrade。
 *
 *   is_membership_upgrade 打标代码（recalcCustomerType，八处副本）已写好但尚未部署，
 *   存量单该标记全为 false；本脚本一并补打。
 *
 * 选单口径（与 staffApi/admin recalcCustomerType 打标 SQL 同源；#187 起按非体验部分毛实收达标）：
 *   status IN ('已支付','已完成') AND sale_order_type='销售单' AND non_trial >= threshold
 *   （non_trial = Σ 非体验行的 received 净额 + 该行逐项退款额）
 *   ORDER BY paid_at ASC NULLS LAST, created_at ASC，每个顾客取最早一单。
 *   2026-04-26 sale-order-domain-refactor 后，回款单已从 sale_order_type 下沉到
 *   sale_order_payments.change_type='回款'，sale_orders 不再产生 sale_order_type='回款单' 行；
 *   payNotify 原回款累计分支已退化为恒为空的死代码，故不存在「超集单」需在线打标的场景。
 *   本脚本只需覆盖单笔 non_trial >= threshold 的销售单（#187 起按非体验部分毛实收，见上方选单口径）。
 *
 * 幂等：UPDATE WHERE 跳过 (is_membership_upgrade=true AND document_type='售前一次') 的行，
 *   二次运行无副作用。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-membership-upgrade-doc-type.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-membership-upgrade-doc-type.js --apply
 *
 * 顺序：先 dev(101.34.242.103:5433) --apply 验证；再 prod(118.178.196.26:5433) --apply。
 * 两库均 5433/fengyu_wxapp，仅 IP 区分；e2e 绝不碰 prod。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-MEM-UPGRADE] ${new Date().toISOString()} ${msg}`)
}

// 阈值仅从 system_configs.new_member_threshold 读取；缺失或非法时 fail-fast。
const FETCH_THRESHOLD_SQL = `
SELECT value::numeric AS v
  FROM system_configs
 WHERE key = 'new_member_threshold'
 LIMIT 1
`

// 每个会员客顾客 paid_at 最早的达标销售单（与 recalcCustomerType 打标 SQL 同源）。
// 关键守卫：AND (u.became_member_at IS NULL OR COALESCE(o.paid_at, o.created_at) <= u.became_member_at)
// —— 只选「成为会员那一刻或之前」的达标单。became_member_at 现口径 = 首笔达标单的
// COALESCE(paid_at, created_at)（见 recalc-became-member-at.js），故守卫也用 COALESCE
// 对齐；否则首单 paid_at 为 NULL 时 `NULL <= became_member_at` 求值为 NULL→false，会把
// 真正的首笔达标单误排除。若无此守卫，new_member_threshold 历史上调后，跃迁后的合法
// 「售后」达标单会被误选，进而在 UPDATE_SQL 被静默翻成「售前」+ 误打 is_membership_upgrade
// （review H1）。became_member_at IS NULL 时保守放行。
const BUILD_TARGET_SQL = `
CREATE TEMP TABLE _mem_upgrade_target ON COMMIT DROP AS
WITH refund_by_item AS (
  -- note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js RECEIVED_REFUNDED_DEDUCT_SQL，根除 22P02。
  SELECT sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0)) AS refunded
    FROM sale_order_payments sop
    JOIN sale_orders ro ON ro.sale_order_id = sop.sale_order_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
           THEN public.try_jsonb(sop.note) -> 'items'
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE ro.status IN ('已支付', '已完成')
     AND ro.sale_order_type = '销售单'
     AND sop.change_type = '退款'
     AND sop.status = '已支付'
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
   -- 序号绑定 SELECT 的前 2 列（sale_order_id, refSaleItemId）；重排 SELECT 列须同步改这里
   GROUP BY 1, 2
),
order_amounts AS (
  -- LEAST(…, sale_amount) 封顶 + 无明细行（WorkFine 历史单）回退订单级 received，
  -- 与运行时 RECALC_CUSTOMER_TYPE_CTE 同语义。
  SELECT o.sale_order_id, o.client_user_id, o.paid_at, o.created_at,
         CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
              THEN GREATEST(o.received::numeric, 0)
              ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),
                                      si.sale_amount::numeric))
                            FILTER (WHERE si.is_experience = false), 0)
         END AS non_trial
    FROM sale_orders o
    LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                           AND si.item_direction = '购买'
    LEFT JOIN refund_by_item rbi ON rbi.sale_order_id = o.sale_order_id
                                AND rbi.sale_item_id = si.sale_item_id
   WHERE o.status IN ('已支付', '已完成')
     AND o.sale_order_type = '销售单'
     AND o.client_user_id IS NOT NULL
   GROUP BY o.sale_order_id, o.client_user_id, o.paid_at, o.created_at, o.received
)
SELECT DISTINCT ON (o.client_user_id)
       o.sale_order_id, o.client_user_id, o.total_amount, o.paid_at, o.created_at,
       o.document_type AS old_doc_type, o.is_membership_upgrade AS old_flag
  FROM sale_orders o
  JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
  JOIN client_wechat_users u ON u.user_id = o.client_user_id
 WHERE u.customer_type = '会员客'
   AND oa.non_trial >= $1::numeric
   AND (u.became_member_at IS NULL OR COALESCE(o.paid_at, o.created_at) <= u.became_member_at)
 ORDER BY o.client_user_id, o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC
`

const PREVIEW_SQL = `
SELECT
  COUNT(*)::int                                            AS target_orders,
  COUNT(DISTINCT client_user_id)::int                      AS target_customers,
  SUM(CASE WHEN old_doc_type <> '售前一次' THEN 1 ELSE 0 END)::int          AS doc_type_to_fix,
  SUM(CASE WHEN old_flag = false THEN 1 ELSE 0 END)::int                    AS flag_to_set
  FROM _mem_upgrade_target
`

const UPDATE_SQL = `
UPDATE sale_orders
   SET is_membership_upgrade = true,
       document_type = '售前一次',
       updated_at = NOW()
 WHERE sale_order_id IN (SELECT sale_order_id FROM _mem_upgrade_target)
   AND (is_membership_upgrade = false OR document_type <> '售前一次')
RETURNING sale_order_id, client_user_id
`

// 会员客但无达标单的异常顾客（供人工排查：可能 threshold 上调过或数据异常）。
// #187：达标口径直接复用 _mem_upgrade_target（已按 non_trial >= 阈值 + became_member_at 守卫筛过），
// 避免这里再抄一遍判定 SQL 造成口径二次漂移。
// 注意语义差异：_mem_upgrade_target 带「成为会员那一刻或之前」守卫，故本计数含
// 「有达标单但全在 became_member_at 之后」的顾客——对人工排查而言同属需关注项。
const ANOMALY_SQL = `
SELECT COUNT(*)::int AS cnt
  FROM client_wechat_users u
 WHERE u.customer_type = '会员客'
   AND NOT EXISTS (SELECT 1 FROM _mem_upgrade_target t WHERE t.client_user_id = u.user_id)
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
    log(`命中：${p.target_orders} 单 / ${p.target_customers} 顾客；需改 document_type ${p.doc_type_to_fix} 单；需补 is_membership_upgrade ${p.flag_to_set} 单`)

    const anom = await client.query(ANOMALY_SQL)
    log(`会员客但无达标单（异常，需人工排查）：${anom.rows[0].cnt} 顾客`)

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      log(`APPLY 完成：已更新 ${upd.rowCount} 单`)
      await client.query('COMMIT')
      log('事务已提交')
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

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
