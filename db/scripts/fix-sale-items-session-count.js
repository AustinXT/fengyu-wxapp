#!/usr/bin/env node
/**
 * fix-sale-items-session-count.js
 *
 * 一次性脚本：修复 sale_items.session_count / remaining_sessions 漏乘 quantity 的脏数据。
 *
 * 背景：
 *   2026-05-18 之前的建单代码（staffApi/clientApi/order.js create + staffApi
 *   createConversion 转入）直接把 sku.session_count 写入 sale_items.session_count
 *   和 remaining_sessions，未乘 quantity。导致买 N 张"1 次卡"在 admin 订单详情显示
 *   "剩余 1/1 次"而非 "剩余 N/N 次"。
 *
 * 修复算法（数学保持 link-12 不变式 session_count == remaining_sessions + SUM(svi.session_used)）：
 *   new_session_count     = old_session_count × quantity
 *   new_remaining_sessions = old_remaining_sessions + old_session_count × (quantity - 1)
 *
 * 候选行判据：
 *   - quantity > 1 且 session_count > 0
 *   - session_count = product_skus.session_count（说明行 session_count 与 SKU 当前值相等，
 *     强烈暗示是脏数据；若 SKU 自建单后被改过则可能误判，dry-run 时人工剔除）
 *   - is_recharge_card IS NOT TRUE（充值卡走 card.js 另一路径，恒为 NULL）
 *   - item_direction = '购买'（转出/转入行不动）
 *   - 修前广义不变式：
 *       session_count == remaining_sessions + SUM(svi.session_used) + SUM(转出行.quantity)
 *     转出行 = item_direction='转出' AND ref_sale_item_id 指回本行；其 quantity 等于
 *     "从本行转走多少次"（createConversion 把 rem 全部计入 outItem.quantity，原卡 rs 清零）。
 *     若广义不变式仍不成立，数据状态异常需人工调查。
 *
 * 使用方式：
 *   # dry-run（默认，只打印将执行的 UPDATE 与新旧值对比）
 *   DATABASE_URL="postgresql://..." node db/scripts/fix-sale-items-session-count.js
 *
 *   # 真实执行
 *   DATABASE_URL="postgresql://..." node db/scripts/fix-sale-items-session-count.js --commit
 *
 *   # 仅修复指定 sale_item_id
 *   DATABASE_URL="..." node db/scripts/fix-sale-items-session-count.js --commit \
 *     --only-sale-item=XSLSH-WX-202604230009
 */

const { Client } = require('pg')

