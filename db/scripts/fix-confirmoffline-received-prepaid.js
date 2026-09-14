#!/usr/bin/env node

/**
 * fix-confirmoffline-received-prepaid.js — 一次性订正 staff confirmOffline 储值卡抵扣漏记 received 的存量订单
 *
 * 背景（2026-06-08）：
 *   staffApi routes/order.js 的 confirmOffline（修复前）用 `received = orderReceived + confirmAmount`
 *   直接加法落账，**漏算了储值卡抵扣金额**，破坏资金不变量
 *     I1: sale_orders.received = Σ(sale_order_payments.amount WHERE status='已支付'
 *                                 AND change_type IN ('首次支付','回款','储值卡抵扣'))
 *   后果：sale_orders.received 偏小 → recalcPaidSessionsForOrder STEP1 把「缺卡」的 received 按
 *   pending_received 比例摊到各行 → admin 订单详情「已确认实收」被现金比例稀释、可消费次数(paid_sessions)
 *   偏低、积分(settlePoints 按 received 算)少发。典型：FY-XSD-WX-2606080018 received 3793 应为 4794。
 *   （payNotify 线上 / admin confirmOfflinePayment / staff createRepayment 三处本就用「从流水重聚合」，无此 bug。）
 *
 * 修复策略（幂等，可重复运行；与修复后 confirmOffline / admin 同口径）：
 *   1. 定位破坏 I1 的订单：received ≠ Σ(已支付 首次支付/回款/储值卡抵扣)（容差 0.01，复用 audit-payment-invariants I1）
 *   2. 单事务内逐单：
 *      a. UPDATE sale_orders SET received=Σ流水, prepaid_card_amount=Σ储值卡抵扣（维护 I1 + I5 配套）
 *      b. recalcPaidSessionsForOrder：从订正后的 received 重摊 sale_items.received + paid_sessions
 *   3. 对每条订单链（去重 origId = ref_sale_order_id || sale_order_id）settlePointsForOrder：差值法补发少发积分
 *   注：不改 payable_amount（与四端落账口径一致，payable_amount 在 create 时定死 = total − 预选 prepaid）。
 *
 * ⚠️ 必须先部署修复后的 staffApi，否则新 confirmOffline 仍会写错，订正后又被破坏。
 *
 * 用法（务必显式传 DATABASE_URL；生产库 5433/fengyu_wxapp、开发库 5434/fengyu，勿混）：
 *   # dry-run（默认，事务末 ROLLBACK，只打印将订正的订单 + 金额/次数/积分变化）
 *   DATABASE_URL="postgresql://fengyu:***@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/fix-confirmoffline-received-prepaid.js
 *   # 显式提交
 *   DATABASE_URL="postgresql://fengyu:***@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/fix-confirmoffline-received-prepaid.js --apply
 */

const { Client } = require('pg')
const { recalcPaidSessionsForOrder } = require('../../fengyu-staff/cloudfunctions/staffApi/utils/paid-sessions')
const { settlePointsForOrder } = require('../../fengyu-staff/cloudfunctions/staffApi/utils/points')

const APPLY = process.argv.includes('--apply')

function log(msg) {
  console.log(`[FIX-CONFIRMOFFLINE-RECEIVED] ${new Date().toISOString()} ${msg}`)
}

// I1 检测：received ≠ Σ(已支付 首次支付/回款/储值卡抵扣)（容差 0.01）。与 audit-payment-invariants.ts I1 同口径。
const DETECT_SQL = `
  SELECT so.sale_order_id,
         so.ref_sale_order_id,
         so.client_user_id,
         so.received::numeric AS old_received,
         ROUND(COALESCE(SUM(sop.amount::numeric), 0), 2) AS computed_received
    FROM sale_orders so
    JOIN sale_order_payments sop
      ON sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
   GROUP BY so.sale_order_id, so.ref_sale_order_id, so.client_user_id, so.received
  HAVING ABS(so.received::numeric - COALESCE(SUM(sop.amount::numeric), 0)) > 0.01
   ORDER BY so.sale_order_id
`

// 重聚合 received / prepaid_card_amount（与修复后 confirmOffline / admin confirmOfflinePayment 同口径）
const REAGG_UPDATE_SQL = `
  UPDATE sale_orders so
     SET received = agg.new_received,
         prepaid_card_amount = agg.new_prepaid,
         updated_at = NOW()
    FROM (
      SELECT
        COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                          THEN amount::numeric ELSE 0 END), 0) AS new_received,
        COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                          THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
        FROM sale_order_payments
       WHERE sale_order_id = $1
    ) agg
   WHERE so.sale_order_id = $1
`

async function snapshotItems(client, saleOrderId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(paid_sessions), 0) AS ps,
            ROUND(COALESCE(SUM(received::numeric), 0), 2) AS rcv
       FROM sale_items
      WHERE sale_order_id = $1 AND item_direction = '购买'`,
    [saleOrderId],
  )
  return { ps: Number(r.rows[0].ps), rcv: Number(r.rows[0].rcv) }
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
  if (!url) {
    console.error('缺 DATABASE_URL（务必显式传：生产 5433/fengyu_wxapp、开发 5434/fengyu）')
    process.exit(1)
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  log(`连接成功，模式 = ${APPLY ? 'APPLY（提交）' : 'DRY-RUN（回滚，加 --apply 才提交）'}`)

  try {
    await client.query('BEGIN')

    const { rows: affected } = await client.query(DETECT_SQL)
    log(`定位到 ${affected.length} 个破坏 I1（received ≠ Σ已支付流水）的订单`)
    if (affected.length === 0) {
      await client.query('ROLLBACK')
      log('无需订正，退出')
      return
    }

    // 1) 逐单重聚合 received/prepaid + 重算 paid_sessions
    for (const o of affected) {
      const before = await snapshotItems(client, o.sale_order_id)
      await client.query(REAGG_UPDATE_SQL, [o.sale_order_id])
      await recalcPaidSessionsForOrder(client, o.sale_order_id)
      const after = await snapshotItems(client, o.sale_order_id)
      log(
        `  订单 ${o.sale_order_id}: received ${Number(o.old_received).toFixed(2)} → ${Number(o.computed_received).toFixed(2)}` +
        ` | Σ行received ${before.rcv} → ${after.rcv} | Σ行paid_sessions ${before.ps} → ${after.ps}`,
      )
    }

    // 2) 积分补发（差值法，按订单链去重；origId = ref_sale_order_id || sale_order_id）
    const origIds = [...new Set(affected.map((o) => o.ref_sale_order_id || o.sale_order_id))]
    let pointsTotal = 0
    for (const id of origIds) {
      const r = await settlePointsForOrder(client, id)
      if (r.delta) {
        pointsTotal += r.delta
        log(`  积分 链 ${id}: delta=${r.delta} (expected=${r.expected}, granted=${r.granted})`)
      } else if (r.skipped) {
        log(`  积分 链 ${id}: 跳过 (${r.skipped})`)
      }
    }

    log(`合计：订正 ${affected.length} 单；补发积分 ${pointsTotal >= 0 ? '+' : ''}${pointsTotal}`)

    if (APPLY) {
      await client.query('COMMIT')
      log('已提交 ✓')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN 已回滚（确认无误后加 --apply 重跑提交）')
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[FIX-CONFIRMOFFLINE-RECEIVED] 订正失败，已回滚：', err)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main()
