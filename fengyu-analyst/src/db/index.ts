import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

const globalForDb = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined
}

const connectionString =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://fengyu:fengyu123@localhost:5432/fengyu"

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

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = client
}

export const db = drizzle(client)

// postgres.js 懒建连：运行时启动探测先触发 ParameterStatus，构建阶段不调用。
export async function initializeDatabase(): Promise<void> {
  await client`SELECT 1`
}
