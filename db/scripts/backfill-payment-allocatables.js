#!/usr/bin/env node

/**
 * backfill-payment-allocatables.js — 一次性回填「按回款逐笔分配」存量数据
 *
 * 背景：
 *   2026-06-24 重构「营业额分配从按订单改为按回款逐笔分配」（commit 91a19ef9 / f2002074）。
 *   migration 0069 给 sale_order_payments 加 allocation_status 列、给 sale_allocations 加 sale_payment_id
 *   列、新建 sale_payment_allocatable_items 表，但**纯结构、无回填**。部署凑齐前积累的存量回款 /
 *   分配两列全 NULL，导致 admin「营业额分配-销售提成」(getPendingPayments) 与 staff allocation.pendingPayments
 *   列表全空（WHERE allocation_status='待分配' 不匹配 NULL）。
 *
 * 口径（与 fengyu-admin/src/lib/payment-allocatable.ts capturePaymentAllocatables 字面同义）：
 *   - 仅「销售单/转换单」且非历史单（legacy_source != 'workfine'）参与营业额分配；
 *   - 每笔正向回款（amount>0 且 change_type ∈ 首次支付/回款/储值卡抵扣）按各 sale_item（item_direction='购买'）
 *     的「剩余应付」(sale_amount − 已记 spai) 比例、最大余数法摊分，写 sale_payment_allocatable_items，
 *     并置该回款 allocation_status='待分配'；退款行(amount<0)天然跳过(evt>0 守卫)、保持 NULL；
 *   - 智能保留（用户决策）：订单若有非作废存量 sale_allocations，把它们统一关联到**首笔正向回款**
 *     (paid_at,id 升序)，并把该订单**全部正向回款**置 allocation_status='已分配'（整单视为已分配，保留已发提成，
 *     避免半已分配半待分配）；无旧分配的订单全部正向回款保持'待分配'；
 *   - 最后按 refreshOrderAllocationRollup 同义重算 sale_orders.allocation_status（任一回款待分配→订单待分配）。
 *
 * 用法（必须显式传库；先 5434 验证，再 5433 生产）：
 *   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-payment-allocatables.js              # dry-run（事务内跑完打印统计后 ROLLBACK）
 *   PG_CONNECTION_STRING="...5433/fengyu_wxapp" \
 *     node db/scripts/backfill-payment-allocatables.js --commit     # 实际写入（COMMIT）
 *
 * 幂等：spai 用 ON CONFLICT (sale_payment_id, sale_item_id) DO UPDATE；allocation_status / sale_payment_id 可重复置。
 * 自检：执行后每笔已 capture 回款的 Σspai.amount 应等于该回款 amount（容差 1 分）；脚本结束打印不一致项。
 */

const { Pool } = require('pg')

const ALLOCATABLE_TYPES = ['销售单', '转换单']
const POSITIVE_CHANGE_TYPES = ['首次支付', '回款', '储值卡抵扣']

const commit = process.argv.includes('--commit')
const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  max: 3,
})

function log(msg) {
  console.log(`[BACKFILL-PAY-ALLOC] ${new Date().toISOString()} ${msg}`)
}

/**
 * 非定向最大余数法摊分（与 capturePaymentAllocatables 字面同义）。
 * @param evtCents 本次回款额（分）
 * @param items [{saleItemId, saleAmount(number)}]
 * @param priorMap Map saleItemId -> 已记 spai 金额(number)
 * @returns [{saleItemId, cents}]
 */