async function main() {
  const args = process.argv.slice(2)
  const COMMIT = args.includes('--commit')
  const ONLY = (args.find(a => a.startsWith('--only-sale-item=')) || '').split('=')[1] || null

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var not set.')
    process.exit(2)
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    await client.query('BEGIN')

    // 1. 选候选行（带 used 用量 + 转出消耗）
    const candidatesSql = `
      SELECT
        si.sale_item_id,
        si.sale_order_id,
        si.quantity,
        si.session_count,
        si.remaining_sessions,
        ps.session_count AS sku_session_count,
        COALESCE((SELECT SUM(svi.session_used) FROM service_items svi
                  WHERE svi.sale_item_id = si.sale_item_id), 0) AS used,
        COALESCE((SELECT SUM(out_si.quantity) FROM sale_items out_si
                  WHERE out_si.ref_sale_item_id = si.sale_item_id
                    AND out_si.item_direction = '转出'), 0) AS converted_out
      FROM sale_items si
      LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
      WHERE si.quantity > 1
        AND si.session_count IS NOT NULL
        AND si.session_count > 0
        AND si.session_count = ps.session_count
        AND si.is_recharge_card IS NOT TRUE
        AND si.item_direction = '购买'
        ${ONLY ? 'AND si.sale_item_id = $1' : ''}
      ORDER BY si.created_at
    `
    const candidates = await client.query(candidatesSql, ONLY ? [ONLY] : [])
    const rows = candidates.rows

    if (rows.length === 0) {
      console.log('未发现候选行。')
      await client.query('ROLLBACK')
      return
    }

    // 2. 不变式预校验（广义：sc == rs + used + converted_out）
    const violations = rows.filter(r =>
      Number(r.session_count) !== Number(r.remaining_sessions) + Number(r.used) + Number(r.converted_out)
    )
    if (violations.length > 0) {
      console.error('修前广义不变式违反，需人工调查（sc != rs + svi.session_used + 转出.quantity）：')
      for (const v of violations) {
        console.error(`  ${v.sale_item_id}: sc=${v.session_count} rs=${v.remaining_sessions} used=${v.used} converted_out=${v.converted_out}`)
      }
      throw new Error('数据状态异常，拒绝修复')
    }

    // 3. 打印 dry-run 报告
    console.log(`候选 ${rows.length} 行：`)
    let totalSessionsRestored = 0
    for (const r of rows) {
      const q = Number(r.quantity)
      const oldSc = Number(r.session_count)
      const oldRs = Number(r.remaining_sessions)
      const newSc = oldSc * q
      const newRs = oldRs + oldSc * (q - 1)
      totalSessionsRestored += (newRs - oldRs)
      const convOutMark = Number(r.converted_out) > 0 ? ` [conv_out=${r.converted_out}]` : ''
      console.log(`  ${r.sale_item_id} (订单 ${r.sale_order_id}): q=${q}, sc ${oldSc}→${newSc}, rs ${oldRs}→${newRs}, used=${r.used}${convOutMark}`)
    }
    console.log(`合计恢复客户权益次数：${totalSessionsRestored}`)

    // 4. COMMIT 模式：UPDATE（CAS 守卫旧值未被并发改）
    if (COMMIT) {
      // 收集受影响订单号，UPDATE 完成后统一重算 paid_sessions
      // 必要性：本脚本放大 session_count（×quantity），旧的 paid_sessions 是按未放大值算出的
      // → 公式 floor(min(1, settled/total) × session_count) 中 session_count 变大但
      //   settled/total 不变，旧值会"低估"已付次数，需重算以恢复一致。
      const affectedOrderIds = new Set()
      for (const r of rows) {
        const q = Number(r.quantity)
        const oldSc = Number(r.session_count)
        const oldRs = Number(r.remaining_sessions)
        const newSc = oldSc * q
        const newRs = oldRs + oldSc * (q - 1)
        const upd = await client.query(
          `UPDATE sale_items
             SET session_count = $1, remaining_sessions = $2, updated_at = NOW()
           WHERE sale_item_id = $3
             AND session_count = $4
             AND remaining_sessions = $5`,
          [newSc, newRs, r.sale_item_id, oldSc, oldRs]
        )
        if (upd.rowCount !== 1) {
          throw new Error(`CAS 失败 ${r.sale_item_id}（并发修改，rowCount=${upd.rowCount}）`)
        }
        affectedOrderIds.add(r.sale_order_id)
      }

      // 4b. 重算 paid_sessions（与 fengyu-client/cloudfunctions/clientApi/utils/paid-sessions.js
      //     PAID_SESSIONS_RECALC_SQL 字面同义；5 端工具函数同源，snapshot 守护）
      // 行级比例公式：paid_sessions = floor(min(1, (item.received - item_refund_share) / item.sale_amount) × session_count)
      //   item_refund_share = order.refunded × item.sale_amount / order.total （订单级退款按 sale_amount 下分）
      // 注意：此脚本是 node 独立进程，直接内联 SQL，避免依赖云函数目录
      const RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(LEAST(1, GREATEST(0, sale_items.received::numeric - (op.refunded_amount::numeric * sale_items.sale_amount::numeric / NULLIF(op.total_amount::numeric, 0))) / sale_items.sale_amount::numeric) * sale_items.session_count)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount, COALESCE(refunded_amount, 0) AS refunded_amount FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`
      for (const orderId of affectedOrderIds) {
        await client.query(RECALC_SQL, [orderId])
      }

      await client.query('COMMIT')
      console.log(`✓ 已修复 ${rows.length} 行（含 ${affectedOrderIds.size} 个订单的 paid_sessions 重算）`)
    } else {
      await client.query('ROLLBACK')
      console.log('（dry-run，未写入。加 --commit 真实执行）')
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    await client.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
