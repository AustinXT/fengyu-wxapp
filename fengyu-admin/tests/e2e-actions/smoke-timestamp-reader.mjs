/**
 * PR #42 复审 finding #4 — admin types.beijingTimestamp 端到端守护 smoke（单文件）。
 *
 * 背景与动机
 * ==========
 * admin 的 db client（src/db/index.ts）通过 postgres.js `types` option 注册了
 * `beijingTimestamp`：from:[1114] / parse=parseTimestamp1114，把 PG `timestamp without time zone`
 * (OID 1114) 的北京墙钟字面按 +08:00 解析为 Date，与进程/容器 TZ 解耦（fix/003 对等）。
 *
 * 现有覆盖只有 vitest 单测（tests/ 直调 parseTimestamp1114），验证的是**纯函数**本身。
 * 它挡不住：
 *   - postgres.js `types` 契约变更（mergeUserTypes 行为漂移、Object.assign 覆盖语义改了）
 *   - 注册块被误删 / OID 写错（from:[1114] → from:[1184] 之类）
 *   - drizzle 升级后 session 走了不同取值路径，绕开 types 装配
 *
 * 本 smoke 连真 PG，走完整 wire → postgres.js type parser 链路：发一条同时含 1114 / 1184 / NULL
 * 的 SELECT，断言解析结果。任一环节失效（注册被删、parser 未挂、1184 被污染）立即失败。
 *
 * 运行
 * ===
 *   cd fengyu-admin && bun tests/e2e-actions/smoke-timestamp-reader.mjs
 *
 * 默认连库：postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu_e2e
 * 可用 PG_CONNECTION_STRING / DATABASE_URL 覆盖（本文件在 import admin db 前注入 DATABASE_URL）。
 *
 * 注：本 smoke 不调 Server Action、不需要 preload mock，故单文件；与 smoke-record-payment 的
 * wrapper+impl 双文件模式不同（后者要 mock next/cache + @/lib/auth）。db.execute 返回结构 /
 * 连接关闭方式均已查证（见行内注释），不靠猜。
 */
import { sql } from 'drizzle-orm'

// ① 先把 DATABASE_URL 注入进程，再 import admin db——src/db/index.ts 模块顶层即读此变量
//    初始化 postgres client，故必须在 import 之前就位。
//    （db/index.ts 优先读 E2E_DATABASE_URL，回落 DATABASE_URL；独立跑 smoke 时 E2E_ 通常未设，
//     DATABASE_URL 即生效。）
process.env.DATABASE_URL =
  process.env.PG_CONNECTION_STRING ||
  process.env.DATABASE_URL ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu_e2e'

// ② 动态 import admin db client（drizzle(postgres(connectionString, {types}))）。
//    相对 tests/e2e-actions/ 上溯两级到 fengyu-admin/，再进 src/db（目录 → index.ts）。
const { db } = await import('../../src/db')

const EXPECTED_1114_ISO = '2026-07-06T06:00:00.000Z' // '2026-07-06 14:00:00' 北京墙钟 → UTC
const EXPECTED_1184_ISO = '2026-07-06T06:00:00.000Z' // '...+08' 偏移 → UTC（验证 1184 未被污染）

let exitCode = 1

async function main() {
  // ③ 一条 SELECT 同时验证三件事：
  //    - ts_1114: timestamp without time zone（OID 1114）应走 parseTimestamp1114（+08:00 解释）
  //    - ts_1184: timestamptz（OID 1184）走 postgres.js 内置 Date parser，未被自定义 types 污染
  //    - ts_null: NULL 透传为 JS null（parseTimestamp1114 的 null 分支 + PG NULL 处理）
  //
  //    db.execute(sql`...`) 对 raw SQL 无 ORM field mapping → drizzle session 走
  //    `!fields && !customResultMapper` 分支（drizzle-orm/postgres-js/session.cjs:55-60），
  //    直接返回 postgres.js client.unsafe() 的 RowList（array-like，每元素是按列名取值的行对象，
  //    与 admin/src/actions/allocations.ts:79 `const [orderRow] = (await db.execute(sql\`...\`))` 同构）。
  //    故断言取 result[0] 的列属性即可。
  const result = await db.execute(sql`
    SELECT
      '2026-07-06 14:00:00'::timestamp       AS ts_1114,
      '2026-07-06 14:00:00+08'::timestamptz  AS ts_1184,
      NULL::timestamp                         AS ts_null
  `)
  const row = result[0]
  if (!row) {
    console.log('  ✗ FAIL: db.execute 返回 0 行，无法断言（result=' + JSON.stringify(result) + '）')
    return
  }
  const { ts_1114, ts_1184, ts_null } = row

  const errors = []
  // 核心：1114 走 parseTimestamp1114 —— 防注册块被删 / OID 写错 / types 契约漂移
  if (!(ts_1114 instanceof Date) || ts_1114.toISOString() !== EXPECTED_1114_ISO) {
    errors.push(
      `ts_1114 应为 Date(${EXPECTED_1114_ISO})，实际 ${typeof ts_1114}=${
        ts_1114 instanceof Date ? ts_1114.toISOString() : String(ts_1114)
      }`,
    )
  }
  // 1184 仍走内置，未被自定义 types 污染（from:[1114]、to:1114 → serialize 仅注册 serializers[1114]，不触碰 1184）
  if (!(ts_1184 instanceof Date) || ts_1184.toISOString() !== EXPECTED_1184_ISO) {
    errors.push(
      `ts_1184 应为 Date(${EXPECTED_1184_ISO})，实际 ${typeof ts_1184}=${
        ts_1184 instanceof Date ? ts_1184.toISOString() : String(ts_1184)
      }`,
    )
  }
  // NULL 透传
  if (ts_null !== null) {
    errors.push(`ts_null 应为 null，实际 ${typeof ts_null}=${String(ts_null)}`)
  }

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }

  exitCode = 0
  console.log(
    `  ✅ PASS — 1114→${ts_1114.toISOString()} | 1184→${ts_1184.toISOString()} | null→null`,
  )
}

try {
  console.log(`[smoke-timestamp-reader] start | ${new Date().toISOString()}`)
  // 日志脱敏：遮掉连接串里的密码
  const maskedUrl = process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')
  console.log(`  DATABASE_URL=${maskedUrl}`)
  await main()
} catch (e) {
  console.error('[smoke-timestamp-reader] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  // ④ 关闭连接池避免脚本挂起。
  //    drizzle 0.45 postgres-js 的 db 暴露 $client = 原生 postgres Sql 实例
  //    （drizzle-orm/postgres-js/driver.d.ts: drizzle() returns PostgresJsDatabase & { $client: TClient }），
  //    其 end() 返回 Promise，resolve 后所有底层连接已关闭（postgres/README.md:1239 `await sql.end()`）。
  //    src/db/index.ts 把 client 缓存在 globalThis（非 prod），end() 一样生效。
  //    仍兜底 process.exit 以防残留 timer/连接导致挂起。
  try {
    await db.$client.end()
  } catch (e) {
    console.error('[smoke-timestamp-reader] end() error:', e.message)
  }
  console.log(`[smoke-timestamp-reader] end | exit=${exitCode}`)
  process.exit(exitCode)
}
