#!/usr/bin/env node

/**
 * backfill-deposit-zero-real-price.js — 一次性回填存量寄存单 received=0 疗程卡行的
 * unit_real_price：从「回落标价 unit_price」改为「置 0」。
 *
 * 背景：
 *   寄存单（sale_order_type='寄存单'）录入时，recomputeDepositRealPrice 重算疗程卡
 *   unit_real_price = received/session_count；received=0 的行原走 ELSE unit_price
 *   （回落标价，当初为「避免 0 元/次异常显示」）。业务决定取消该替代——未收款就如实
 *   显示 0 元/次。两端 SQL 已改 ELSE 0（staff routes/order.js DEPOSIT_REAL_PRICE_RECALC_SQL
 *   + admin actions/orders.ts recomputeDepositRealPrice），本脚本修正存量历史数据。
 *
 * 选行口径（与 recomputeDepositRealPrice 的 WHERE 同源 + received=0 + 非已 0）：
 *   sale_order_type='寄存单' AND item_direction='购买' AND product_type='疗程卡'
 *   AND session_count > 0 AND COALESCE(received,0)=0 AND unit_real_price != 0
 *
 * 安全性：
 *   - 寄存单建单后 received 不可改（资金锁定），received=0 即建单时就是 0，回填安全。
 *   - unit_real_price 不参与 remaining_sessions/paid_sessions 核销口径，改它不影响次数。
 *   - 幂等：unit_real_price != 0 守护，二次运行无副作用。
 *
 * ⚠️ 副作用（提成口径）：寄存卡未来被消费时，service_items.unit_real_price 从 sale_items
 *   快照拷贝 → received=0 的行未来消费产生的服务单 consumeBase 将变 0（不计提成）。
 *   已发生的服务单不受影响（独立 snapshot）。逻辑上「没收钱不计提成」更合理，但属
 *   历史口径变更，执行前请与业务确认。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-deposit-zero-real-price.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-deposit-zero-real-price.js --apply
 *
 * 顺序：先 5434/fengyu（dev）--apply 验证；再 5433/fengyu_wxapp（prod）--apply。
 * 永远显式传 DATABASE_URL；e2e 全部打 5434，绝不碰 5433 生产库。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-DEPOSIT-ZERO-REAL-PRICE] ${new Date().toISOString()} ${msg}`)
}

const TARGET_WHERE = `
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE so.sale_order_type = '寄存单'
  AND si.item_direction = '购买'
  AND si.product_type = '疗程卡'
  AND si.session_count > 0
  AND COALESCE(si.received, 0) = 0
  AND si.unit_real_price != 0
`

const PREVIEW_SQL = `
SELECT
  COUNT(*)::int                         AS target_rows,
  COUNT(DISTINCT si.sale_order_id)::int AS target_orders
${TARGET_WHERE}
`

const SAMPLE_SQL = `
SELECT si.sale_item_id, si.sale_order_id, si.session_count, si.received::numeric AS received,
       si.unit_price::numeric AS unit_price, si.unit_real_price::numeric AS unit_real_price
${TARGET_WHERE}
ORDER BY si.sale_order_id
LIMIT 10
`

const UPDATE_SQL = `
UPDATE sale_items si
SET unit_real_price = 0,
    updated_at = NOW()
FROM sale_orders so
WHERE si.sale_order_id = so.sale_order_id
  AND so.sale_order_type = '寄存单'
  AND si.item_direction = '购买'
  AND si.product_type = '疗程卡'
  AND si.session_count > 0
  AND COALESCE(si.received, 0) = 0
  AND si.unit_real_price != 0
RETURNING si.sale_item_id, si.sale_order_id
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
    log(`命中：${p.target_rows} 行 / ${p.target_orders} 单（received=0 且 unit_real_price 非 0 的疗程卡寄存行）`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（前 10 行：sale_item_id | sale_order_id | session_count | received | unit_price | unit_real_price）:')
      for (const r of sample.rows) {
        log(`  ${r.sale_item_id} | ${r.sale_order_id} | ${r.session_count} | ${r.received} | ${r.unit_price} | ${r.unit_real_price}`)
      }
    }

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      log(`APPLY 完成：已将 ${upd.rowCount} 行 unit_real_price 置 0`)
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
