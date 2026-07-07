import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const globalForDb = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined
}

// E2E_DATABASE_URL 优先：e2e 测试跑在独立库（fengyu_e2e），与开发/staff 测试共用的 fengyu 库隔离，
// 根除多会话/worktree 共享同一 PG 互相清库的干扰（2026-06-08）。开发时不设该变量，回落到 DATABASE_URL。
const connectionString =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'

// timestamp 列自 migration 0076 起统一为 `timestamp with time zone`（OID 1184）。PG 在 server
// timezone=Asia/Shanghai（migration 0028 锁定）下发送带 +08 偏移字面，postgres.js 内置 date parser
// `new Date(value)` 正确解析为绝对时刻，drizzle column reader 直通——无需任何自定义 type parser。
//
// 历史：PR #42 曾在此注册 types.beijingTimestamp（1114 按 +08:00 解析），但对 drizzle 完全无效——
// drizzle `construct()`（drizzle-orm/postgres-js/driver.cjs）把 1114/1184 等时间 OID 的 parser
// 强制覆盖为 transparent `(val)=>val`，且 1114 column reader 硬编码 `new Date(value + "+0000")`
// 当 UTC，是 admin T+8 的根因。根治在 schema 层（0076 改 1184），非此 client 层。
const client = globalForDb.pgClient ?? postgres(connectionString, { max: 5 })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client
}

export const db = drizzle(client)
