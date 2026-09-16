#!/usr/bin/env node

/**
 * backfill-conversion-spai.js — 一次性回填存量转换单回款的 sale_payment_allocatable_items
 * （capture 转换单分支旧版 return [] 短路遗留的空 SPAI）。
 *
 * 背景：
 *   capturePaymentAllocatables 用 `item_direction='购买'` 取可分配明细，转换单明细只有
 *   「转出/转入」、命中 0 行 → 旧版直接 return [] 不产 SPAI。修复后转换单分支按本笔净实收
 *   落 1 条 SPAI 到「转入」行（业绩载体），让转换单像销售单一样按每笔回款逐笔分配。
 *   capture（4 副本）已修，本脚本补存量历史数据。
 *
 * 选行口径（每笔回款主流水行）：
 *   sale_order_type='转换单' AND legacy_source IS DISTINCT FROM 'workfine'
 *   AND payment 的 allocation_status IS NOT NULL
 *   AND change_type ∈ ('首次支付','回款','储值卡抵扣')   -- 与 capture 主流水行口径一致
 *   AND 订单存在 item_direction='转入' 行（业绩载体；LATERAL 取首行）
 *   AND 订单不存在非 void 的 sale_allocations   -- ★ 排除已整单分配（防双计，见下）
 *   AND 该 payment 尚无 SPAI 行                  -- 幂等
 *
 * 回填规则：
 *   INSERT 1 条 SPAI（sale_item_id=转入行，amount=payment.amount 本笔净实收，
 *   sales_category=转入行 sales_category）。ON CONFLICT (sale_payment_id, sale_item_id) 幂等 upsert。
 *   不改 allocation_status（eb586a9d 的 backfill-conversion-allocation-status.js 已把 NULL→待分配/已分配）。
 *
 * 安全性：
 *   - ★ 防双计：跳过「已有非 void sale_allocations」的转换单。这类单是历史经 admin
 *     batchSaveAllocations 整单分配过（sale_allocations.sale_payment_id 为 NULL），
 *     若再补 SPAI，店长按回款重分配会在旧整单行之上叠加新 per-payment 行 → 业绩双计。
 *   - 不动 received/金额/次数；SPAI 仅是按回款分配基数。
 *   - 幂等：NOT EXISTS(spai) + ON CONFLICT，重复跑只补新增。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-spai.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-spai.js --apply
 *
 * 顺序：先 dev(101.34.242.103:5433) --apply 验证；再 prod(118.178.196.26:5433) --apply。
 * 永远显式传 DATABASE_URL。两个库同名同端口，仅靠 IP 区分，执行前核对连接串 IP。
 * e2e 绝不碰生产 IP 118.178.196.26。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-CONVERSION-SPAI] ${new Date().toISOString()} ${msg}`)
}

// 转换单（非历史单）+ 回款主流水行 + 有转入行 + 未整单分配 + 尚无 SPAI
const BASE_WHERE = `
  so.sale_order_type = '转换单'
  AND so.legacy_source IS DISTINCT FROM 'workfine'
  AND sop.allocation_status IS NOT NULL
  AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
  AND tin.sale_item_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE si.sale_order_id = so.sale_order_id AND sa.is_void = false
  )
  AND NOT EXISTS (
    SELECT 1 FROM sale_payment_allocatable_items spai WHERE spai.sale_payment_id = sop.id
  )
`

const LATERAL_TIN = `
  LEFT JOIN LATERAL (
    SELECT sale_item_id, sales_category FROM sale_items
    WHERE sale_order_id = so.sale_order_id AND item_direction = '转入'
    ORDER BY sale_item_id LIMIT 1
  ) tin ON true
`

const PREVIEW_SQL = `
SELECT
  COUNT(DISTINCT sop.id)::int AS target_payment_rows,
  COUNT(DISTINCT sop.sale_order_id)::int AS target_orders,
  COALESCE(SUM(sop.amount), 0)::numeric AS total_amount
FROM sale_order_payments sop
JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
${LATERAL_TIN}
WHERE ${BASE_WHERE}
`

const SAMPLE_SQL = `
SELECT sop.id AS sale_payment_id, sop.sale_order_id, sop.amount, sop.change_type,
       tin.sale_item_id AS in_item_id, tin.sales_category AS in_sales_category,
       so.received AS order_received
FROM sale_order_payments sop
JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
${LATERAL_TIN}
WHERE ${BASE_WHERE}
ORDER BY sop.id
LIMIT 20
`

const APPLY_SQL = `
INSERT INTO sale_payment_allocatable_items
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sop.id, sop.sale_order_id, tin.sale_item_id, sop.amount::numeric, tin.sales_category, NOW()
FROM sale_order_payments sop
JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
${LATERAL_TIN}
WHERE ${BASE_WHERE}
ON CONFLICT (sale_payment_id, sale_item_id)
  DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category
RETURNING sale_payment_id, sale_order_id, sale_item_id, amount, sales_category
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
    await client.query('BEGIN')

    const preview = await client.query(PREVIEW_SQL)
    const p = preview.rows[0]
    log(`目标回款行：${p.target_payment_rows} 笔 / 涉及转换单 ${p.target_orders} 单 / 合计金额 ${p.total_amount}`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（前 20 笔：payment_id | sale_order_id | amount | change_type | 转入行 | sales_category | order_received）:')
      for (const r of sample.rows) {
        log(`  ${r.sale_payment_id} | ${r.sale_order_id} | ${r.amount} | ${r.change_type} | ${r.in_item_id} | ${r.in_sales_category} | ${r.order_received}`)
      }
    }

    if (apply) {
      const ins = await client.query(APPLY_SQL)
      log(`APPLY：写入 ${ins.rowCount} 条 spai（转换单回款 → 转入行，amount=本笔净实收）`)
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
