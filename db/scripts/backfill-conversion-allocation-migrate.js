#!/usr/bin/env node

/**
 * backfill-conversion-allocation-migrate.js — 迁移「已分配」转换单的老分配到「按回款逐笔」结构
 *
 * 背景：
 *   backfill-conversion-spai.js 故意跳过「已有 sale_allocations」的转换单（防双计），而
 *   backfill-conversion-allocation-status.js 又把这类单的 payment.allocation_status 置成
 *   「已分配」。结果：列表显示「已分配 + payment.amount」，但详情依赖 SPAI（0 行）→
 *   「本次回款额 ¥0 + 暂无可分配明细项」矛盾（图里这单 FY-XSD-WX-2607130014 即此症状）。
 *
 *   本脚本对「已分配 + 老 sale_allocations.sale_payment_id IS NULL」的转换单做数据迁移对齐：
 *   按老分配口径补 SPAI（amount = 各 item 的 sale_amount）+ 把老分配回填到对应 payment。
 *   员工提成（total_amount / commission_amount / allocation_ratio）完全不变，仅让详情页
 *   能正确展示历史分配。
 *
 * 选行口径（每个命中的 payment）：
 *   sale_order_type='转换单' AND legacy_source IS DISTINCT FROM 'workfine'
 *   AND allocation_status='已分配' AND change_type ∈ ('首次支付','回款','储值卡抵扣')
 *   AND 同单存在 sale_payment_id IS NULL 的非 void 老分配
 *   AND 该 payment 尚无 SPAI 行                                       -- 幂等
 *
 * 回填规则（每个命中 payment，事务内逐笔）：
 *   1. 预检：该订单仅此 1 笔已分配 payment（多笔则告警跳过，避免挂错）
 *   2. 预检：同单老分配里 (sale_item_id, employee_id, role_type) 无重复（回填后唯一索引不冲突）
 *   3. 补 SPAI：对老分配覆盖的每个 sale_item_id，写 amount=si.sale_amount、sales_category=
 *      si.sales_category；Σ SPAI 应 = payment.amount，不等则告警（仍按老口径补，人工核对）
 *   4. UPDATE 老分配：SET sale_payment_id=该 payment（is_void=false AND sale_payment_id IS NULL）
 *
 * 幂等：回填后老分配 sale_payment_id 非 NULL + SPAI 已存在 → BASE_WHERE 不再命中，重跑只补新增。
 * 安全：不改 total_amount/commission_amount/allocation_ratio；不动 allocation_status/金额/次数。
 *
 * 用法：
 *   # dry-run（默认，仅打印 + 预检）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-allocation-migrate.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-conversion-allocation-migrate.js --apply
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
  console.log(`[BACKFILL-CONV-ALLOC-MIGRATE] ${new Date().toISOString()} ${msg}`)
}

const BASE_WHERE = `
  so.sale_order_type = '转换单'
  AND so.legacy_source IS DISTINCT FROM 'workfine'
  AND sop.allocation_status = '已分配'
  AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
  AND EXISTS (
    SELECT 1 FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE si.sale_order_id = so.sale_order_id AND sa.is_void = false AND sa.sale_payment_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM sale_payment_allocatable_items spai WHERE spai.sale_payment_id = sop.id
  )
`

const TARGET_SQL = `
SELECT sop.id AS payment_id, sop.sale_order_id, sop.amount::numeric AS amount
FROM sale_order_payments sop
JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
WHERE ${BASE_WHERE}
ORDER BY sop.id
`

async function migrateOne(client, { payment_id, sale_order_id, amount }) {
  // 预检1：该订单已分配 payment 数量（多笔则挂错风险，跳过）
  const cnt = await client.query(
    `SELECT count(*)::int AS n FROM sale_order_payments
      WHERE sale_order_id = $1 AND allocation_status = '已分配'
        AND change_type IN ('首次支付','回款','储值卡抵扣')`,
    [sale_order_id],
  )
  if (cnt.rows[0].n > 1) {
    log(`  ⚠️ 跳过 payment ${payment_id}（订单 ${sale_order_id} 有 ${cnt.rows[0].n} 笔已分配 payment，需人工裁定挂哪笔）`)
    return { skipped: true }
  }

  // 预检2：同单老分配里 (sale_item_id, employee_id, role_type) 无重复（回填后不撞唯一索引）
  const dup = await client.query(
    `SELECT sa.sale_item_id, sa.employee_id, sa.role_type, count(*)::int AS n
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      WHERE si.sale_order_id = $1 AND sa.is_void = false AND sa.sale_payment_id IS NULL
      GROUP BY sa.sale_item_id, sa.employee_id, sa.role_type HAVING count(*) > 1`,
    [sale_order_id],
  )
  if (dup.rows.length > 0) {
    log(`  ⚠️ 跳过 payment ${payment_id}：同单老分配有 ${dup.rows.length} 组 (item,employee,role) 重复，回填会撞唯一索引，需人工处理`)
    return { skipped: true }
  }

  // 老分配覆盖的 item + sale_amount/sales_category（distinct by sale_item_id）
  const itemsRes = await client.query(
    `SELECT DISTINCT si.sale_item_id, si.sale_amount::numeric AS sale_amount, si.sales_category, si.item_direction
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      WHERE si.sale_order_id = $1 AND sa.is_void = false AND sa.sale_payment_id IS NULL`,
    [sale_order_id],
  )
  const items = itemsRes.rows
  if (items.length === 0) {
    log(`  ⚠️ payment ${payment_id} 无老分配 item，跳过`)
    return { skipped: true }
  }

  const sumSaleAmt = items.reduce((s, r) => s + Number(r.sale_amount), 0)
  const sumOk = Math.round(sumSaleAmt * 100) === Math.round(Number(amount) * 100)
  log(
    `  payment ${payment_id}（订单 ${sale_order_id}，payment.amount=${amount}）：老分配覆盖 ${items.length} 个 item，Σsale_amount=${sumSaleAmt.toFixed(2)} ` +
      (sumOk ? '✓=payment.amount' : '⚠️≠payment.amount（仍按老口径补 SPAI，请人工核对）'),
  )
  for (const it of items) {
    log(`    - ${it.sale_item_id} (${it.item_direction}, sale_amount=${it.sale_amount}, sales_category=${it.sales_category || 'NULL'})`)
  }

  if (!apply) return { skipped: false, spai: items.length, alloc: null }

  // A. 补 SPAI（按老分配口径 = item.sale_amount）
  let spaiRows = 0
  for (const it of items) {
    const r = await client.query(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4::numeric, $5, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category`,
      [payment_id, sale_order_id, it.sale_item_id, it.sale_amount, it.sales_category],
    )
    spaiRows += r.rowCount
  }

  // B. 回填老分配 sale_payment_id（不改 total_amount/commission_amount/allocation_ratio/is_void）
  const upd = await client.query(
    `UPDATE sale_allocations SET sale_payment_id = $1
      WHERE sale_payment_id IS NULL AND is_void = false
        AND sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $2)`,
    [payment_id, sale_order_id],
  )

  log(`  ✓ APPLY payment ${payment_id}：写 SPAI ${spaiRows} 行，回填 ${upd.rowCount} 行老分配 sale_payment_id`)
  return { skipped: false, spai: spaiRows, alloc: upd.rowCount }
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
    await client.query('BEGIN')

    const targets = await client.query(TARGET_SQL)
    log(`目标 payment：${targets.rows.length} 笔`)

    let applied = 0
    let skipped = 0
    let spaiTotal = 0
    let allocTotal = 0
    for (const t of targets.rows) {
      const res = await migrateOne(client, t)
      if (res.skipped) {
        skipped++
      } else {
        applied++
        spaiTotal += res.spai || 0
        allocTotal += res.alloc || 0
      }
    }

    if (apply) {
      await client.query('COMMIT')
      log(
        `APPLY 完成：迁移 ${applied} 笔（写 SPAI ${spaiTotal} 行 / 回填 allocation ${allocTotal} 行），跳过 ${skipped} 笔，事务已提交`,
      )
    } else {
      await client.query('ROLLBACK')
      log(`DRY-RUN：将迁移 ${applied} 笔（拟写 SPAI ${spaiTotal} 行），跳过 ${skipped} 笔。已回滚，加 --apply 提交。`)
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
