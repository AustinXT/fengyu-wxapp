#!/usr/bin/env node

/**
 * backfill-deposit-zero-svc-items.js — 一次性回填存量寄存 received=0 疗程卡核销产生的
 * service_items.unit_real_price（旧快照=标价）置 0，并同步作废已结算的服务提成
 * service_commissions（soft void），使 sale_items / service_items / 实耗业绩 / 已结算提成
 * 四处自洽（彻底落实「received=0 寄存卡核销不计业绩 / 不发提成」）。
 *
 * 背景：
 *   backfill-deposit-zero-real-price.js 已把 sale_items.unit_real_price 从「回落标价」改成 0
 *   （prod 260 行/213 单）。但 service_items.unit_real_price 是核销时从 sale_items 一次性
 *   快照拷贝的（service.create 时旧值=标价），不会随后续 sale_items 改动而变；且核销时
 *   已按旧基数发了服务提成（service_commissions 是死快照，无 trigger / 无 FK 级联 / 无 cron
 *   重算）。本脚本补齐下游：service_items 单价置 0 + 已结算提成作废。
 *
 * 选行口径（与 recomputeDepositRealPrice / backfill-deposit-zero-real-price.js 同源 +
 *   行级 received=0，不可用订单级 received=0 —— 会漏掉「订单 received>0 但某行 received=0」
 *   的单，如 HLD-WX-2607100007）：
 *   sale_order_type='寄存单' AND item_direction='购买' AND product_type='疗程卡'
 *   AND session_count > 0 AND COALESCE(sale_items.received,0)=0 AND service_items.unit_real_price != 0
 *
 * 安全性：
 *   - service_items.unit_real_price 不参与 remaining_sessions/paid_sessions 核销口径，改它不影响次数。
 *   - service_commissions 走 soft void（is_void=true + voided_at + voided_reason），与 refund-cascade
 *     作废提成模式一致；所有有效提成/实耗查询都过滤 is_void=false，自动归零自洽。原金额保留可见（审计）。
 *   - commission_status 保持「已分配」不动，避免这些单重新进入「待分配」队列被店长误操作。
 *   - 幂等：service_items 用 unit_real_price != 0 守护；service_commissions 用 is_void=false AND
 *     consume_amount!=0 守护。二次运行无副作用。
 *
 * ⚠️ 业务确认：本批 prod 34 行 service_items（31 已完成已分配 + 3 已取消），其中 30 行有有效
 *   提成合计 2009.60 元 / 16 员工，作废后这些提成不再计入员工绩效。业务已确认「没收钱不计提成」。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本，事务回滚）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-deposit-zero-svc-items.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-deposit-zero-svc-items.js --apply
 *
 * 顺序：先 dev(101.34.242.103:5433) --apply 验证脚本正确性；再 prod(118.178.196.26:5433) --apply。
 * 两库均 5433/fengyu_wxapp，仅 IP 区分。永远显式传 DATABASE_URL；e2e 绝不碰生产 IP 118.178.196.26。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-DEPOSIT-ZERO-SVC-ITEMS] ${new Date().toISOString()} ${msg}`)
}

// received=0 寄存疗程卡行（行级口径，与 backfill-deposit-zero-real-price.js 同源）
const DEPOSIT_ZERO_WHERE = `
  so.sale_order_type = '寄存单'
  AND sli.item_direction = '购买'
  AND sli.product_type   = '疗程卡'
  AND sli.session_count  > 0
  AND COALESCE(sli.received, 0) = 0
`

// PREVIEW: service_items 待改行（含幂等守护 sit.unit_real_price != 0）
const PREVIEW_ITEMS_SQL = `
SELECT
  COUNT(*)::int                          AS item_rows,
  COUNT(DISTINCT sit.service_order_id)::int AS svc_orders
FROM service_items sit
JOIN sale_items  sli ON sli.sale_item_id  = sit.sale_item_id
JOIN sale_orders so  ON so.sale_order_id  = sli.sale_order_id
WHERE ${DEPOSIT_ZERO_WHERE}
  AND sit.unit_real_price != 0
`

// PREVIEW: service_commissions 待作废（有效 + 有消耗提成 + 属于 received=0 寄存疗程卡）
const PREVIEW_COMM_SQL = `
SELECT
  COUNT(*)::int                                           AS comm_rows,
  COALESCE(SUM(sc.commission_amount), 0)::numeric(12,2)   AS comm_total
FROM service_commissions sc
WHERE sc.is_void = false
  AND sc.consume_amount != 0
  AND sc.service_item_id IN (
    SELECT sit.service_item_id
    FROM service_items sit
    JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
    JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
    WHERE ${DEPOSIT_ZERO_WHERE}
  )
`

// SAMPLE: service_items 前 10 行
const SAMPLE_ITEMS_SQL = `
SELECT sit.service_item_id, sit.service_order_id, sit.sale_item_id,
       sit.unit_real_price::numeric AS cur_urp, sit.session_used,
       sli.received::numeric AS sale_received, so.received::numeric AS order_received
FROM service_items sit
JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
WHERE ${DEPOSIT_ZERO_WHERE}
  AND sit.unit_real_price != 0
ORDER BY sit.service_order_id
LIMIT 10
`

// SAMPLE: service_commissions 前 10 行待作废
const SAMPLE_COMM_SQL = `
SELECT sc.id, sc.service_item_id, sc.employee_id, sc.role_type,
       sc.commission_amount::numeric AS commission_amount
FROM service_commissions sc
WHERE sc.is_void = false
  AND sc.consume_amount != 0
  AND sc.service_item_id IN (
    SELECT sit.service_item_id
    FROM service_items sit
    JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
    JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
    WHERE ${DEPOSIT_ZERO_WHERE}
  )
ORDER BY sc.id
LIMIT 10
`

// UPDATE 1: service_items.unit_real_price 置 0
const UPDATE_ITEMS_SQL = `
UPDATE service_items sit
SET unit_real_price = 0,
    updated_at = NOW()
FROM sale_items sli, sale_orders so
WHERE sli.sale_item_id = sit.sale_item_id
  AND so.sale_order_id  = sli.sale_order_id
  AND ${DEPOSIT_ZERO_WHERE}
  AND sit.unit_real_price != 0
RETURNING sit.service_item_id, sit.service_order_id, sit.sale_item_id
`

// UPDATE 2: service_commissions soft void（作废，保留审计痕迹）
const UPDATE_COMM_SQL = `
UPDATE service_commissions sc
SET is_void       = true,
    voided_at     = NOW(),
    voided_reason = '寄存单received=0疗程卡unit_real_price回填归零-提成同步作废',
    updated_at    = NOW()
WHERE sc.is_void = false
  AND sc.consume_amount != 0
  AND sc.service_item_id IN (
    SELECT sit.service_item_id
    FROM service_items sit
    JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
    JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
    WHERE ${DEPOSIT_ZERO_WHERE}
  )
RETURNING sc.id, sc.service_item_id, sc.employee_id, sc.commission_amount
`

// SELFCHECK（UPDATE 后跑，应全部归零）
const SELFCHECK_ITEMS_SQL = `
SELECT COUNT(*)::int AS remaining
FROM service_items sit
JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
WHERE ${DEPOSIT_ZERO_WHERE}
  AND sit.unit_real_price != 0
`

const SELFCHECK_COMM_SQL = `
SELECT
  COUNT(*)::int                                         AS remaining,
  COALESCE(SUM(sc.commission_amount), 0)::numeric(12,2) AS remaining_total
FROM service_commissions sc
WHERE sc.is_void = false
  AND sc.consume_amount != 0
  AND sc.service_item_id IN (
    SELECT sit.service_item_id
    FROM service_items sit
    JOIN sale_items  sli ON sli.sale_item_id = sit.sale_item_id
    JOIN sale_orders so  ON so.sale_order_id = sli.sale_order_id
    WHERE ${DEPOSIT_ZERO_WHERE}
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
    await client.query('BEGIN')

    const pItem = await client.query(PREVIEW_ITEMS_SQL)
    const pi = pItem.rows[0]
    log(`service_items 命中：${pi.item_rows} 行 / ${pi.svc_orders} 服务单`)

    const pComm = await client.query(PREVIEW_COMM_SQL)
    const pc = pComm.rows[0]
    log(`service_commissions 待作废：${pc.comm_rows} 行 / 合计 ${pc.comm_total} 元`)

    const sItem = await client.query(SAMPLE_ITEMS_SQL)
    if (sItem.rows.length > 0) {
      log('样本 service_items（前 10 行：service_item_id | service_order_id | sale_item_id | cur_urp | session_used | sale_received | order_received）:')
      for (const r of sItem.rows) {
        log(`  ${r.service_item_id} | ${r.service_order_id} | ${r.sale_item_id} | ${r.cur_urp} | ${r.session_used} | ${r.sale_received} | ${r.order_received}`)
      }
    }

    const sComm = await client.query(SAMPLE_COMM_SQL)
    if (sComm.rows.length > 0) {
      log('样本 service_commissions 待作废（前 10 行：id | service_item_id | employee_id | role_type | commission_amount）:')
      for (const r of sComm.rows) {
        log(`  ${r.id} | ${r.service_item_id} | ${r.employee_id} | ${r.role_type} | ${r.commission_amount}`)
      }
    }

    if (apply) {
      const uItem = await client.query(UPDATE_ITEMS_SQL)
      log(`APPLY 1/2：service_items 已置 0 共 ${uItem.rowCount} 行`)

      const uComm = await client.query(UPDATE_COMM_SQL)
      log(`APPLY 2/2：service_commissions 已作废共 ${uComm.rowCount} 行`)

      const scItem = await client.query(SELFCHECK_ITEMS_SQL)
      const scComm = await client.query(SELFCHECK_COMM_SQL)
      log(`SELFCHECK：service_items 剩余命中 ${scItem.rows[0].remaining} 行（应 0）；service_commissions 剩余有效 ${scComm.rows[0].remaining} 行 / ${scComm.rows[0].remaining_total} 元（应 0 / 0.00）`)

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
