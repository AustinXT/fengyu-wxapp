#!/usr/bin/env bun
/**
 * admin timestamp reader 端到端守护（migration 0076 后，timestamp → timestamptz/1184）。
 *
 * 背景：0076 前 admin 读 1114 列经 drizzle column reader `new Date(value + "+0000")` 硬当 UTC，
 * 导致 T+8。0076 改 1184 后，PG 发带 +08 偏移字面，postgres.js 内置 parser → drizzle reader
 * `new Date(value)` 正确解析。vitest 单测 mock 不连真库，挡不住 schema 漏改 / drizzle 升级改 reader /
 * PG 偏移异常。本 smoke 连真库 ORM select 真实 1184 列，验证 drizzle reader 返回的 Date 与 PG 字面一致，
 * 并前置断言 server TimeZone=Asia/Shanghai（migration 0028）——整套 withTimezone 方案（裸串 ::timestamptz
 * / 1114→1184 存量重解释 / beijingTs 写入）全压在此 TZ 上，一旦失效全线偏移。
 *
 * 运行：cd fengyu-admin && bun tests/e2e-actions/smoke-timestamp-reader.mjs
 * 默认 fengyu_wxapp@5433；可用 PG_CONNECTION_STRING / DATABASE_URL 覆盖（空库自动 skip）。
 */
import { sql } from 'drizzle-orm'

// 在 import admin db 前注入 DATABASE_URL（src/db/index.ts 模块顶层即读此变量初始化 client）。
process.env.DATABASE_URL =
  process.env.PG_CONNECTION_STRING ||
  process.env.DATABASE_URL ||
  'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'

const { db } = await import('../../src/db')
const { saleOrders } = await import('../../../db/schema/order')

let exitCode = 1

async function main() {
  const errors = []

  // ③ 前置不变量：server TimeZone 须为 Asia/Shanghai（migration 0028 锁定）。
  const tzRows = await db.execute(sql`SHOW TIME ZONE`)
  const tzRow = tzRows[0] || {}
  const tz = tzRow.timezone ?? tzRow.TimeZone ?? Object.values(tzRow)[0]
  if (tz !== 'Asia/Shanghai') {
    errors.push(`server TimeZone 须为 Asia/Shanghai（migration 0028），实际 "${tz}"——裸串 ::timestamptz 按此 TZ 解释，全线偏移风险`)
  }

  // ① ORM select 真实 1184 列：createdAt 走 drizzle reader（withTimezone → new Date(value)）。
  const rows = await db
    .select({ createdAt: saleOrders.createdAt })
    .from(saleOrders)
    .where(sql`created_at IS NOT NULL`)
    .orderBy(sql`created_at DESC`)
    .limit(1)
  const r = rows[0]
  if (!r) {
    console.log('  ⚠ sale_orders 无数据，跳过（空库）')
    exitCode = 0
    return
  }
  // ② 同行 PG 字面（DESC LIMIT 1 同行）：created_at::text 应带时区偏移（1184 特征）。
  const litRows = await db.execute(
    sql`SELECT created_at::text AS lit FROM sale_orders WHERE created_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  )
  const lit = litRows[0]?.lit

  if (!(r.createdAt instanceof Date)) {
    errors.push(`createdAt 应为 Date，实际 ${typeof r.createdAt}=${r.createdAt}`)
  }
  const litIso = lit ? new Date(lit).toISOString() : '(lit 缺失)'
  const ormIso = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)
  // lit 形如 '2026-07-07 22:26:43.663+08'；new Date(lit) 解析为绝对时刻，应 == drizzle reader。
  if (litIso !== ormIso) {
    errors.push(`drizzle reader 与 PG 字面不一致：lit→${litIso} vs orm→${ormIso}`)
  }
  if (lit && !/[+-]\d{2}:\d{2}$|[+-]\d{2}$/.test(lit)) {
    errors.push(`created_at 字面应带时区偏移（1184），实际 "${lit}"（疑似未迁移 0076）`)
  }
  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  exitCode = 0
  console.log(`  ✅ PASS — drizzle ${ormIso} == PG "${lit}"（1184 偏移正确）`)
}

try {
  console.log(`[smoke-timestamp-reader] start | ${new Date().toISOString()}`)
  console.log(`  DATABASE_URL=${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)
  await main()
} catch (e) {
  console.error('[smoke-timestamp-reader] EXCEPTION:', e?.stack || e)
} finally {
  try {
    await db.$client.end()
  } catch (e) {
    console.error('[smoke-timestamp-reader] end() error:', e.message)
  }
  console.log(`[smoke-timestamp-reader] end | exit=${exitCode}`)
  process.exit(exitCode)
}
