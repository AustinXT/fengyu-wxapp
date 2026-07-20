#!/usr/bin/env node

/**
 * backfill-conversion-allocation-status.js — 一次性回填存量转换单的
 * sale_order_payments.allocation_status（capture 短路遗留的 NULL）+ 订单级 rollup。
 *
 * 背景：
 *   capturePaymentAllocatables 用 `item_direction='购买'` 取可分配明细，而转换单明细
 *   只有「转出/转入」、命中 0 行 → 早返回 `return []`，跳过了给回款行置
 *   `allocation_status='待分配'`。结果转换单回款行 allocation_status 永远 NULL，
 *   被「营业额分配」列表的 `IS NOT NULL` 过滤掉（订单级又被 rollup 的 ELSE 误判为
 *   「已分配」）。capture（转换单分支补置『待分配』）+ rollup（ELSE 不再武断置『已分配』）
 *   两端已修，本脚本修正存量历史数据。
 *
 * 选行口径：
 *   sale_order_type='转换单' AND legacy_source IS DISTINCT FROM 'workfine'
 *   订单下 allocation_status IS NULL 的回款行
 *
 * 回填规则：
 *   - 订单存在非 void 的 sale_allocations → 回款行置『已分配』（店长已整单分配过）
 *   - 否则 → 置『待分配』（待店长在 admin 整单分配）
 *   随后按 rollup 同口径刷新 sale_orders.allocation_status
 *
 * 安全性：
 *   - 只动 allocation_status IS NULL 的回款行；已是『待分配/已分配』的不受影响（幂等）。
 *   - allocation_status 仅是分配流程状态标记，不影响 received/金额/次数。
 *   - priceDiff≤0 的转换单（无回款行）不被命中（无 payment 行可改），其订单级状态
 *     由 rollup 的 ELSE『保持原值』维持，不在本次范围。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-allocation-status.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-allocation-status.js --apply
 *
 * 顺序：先 dev(47.113.202.7:5433) --apply 验证；再 prod(118.178.196.26:5433) --apply。
 * 永远显式传 DATABASE_URL。两个库同名同端口，仅靠 IP 区分，执行前核对连接串 IP。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-CONVERSION-ALLOC] ${new Date().toISOString()} ${msg}`)
}

// 转换单（非历史单）的订单集合口径
const CONVERSION_ORDERS = `
  sale_order_type = '转换单'
  AND legacy_source IS DISTINCT FROM 'workfine'
`

// 订单是否存在非 void 的营业额分成（= 店长已整单分配过）
const HAS_ALLOCATION = `
  EXISTS (
    SELECT 1 FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE si.sale_order_id = so.sale_order_id AND sa.is_void = false
  )
`

const PREVIEW_SQL = `
SELECT
  COUNT(DISTINCT so.sale_order_id)::int AS conversion_orders,
  COUNT(sop.id)::int AS total_payment_rows,
  COUNT(sop.id) FILTER (WHERE sop.allocation_status IS NULL)::int AS null_payment_rows,
  COUNT(DISTINCT so.sale_order_id) FILTER (WHERE ${HAS_ALLOCATION})::int AS orders_with_allocations
FROM sale_orders so
LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
WHERE so.${CONVERSION_ORDERS}
`

const SAMPLE_SQL = `
SELECT so.sale_order_id,
       so.allocation_status AS order_status,
       COUNT(sop.id)::int AS payment_rows,
       COUNT(sop.id) FILTER (WHERE sop.allocation_status IS NULL)::int AS null_rows,
      (${HAS_ALLOCATION}) AS has_allocation
FROM sale_orders so
LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
WHERE so.${CONVERSION_ORDERS}
GROUP BY so.sale_order_id, so.allocation_status
ORDER BY so.sale_order_id
LIMIT 20
`

// 回填回款行：有 allocation → 已分配；无 → 待分配。仅动 IS NULL 行（幂等）
const UPDATE_PAYMENT_SQL = `
UPDATE sale_order_payments sop
SET allocation_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM sale_allocations sa
        JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        WHERE si.sale_order_id = sop.sale_order_id AND sa.is_void = false
      ) THEN '已分配'::allocation_status
      ELSE '待分配'::allocation_status
    END
WHERE sop.allocation_status IS NULL
  AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
  AND sop.sale_order_id IN (
    SELECT sale_order_id FROM sale_orders WHERE ${CONVERSION_ORDERS}
  )
RETURNING sop.id, sop.sale_order_id, sop.allocation_status
`

// 按修复后的 rollup 同口径刷新订单级状态
const REFRESH_ORDER_SQL = `
UPDATE sale_orders so
SET allocation_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM sale_order_payments
        WHERE sale_order_id = so.sale_order_id AND allocation_status = '待分配'
      ) THEN '待分配'::allocation_status
      WHEN EXISTS (
        SELECT 1 FROM sale_order_payments
        WHERE sale_order_id = so.sale_order_id AND allocation_status IS NOT NULL
      ) THEN '已分配'::allocation_status
      ELSE so.allocation_status
    END,
    updated_at = NOW()
WHERE so.${CONVERSION_ORDERS}
RETURNING so.sale_order_id, so.allocation_status
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
    log(`转换单：${p.conversion_orders} 单 / 回款行 ${p.total_payment_rows}（其中 NULL ${p.null_payment_rows}）/ 已有 allocation 的单 ${p.orders_with_allocations}`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（前 20 单：sale_order_id | order_status | payment_rows | null_rows | has_allocation）:')
      for (const r of sample.rows) {
        log(`  ${r.sale_order_id} | ${r.order_status || 'NULL'} | ${r.payment_rows} | ${r.null_rows} | ${r.has_allocation}`)
      }
    }

    if (apply) {
      const upd = await client.query(UPDATE_PAYMENT_SQL)
      log(`APPLY 回款行：更新 ${upd.rowCount} 行 allocation_status（NULL → 已分配/待分配）`)

      const ref = await client.query(REFRESH_ORDER_SQL)
      const toAllocated = ref.rows.filter((r) => r.allocation_status === '已分配').length
      const toPending = ref.rows.filter((r) => r.allocation_status === '待分配').length
      log(`APPLY 订单级 rollup：刷新 ${ref.rowCount} 单（→已分配 ${toAllocated} / →待分配 ${toPending}）`)

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
