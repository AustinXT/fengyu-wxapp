#!/usr/bin/env bun
/**
 * 数据审计脚本（ticket 2026-05-19）：admin confirmOfflinePayment 缺扣卡逻辑导致的存量漂移
 *
 * 修复 admin orders.ts confirmOfflinePayment 扣卡逻辑前，可能存在如下漂移：
 *   sale_orders.prepaid_card_amount > 0  + status ∈ {已支付,部分支付,已完成,待确认收款}
 *   但对应的 card_transactions 没有 type='扣款' ref_order_id 命中 → 顾客余额从未被扣减
 *
 * 用法：
 *   DATABASE_URL=postgres://.../5434/fengyu bun run scripts/audit-admin-prepaid-card-deduct-drift.ts
 *   DATABASE_URL=postgres://.../5434/fengyu bun run scripts/audit-admin-prepaid-card-deduct-drift.ts --json
 *
 * 退出码：
 *   0 — 无漂移记录
 *   1 — 至少 1 条漂移
 *   2 — 环境变量缺失
 */

import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL ?? process.env.PG_CONNECTION_STRING
if (!connectionString) {
  console.error('ERROR: DATABASE_URL or PG_CONNECTION_STRING is required')
  process.exit(2)
}

const jsonMode = process.argv.includes('--json')
const sql = postgres(connectionString, { max: 1 })

type DriftRow = {
  sale_order_id: string
  client_user_id: string | null
  prepaid_card_amount: string
  total_amount: string
  status: string
  created_at: Date
  opened_by: string | null
}

function inferSourceHint(saleOrderId: string): string {
  if (saleOrderId.startsWith('FY-XSD-WX-')) return 'wx-staff-or-client'
  if (saleOrderId.startsWith('FY-HKD-WX-')) return 'wx-repayment'
  if (saleOrderId.startsWith('FY-')) return 'admin-or-legacy'
  return 'unknown'
}

async function main() {
  if (!jsonMode) {
    console.log(`[audit-admin-prepaid-card-deduct-drift] DB: ${connectionString!.replace(/:[^:@]+@/, ':***@')}`)
    console.log('')
  }

  const driftRows = await sql<DriftRow[]>`
    SELECT so.sale_order_id,
           so.client_user_id,
           so.prepaid_card_amount::text AS prepaid_card_amount,
           so.total_amount::text AS total_amount,
           so.status::text AS status,
           so.created_at,
           so.opened_by
      FROM sale_orders so
     WHERE so.prepaid_card_amount > 0
       AND so.status IN ('已支付', '部分支付', '已完成', '待确认收款')
       AND NOT EXISTS (
         SELECT 1 FROM card_transactions ct
          WHERE ct.ref_order_id = so.sale_order_id AND ct.type = '扣款'
       )
     ORDER BY so.created_at DESC
     LIMIT 1000
  `

  if (jsonMode) {
    const totalDrift = driftRows.reduce((s, r) => s + Number(r.prepaid_card_amount || 0), 0)
    console.log(JSON.stringify({
      count: driftRows.length,
      total_drift_amount: totalDrift,
      rows: driftRows.map((r) => ({
        sale_order_id: r.sale_order_id,
        client_user_id: r.client_user_id,
        prepaid_card_amount: r.prepaid_card_amount,
        total_amount: r.total_amount,
        status: r.status,
        created_at: r.created_at.toISOString(),
        opened_by: r.opened_by,
        source_hint: inferSourceHint(r.sale_order_id),
      })),
    }, null, 2))
  } else {
    if (driftRows.length === 0) {
      console.log('[audit] PASS — 无漂移记录')
    } else {
      console.log(`[audit] FAIL — ${driftRows.length} 条漂移：`)
      console.log('')
      console.log('sale_order_id | client_user_id | prepaid_card_amount | status | created_at | source_hint')
      console.log('-'.repeat(120))
      for (const r of driftRows) {
        console.log(
          `${r.sale_order_id} | ${r.client_user_id ?? '(null)'} | ${r.prepaid_card_amount} | ${r.status} | ${r.created_at.toISOString()} | ${inferSourceHint(r.sale_order_id)}`,
        )
      }
      const totalDrift = driftRows.reduce((s, r) => s + Number(r.prepaid_card_amount || 0), 0)
      console.log('')
      console.log(`[audit] 总计：${driftRows.length} 条订单，漂移金额合计 ${totalDrift.toFixed(2)} 元`)
    }
  }

  await sql.end()

  if (driftRows.length > 0) {
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[audit] error:', err)
  process.exit(2)
})
