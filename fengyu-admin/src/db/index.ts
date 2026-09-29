import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const globalForDb = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined
}

// E2E_DATABASE_URL 优先：e2e 测试跑在独立库（fengyu_e2e），与 dev 业务库隔离，
// 根除多会话/worktree 共享同一 PG 互相清库的干扰（2026-06-08）。开发时不设该变量，回落到 DATABASE_URL。
//
// ⚠️ 末尾这个写死的回落值**仅供本地开发与 `next build` 期求值**（build 机器没有 DB 变量，
// 这里直接退出会打断构建），**不是**部署配置：生产/预发部署必须显式注入 DATABASE_URL。
// 与 `db/scripts/` 的 fail-closed 范式（缺变量即退出）不同是有意为之，别照搬过去。
// 迁移数据库时这个字面量也要跟着改——它是 dev 库地址，不是"默认库"（见 db/CLAUDE.md）。
const connectionString =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'

// timestamp 列自 migration 0076 起统一为 `timestamp with time zone`（OID 1184）。
// PG 会话由下方 connection 显式设为 Asia/Shanghai，并在 ParameterStatus 中断言，返回 +08 字面量。
// postgres.js 内置 `new Date(value)` 正确解析为绝对时刻，drizzle column reader 直通，无需自定义 parser。
//
// 历史：PR #42 曾在此注册 types.beijingTimestamp（1114 按 +08:00 解析），但对 drizzle 完全无效——
// drizzle `construct()`（drizzle-orm/postgres-js/driver.cjs）把 1114/1184 等时间 OID 的 parser
// 强制覆盖为 transparent `(val)=>val`，且 1114 column reader 硬编码 `new Date(value + "+0000")`
// 当 UTC，是 admin T+8 的根因。根治在 schema 层（0076 改 1184），非此 client 层。
const client = globalForDb.pgClient ?? postgres(connectionString, {
  max: 5,
  connection: { TimeZone: 'Asia/Shanghai' },
  // URL 的 ?TimeZone= 会覆盖 connection；以服务器实际 ParameterStatus 为准，禁止带错时区运行。
  // postgres.js 会捕获回调异常并仅拒绝当前查询；配置错误必须终止整个进程。
  onparameter(key, value) {
    if (key === 'TimeZone' && value !== 'Asia/Shanghai') {
      console.error(new Error(`PG_TIMEZONE_MISMATCH: expected Asia/Shanghai, received ${value}`))
      process.exit(1)
    }
  },
})

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client
}

export const db = drizzle(client)

// postgres.js 懒建连：运行时启动探测先触发 ParameterStatus，构建阶段不调用。
export async function initializeDatabase(): Promise<void> {
  await client`SELECT 1`
}
