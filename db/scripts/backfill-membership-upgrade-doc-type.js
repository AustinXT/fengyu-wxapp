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
 *   is_membership_upgrade 打标代码（recalcCustomerType，四端镜像）已写好但尚未部署，
 *   存量单该标记全为 false；本脚本一并补打。
 *
 * 选单口径（与 staffApi/admin recalcCustomerType 打标 SQL 同源）：
 *   status IN ('已支付','已完成') AND sale_order_type='销售单' AND total_amount >= threshold
 *   ORDER BY paid_at ASC NULLS LAST, created_at ASC，每个顾客取最早一单。
 *   2026-04-26 sale-order-domain-refactor 后，回款单已从 sale_order_type 下沉到
 *   sale_order_payments.change_type='回款'，sale_orders 不再产生 sale_order_type='回款单' 行；
 *   payNotify 原回款累计分支已退化为恒为空的死代码，故不存在「超集单」需在线打标的场景。
 *   本脚本只需覆盖单笔 total_amount >= threshold 的销售单。
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
 * 顺序：先 5434/fengyu（dev）--apply 验证；再 5433/fengyu_wxapp（prod）--apply。
 * e2e 全部打 5434，绝不碰 5433 生产库。
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
SELECT DISTINCT ON (o.client_user_id)
       o.sale_order_id, o.client_user_id, o.total_amount, o.paid_at, o.created_at,
       o.document_type AS old_doc_type, o.is_membership_upgrade AS old_flag
  FROM sale_orders o
  JOIN client_wechat_users u ON u.user_id = o.client_user_id
 WHERE u.customer_type = '会员客'
   AND o.status IN ('已支付', '已完成')
   AND o.sale_order_type = '销售单'
   AND o.total_amount >= $1::numeric
   AND (u.became_member_at IS NULL OR COALESCE(o.paid_at, o.created_at) <= u.became_member_at)
 ORDER BY o.client_user_id, o.paid_at ASC NULLS LAST, o.created_at ASC
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

// 会员客但无达标单的异常顾客（供人工排查：可能 threshold 上调过或数据异常）
const ANOMALY_SQL = `
SELECT COUNT(*)::int AS cnt
  FROM client_wechat_users u
 WHERE u.customer_type = '会员客'
   AND NOT EXISTS (
     SELECT 1 FROM sale_orders o
      WHERE o.client_user_id = u.user_id
        AND o.status IN ('已支付', '已完成')
        AND o.sale_order_type = '销售单'
        AND o.total_amount >= $1::numeric
   )
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

    const anom = await client.query(ANOMALY_SQL, [threshold])
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