function allocate(evtCents, items, priorMap) {
  let base = items.map((i) => ({
    saleItemId: i.saleItemId,
    w: Math.max(0, Math.round((Number(i.saleAmount) - (priorMap.get(i.saleItemId) || 0)) * 100) / 100),
  }))
  let totalW = base.reduce((s, b) => s + b.w, 0)
  if (totalW <= 0) {
    base = items.map((i) => ({ saleItemId: i.saleItemId, w: Math.max(0, Number(i.saleAmount)) }))
    totalW = base.reduce((s, b) => s + b.w, 0)
  }
  if (totalW <= 0) {
    return [{ saleItemId: items[0].saleItemId, cents: evtCents }]
  }
  const positive = base.filter((b) => b.w > 0)
  const parts = positive.map((b) => {
    const exact = (evtCents * b.w) / totalW
    const c = Math.floor(exact)
    return { saleItemId: b.saleItemId, cents: c, frac: exact - c }
  })
  const rem = evtCents - parts.reduce((s, p) => s + p.cents, 0)
  parts.sort((a, b) => b.frac - a.frac)
  for (let i = 0; i < rem; i++) parts[i].cents += 1
  return parts.filter((p) => p.cents > 0).map((p) => ({ saleItemId: p.saleItemId, cents: p.cents }))
}

/** 对单笔回款 capture（INSERT spai + 置待分配）。返回摊分明细数。 */
async function capturePayment(client, salePaymentId, saleOrderId, eventAmount) {
  const evt = Math.round(Number(eventAmount) * 100) / 100
  if (!(evt > 0)) return 0
  const itemsRes = await client.query(
    `SELECT sale_item_id, sale_amount::numeric AS sale_amount, sales_category
       FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
    [saleOrderId],
  )
  const items = itemsRes.rows.map((r) => ({
    saleItemId: r.sale_item_id,
    saleAmount: Number(r.sale_amount),
    salesCategory: r.sales_category || null,
  }))
  if (items.length === 0) return 0
  const catMap = new Map(items.map((i) => [i.saleItemId, i.salesCategory]))

  const priorRes = await client.query(
    `SELECT spai.sale_item_id, COALESCE(SUM(spai.amount::numeric), 0) AS allocated
       FROM sale_payment_allocatable_items spai
       JOIN sale_order_payments sop ON sop.id = spai.sale_payment_id
      WHERE spai.sale_order_id = $1
        AND sop.status = '已支付'
        AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
      GROUP BY spai.sale_item_id`,
    [saleOrderId],
  )
  const priorMap = new Map(priorRes.rows.map((r) => [r.sale_item_id, Number(r.allocated)]))

  const perItem = allocate(Math.round(evt * 100), items, priorMap)
  for (const d of perItem) {
    const cat = catMap.get(d.saleItemId) || null
    await client.query(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4::numeric, $5, NOW())
       ON CONFLICT (sale_payment_id, sale_item_id)
       DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category`,
      [salePaymentId, saleOrderId, d.saleItemId, (d.cents / 100).toFixed(2), cat],
    )
  }
  await client.query(
    `UPDATE sale_order_payments SET allocation_status = '待分配'::allocation_status WHERE id = $1`,
    [salePaymentId],
  )
  return perItem.length
}

