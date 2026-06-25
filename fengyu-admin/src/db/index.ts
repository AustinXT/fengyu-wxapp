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

const client = globalForDb.pgClient ?? postgres(connectionString, { max: 5 })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client
}

export const db = drizzle(client)
