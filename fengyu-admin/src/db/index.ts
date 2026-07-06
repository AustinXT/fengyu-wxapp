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

/**
 * 解析 PG `timestamp without time zone` (OID 1114) 字面为北京时刻的 Date。
 *
 * 库存北京墙钟字面（PG server timezone=Asia/Shanghai，实测 prod 5433 已是 Shanghai）。显式拼 '+08:00'
 * 构造 Date，与进程 TZ / 容器 TZ 完全解耦——postgres.js 内置 parse `x => new Date(x)` 会按**进程本地 TZ**
 * 解释无时区字面，容器 TZ 一旦漂移（ops/001）即把北京墙钟当 UTC → epoch 晚 8h → 前端 +8 → T+8。
 *
 * 仅覆盖 1114：date(1082) 由 lib/datetime.fmtDate 走字面截断；timestamptz(1184) 字面带偏移，
 * 内置 new Date() 已正确（db/schema/user.ts 3 个 withTimezone 列不受影响）。
 *
 * 与 staffApi/clientApi/payNotify 的 setTypeParser(1114,'+08:00') 对等（fix/003）。
 * 导出供 tests/timestamp-reader-tz-probe.ts 跨 TZ 守护；下方 types.beijingTimestamp 引用同一函数。
 *
 * 注：曾误以为 postgres.js 的 `types` option 无法覆盖内置 Date handler，实测源码 mergeUserTypes
 * 用 Object.assign 让用户 parser 覆盖内置同 OID（postgres/src/types.js:193）。
 */
export function parseTimestamp1114(val: string | null): Date | null {
  return val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')
}

const client = globalForDb.pgClient ??
  postgres(connectionString, {
    max: 5,
    types: {
      beijingTimestamp: {
        // to/serialize 仅满足 postgres.js 的 PostgresType 类型约束；运行时只命中 parse（读 1114）。
        // serialize 与内置 date handler 等价——且 admin 写入已走 nowTs()/beijingTs()，不直接传 Date
        // 进 timestamp 列，serialize 路径实际不被触发。
        to: 1184,
        from: [1114],
        serialize: (x: Date | string | number) =>
          (x instanceof Date ? x : new Date(x)).toISOString(),
        parse: parseTimestamp1114,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client
}

export const db = drizzle(client)