async function main() {
  log(`mode = ${commit ? 'COMMIT' : 'DRY-RUN(rollback)'}  db = ${(process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@')}`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const orders = (
      await client.query(
        `SELECT DISTINCT so.sale_order_id
           FROM sale_orders so
           JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
          WHERE so.legacy_source IS DISTINCT FROM 'workfine'
            AND so.sale_order_type = ANY($1::sale_order_type[])
          ORDER BY so.sale_order_id`,
        [ALLOCATABLE_TYPES],
      )
    ).rows

    let nOrders = 0
    let nCaptured = 0
    let nKept = 0
    const keptMulti = []

    for (const { sale_order_id } of orders) {
      nOrders++
      const pos = (
        await client.query(
          `SELECT id, amount::numeric AS amount
             FROM sale_order_payments
            WHERE sale_order_id = $1 AND amount::numeric > 0
              AND change_type::text = ANY($2)
            ORDER BY paid_at, id`,
          [sale_order_id, POSITIVE_CHANGE_TYPES],
        )
      ).rows
      for (const p of pos) {
        const cnt = await capturePayment(client, p.id, sale_order_id, p.amount)
        if (cnt > 0) nCaptured++
      }

      const allocs = (
        await client.query(
          `SELECT sa.id
             FROM sale_allocations sa
             JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
            WHERE si.sale_order_id = $1 AND sa.is_void = false`,
          [sale_order_id],
        )
      ).rows
      if (allocs.length > 0 && pos.length > 0) {
        // 智能保留：旧分配统一关联首笔正向回款；整单正向回款置已分配
        await client.query(
          `UPDATE sale_allocations SET sale_payment_id = $1, updated_at = NOW()
            WHERE id = ANY($2::bigint[])`,
          [pos[0].id, allocs.map((a) => a.id)],
        )
        await client.query(
          `UPDATE sale_order_payments SET allocation_status = '已分配'::allocation_status
            WHERE id = ANY($1::bigint[])`,
          [pos.map((p) => p.id)],
        )
        nKept += allocs.length
        if (pos.length > 1) keptMulti.push({ order: sale_order_id, payments: pos.length, allocs: allocs.length })
      }

      // refreshOrderAllocationRollup 同义
      await client.query(
        `UPDATE sale_orders
            SET allocation_status = CASE
                  WHEN EXISTS (SELECT 1 FROM sale_order_payments
                                WHERE sale_order_id = $1 AND allocation_status = '待分配')
                  THEN '待分配'::allocation_status
                  WHEN EXISTS (SELECT 1 FROM sale_order_payments
                                WHERE sale_order_id = $1 AND allocation_status = '已分配')
                  THEN '已分配'::allocation_status
                  ELSE allocation_status END,
                updated_at = NOW()
          WHERE sale_order_id = $1`,
        [sale_order_id],
      )
    }

    // ---- 事务内统计（dry-run 也能看到效果）----
    const dist = (
      await client.query(
        `SELECT COALESCE(allocation_status::text,'(NULL)') st, count(*) c
           FROM sale_order_payments GROUP BY 1 ORDER BY 2 DESC`,
      )
    ).rows
    const spai = (await client.query(`SELECT count(*) c, COALESCE(SUM(amount::numeric),0) s FROM sale_payment_allocatable_items`)).rows[0]
    const allocPid = (await client.query(`SELECT count(*) FILTER (WHERE sale_payment_id IS NOT NULL) tagged, count(*) total FROM sale_allocations WHERE is_void = false`)).rows[0]
    // 自检：每笔已 capture 回款 Σspai 应 == 回款 amount（容差 1 分）
    const mismatch = (
      await client.query(
        `SELECT sop.id, sop.amount::numeric AS amt, COALESCE(s.sum_spai,0) AS spai
           FROM sale_order_payments sop
           JOIN (SELECT sale_payment_id, SUM(amount::numeric) sum_spai
                   FROM sale_payment_allocatable_items GROUP BY sale_payment_id) s
             ON s.sale_payment_id = sop.id
          WHERE ABS(sop.amount::numeric - COALESCE(s.sum_spai,0)) > 0.01`,
      )
    ).rows

    log(`订单处理 ${nOrders}，capture 回款 ${nCaptured} 笔，智能保留分配 ${nKept} 条`)
    log(`sale_order_payments.allocation_status 分布: ${dist.map((d) => `${d.st}=${d.c}`).join(', ')}`)
    log(`sale_payment_allocatable_items: ${spai.c} 行 / Σ${Number(spai.s).toFixed(2)}`)
    log(`sale_allocations(非作废) sale_payment_id 已填: ${allocPid.tagged}/${allocPid.total}`)
    if (keptMulti.length) log(`多笔回款单(首笔已分配/其余待分配): ${keptMulti.map((m) => `${m.order}(${m.payments}笔/${m.allocs}分配)`).join(', ')}`)
    if (mismatch.length) {
      log(`⚠️ 自检不一致 ${mismatch.length} 笔: ${mismatch.slice(0, 10).map((m) => `pay${m.id} amt${m.amt}≠spai${m.spai}`).join(', ')}`)
    } else {
      log(`✓ 自检通过：所有已 capture 回款 Σspai == 回款额`)
    }

    if (commit) {
      await client.query('COMMIT')
      log('COMMIT 完成')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN ROLLBACK（未写入）。确认无误后加 --commit 实跑')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    log(`ERROR: ${e.message}`)
    throw e
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
