/**
 * admin 写入 `timestamp without time zone` 列的时区根治 helper。
 *
 * 背景（follow-up #2，根因详见 docs/changes/fix/003 与 ops/001）：
 *   admin 经 postgres.js 写 `new Date()` → `toISOString()` 发 UTC 字面 → PG `timestamp without tz`
 *   按 server timezone（Asia/Shanghai）当墙钟字面落库，结果比真实北京时刻**早 8h**。
 *   而 clientApi / staffApi 读取侧（setTypeParser 1114 +08:00）假设库存北京墙钟字面 → 读出来 +8h 偏移。
 *
 * postgres.js 的 `types:` option **可以**覆盖内置 Date handler（`postgres/src/types.js:193` 的
 * mergeUserTypes 用 Object.assign 让用户 parser 覆盖内置同 OID）——admin **读取侧**根治见
 * `src/db/index.ts` 的 `types.beijingTimestamp`（1114 按 +08:00 解析，与云函数 setTypeParser(1114) 对等）。
 * 本文件只负责**写入侧**的"北京字面"根治：
 *   - "当前时刻"写入一律走 `nowTs()`（PG `NOW()`，server TZ=Shanghai 落北京字面，与进程 TZ 解耦）。
 *   - "计算型时刻"（如 `expireAt = now + validDays`、`new Date(locked.paid_at)`）不能直接 `NOW()`，
 *     用 `beijingTs(d)` 把 JS Date 格式化成北京墙钟字面再 `::timestamp`。
 *
 * 选取哪个：
 *   - 凡是"现在"语义的，用 `nowTs()`（推荐，不依赖进程 TZ）。
 *   - 凡是 Date 已经过算术 / 来自外部入参的，用 `beijingTs(d)`。
 *
 * 不改 schema 列类型（不改 timestamp→timestamptz）；仅修正写入字面。
 */
import { sql } from 'drizzle-orm'
import { fmtDateTime } from './datetime'

/**
 * 当前时刻的 SQL 表达式：`NOW()`。
 * PG 容器 server_timezone=Asia/Shanghai（migration 0028），`NOW()` 返回的 timestamp without tz
 * 字面恒为北京墙钟，与 admin 进程 TZ 是否生效无关。用于 timestamp 列的"当前时刻"写入。
 *
 * 用法：`.values({ paidAt: nowTs() })` / `.set({ confirmedAt: nowTs() })` /
 *      raw `sql\`... paid_at = ${nowTs()} ...\``。
 */
export function nowTs() {
  return sql`NOW()`
}

/**
 * 把任意 JS Date 包装成北京墙钟字面的 timestamp SQL 表达式：`'<YYYY-MM-DD HH:mm:ss>'::timestamp`。
 *
 * 用于**计算型**时间写入——Date 已经经过算术（`setDate(+validDays)`）或来自入参/锁定行，
 * 不能用 `NOW()`。格式化走 `lib/datetime.fmtDateTime`（Intl 固定 Asia/Shanghai，进程 TZ 无关）。
 *
 * 用法：`.values({ expireAt: beijingTs(expireDate) })` /
 *      `beijingTs(new Date(filters.dateFrom))` 用于报表筛选边界（与 sale_order_datetime 北京字面同语义）。
 */
export function beijingTs(d: Date) {
  const wallClock = fmtDateTime(d) // 'YYYY-MM-DD HH:mm:ss' Asia/Shanghai，与进程 TZ 解耦
  return sql`${wallClock}::timestamp`
}
