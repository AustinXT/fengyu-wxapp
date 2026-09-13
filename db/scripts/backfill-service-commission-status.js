#!/usr/bin/env node

/**
 * backfill-service-commission-status.js — 一次性回填存量已完成服务单的
 * service_orders.commission_status（admin 代确认 CAS 漏 IS NULL 遗留的 NULL）。
 *
 * 背景：
 *   service_orders.commission_status 无 DB default，三端 INSERT 都不写 → 建单初值是 NULL。
 *   staff/client 的 finalizeServiceOrder 把 commission_status='已分配' 捆绑在状态翻转
 *   UPDATE（CAS 落在 status='待客户确认'）里，所以一定写得进；而 admin 的
 *   lib/service-commission-settle.ts 用独立 UPDATE + CAS `AND commission_status='待分配'`，
 *   与真实初值 NULL 不匹配 → 永远 0 行，服务单完成后 commission_status 留 NULL。
 *
 *   后果（NULL 既不是「待分配」也不是「已分配」）：
 *     - staff 营业额分配列表标签渲染成 "null"，两个状态筛选下都查不到该单；
 *     - staff serviceCommission.save 抛「INVALID_STATE: 服务单提成状态异常」，店长无法调整提成；
 *     - admin 服务提成导出的「待分配」段与「已分配」段双双漏掉这些单。
 *   admin CAS 与 staff 侧容错已修（2026-09-04），本脚本修正存量历史数据。
 *
 * 选行口径：
 *   status = '已完成' AND commission_status IS NULL
 *
 * 回填规则（与三端 finalize 结果对齐）：
 *   - 该单存在非 void 的 service_commissions → '已分配'（提成实际已写入，仅状态没落）
 *   - 否则 → '待分配'（等店长/后台分配）
 *
 * 安全性：
 *   - 只动 commission_status IS NULL 的行；已是「待分配/已分配」的不受影响（幂等）。
 *   - commission_status 仅是分配流程状态标记，不改动 service_commissions 金额、
 *     不影响次数扣减 / 营业额分配 / 订单金额。
 *   - 不触碰 status != '已完成' 的单（未完成单保持 NULL 是正常初值）。
 *
 * 用法：
 *   # dry-run（默认，仅打印统计 + 样本）
 *   DATABASE_URL="postgresql://<user>:<pwd>@<host>:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-service-commission-status.js
 *
 *   # 实际提交
 *   DATABASE_URL="postgresql://<user>:<pwd>@<host>:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-service-commission-status.js --apply
 *
 * 顺序：先 test/dev 库 --apply 验证；再 prod(118.178.196.26:5433) --apply。
 * 永远显式传 DATABASE_URL。各库同名同端口，仅靠 IP 区分，执行前核对连接串 IP。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-SVC-COMMISSION-STATUS] ${new Date().toISOString()} ${msg}`)
}

// 目标行口径：已完成但状态列为 NULL
const TARGET_ROWS = `
  so.status = '已完成'
  AND so.commission_status IS NULL
`

// 该服务单是否已有非 void 提成记录（= finalize 的提成写入其实成功了）
const HAS_COMMISSION = `
  EXISTS (
    SELECT 1
    FROM service_items sit
    JOIN service_commissions sc ON sc.service_item_id = sit.service_item_id
    WHERE sit.service_order_id = so.service_order_id
      AND sc.is_void = false
  )
`

const PREVIEW_SQL = `
SELECT
  COUNT(*)::int AS null_orders,
  COUNT(*) FILTER (WHERE ${HAS_COMMISSION})::int AS to_allocated,
  COUNT(*) FILTER (WHERE NOT (${HAS_COMMISSION}))::int AS to_pending,
  MIN(so.completed_at) AS first_completed_at,
  MAX(so.completed_at) AS last_completed_at
FROM service_orders so
WHERE ${TARGET_ROWS}
`

const SAMPLE_SQL = `
SELECT so.service_order_id,
       so.store_id,
       so.completed_at,
       (${HAS_COMMISSION}) AS has_commission
FROM service_orders so
WHERE ${TARGET_ROWS}
ORDER BY so.completed_at DESC NULLS LAST
LIMIT 20
`

const UPDATE_SQL = `
UPDATE service_orders so
SET commission_status = CASE
      WHEN ${HAS_COMMISSION} THEN '已分配'::allocation_status
      ELSE '待分配'::allocation_status
    END,
    updated_at = NOW()
WHERE ${TARGET_ROWS}
RETURNING so.service_order_id, so.commission_status
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
    log(`已完成且 commission_status IS NULL：${p.null_orders} 单（→已分配 ${p.to_allocated} / →待分配 ${p.to_pending}）`)
    log(`完成时间区间：${p.first_completed_at || 'N/A'} ~ ${p.last_completed_at || 'N/A'}`)

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（最近 20 单：service_order_id | store_id | completed_at | has_commission）:')
      for (const r of sample.rows) {
        log(`  ${r.service_order_id} | ${r.store_id} | ${r.completed_at ? r.completed_at.toISOString() : 'NULL'} | ${r.has_commission}`)
      }
    }

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      const toAllocated = upd.rows.filter((r) => r.commission_status === '已分配').length
      const toPending = upd.rows.filter((r) => r.commission_status === '待分配').length
      log(`APPLY：更新 ${upd.rowCount} 单 commission_status（→已分配 ${toAllocated} / →待分配 ${toPending}）`)

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
