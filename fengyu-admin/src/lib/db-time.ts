/**
 * admin 写入 timestamp 列的时区根治 helper（migration 0076 起 timestamp → timestamptz/1184）。
 *
 * 背景：timestamp 列已统一为 `timestamp with time zone`（1184，存绝对时刻）。读取侧（drizzle ORM
 * select）由 PG 发 +08 偏移字面 + postgres.js 内置 parser 正确解析（见 src/db/index.ts 注释）。
 * 本文件只负责**写入侧**把 JS Date 落成正确的绝对时刻：
 *   - "当前时刻"用 `nowTs()`（PG `NOW()`，返回 timestamptz，TZ 无关）。
 *   - "计算型时刻"用 `beijingTs(d)`（Date → 北京墙钟 + `::timestamp AT TIME ZONE 'Asia/Shanghai'`
 *     显式当北京转 timestamptz，与 server/session TZ 解耦）。
 *
 * 选取哪个：
 *   - 凡是"现在"语义的，用 `nowTs()`（推荐，不依赖任何 TZ）。
 *   - 需要**亚秒精度**的绝对时刻（水位列、`>=` / `<` 阈值比较），用 `instantTs(d)` ——
 *     `beijingTs` 截断到秒，当阈值用会把窗口放宽最多 999ms，当水位写会在同秒内倒退（#253）。
 *   - 其余「Date 已经过算术 / 来自外部入参」且是墙钟语义的（到期日、按日归属的锚点），
 *     用 `beijingTs(d)`。
 *
 * 历史（已修）：曾因 1114（timestamp without tz）+ drizzle `+0000` reader 致 T+8，靠 nowTs/beijingTs
 * 写北京墙钟 + 读取侧 setTypeParser(1114) 补偿。0076 改 1184 后读写语义统一，补偿链拆除。
 */
import { sql } from 'drizzle-orm'
import { fmtDateTime } from './datetime'

/**
 * 当前时刻的 SQL 表达式：`NOW()`。PG `NOW()` 返回 timestamptz（绝对时刻），与 server timezone 无关。
 * 用于 timestamp 列的"当前时刻"写入。
 *
 * 用法：`.values({ paidAt: nowTs() })` / `.set({ confirmedAt: nowTs() })` /
 *      raw `sql\`... paid_at = ${nowTs()} ...\``。
 */
export function nowTs() {
  return sql`NOW()`
}

/**
 * 把任意 JS Date 包装成"北京墙钟 → timestamptz"的 SQL 表达式：
 * `'<YYYY-MM-DD HH:mm:ss>'::timestamp AT TIME ZONE 'Asia/Shanghai'`。
 *
 * 用于**计算型**时间写入——Date 已经过算术（`setDate(+validDays)`）或来自入参/锁定行，不能用 `NOW()`。
 * 格式化走 `lib/datetime.fmtDateTime`（Intl 固定 Asia/Shanghai，进程 TZ 无关），再 `AT TIME ZONE`
 * 显式当北京转 timestamptz，与 server/session TZ 解耦（比裸 `::timestamptz` 严：后者对无偏移字面
 * 仍按 session TZ 解释）。
 *
 * 用法：`.values({ expireAt: beijingTs(expireDate) })` /
 *      报表筛选边界 `beijingTs(new Date(filters.dateFrom))`（与 sale_order_datetime 同语义）。
 */
export function beijingTs(d: Date) {
  // fmtDateTime 是**展示**用 helper，对 Invalid Date 返回 ''（UI 里留白是对的）。
  // 但拼进 SQL 会变成 `''::timestamp` → 运行时 22007，错误信息离现场很远。这里提前 fail-fast。
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new TypeError(`beijingTs 需要有效的 Date，收到：${String(d)}`)
  }
  const wallClock = fmtDateTime(d) // 'YYYY-MM-DD HH:mm:ss' Asia/Shanghai 墙钟
  return sql`${wallClock}::timestamp AT TIME ZONE 'Asia/Shanghai'`
}

/**
 * **绝对时刻**（保留毫秒）：`'<ISO8601 带 Z>'::timestamptz`。
 *
 * 与 `beijingTs` 的分工：
 *   - `beijingTs(d)` 走 `fmtDateTime` 落北京墙钟字面，**截断到秒**。适合"这一天/这个钟点"
 *     这类墙钟语义（到期日、报表边界、按日归属的锚点）。
 *   - `instantTs(d)` 直接绑 `toISOString()`（带 `Z`，PG 无歧义解析），**毫秒不丢**。适合
 *     拿来做 `>=` / `<` **阈值比较**的时刻 —— 秒级截断会把比较窗口放宽最多 999ms，
 *     落在金额口径上就是真金白银（见 `actions/refunds.ts` 的会员跌档超额扣除阈值）。
 *
 * 列自 migration 0076 起是 timestamptz(1184)，ISO+Z 与列语义直接对齐，无需 `AT TIME ZONE`。
 */
export function instantTs(d: Date) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new TypeError(`instantTs 需要有效的 Date，收到：${String(d)}`)
  }
  return sql`${d.toISOString()}::timestamptz`
}

/**
 * 报表/列表筛选的日期边界：date input 串 'YYYY-MM-DD' + 时分秒 → 北京 timestamptz。
 *
 * 列表筛选 dateFrom/dateTo（或 startDate/endDate）来自 `<input type="date">`，是裸日期串；ES 规范按
 * UTC 午夜解析 `new Date(串)` 会早 8h（postgres.js 发 UTC ISO → PG 当墙钟落库）。直接拼北京时分秒墙钟，
 * 再 `::timestamp AT TIME ZONE 'Asia/Shanghai'` 显式当北京转 timestamptz，与业务时间列（1184）同语义。
 *
 * 集中收敛此处，避免每个列表 action 各自内联同一 idiom 时漏写 `AT TIME ZONE`——裸 `::timestamp` 赋予 1184
 * 列会按 session TZ 解释，session 非 Shanghai 即偏移。用法：
 *   `gte(col, beijingBoundaryTs(filters.dateFrom, '00:00:00'))` /
 *   `lt(col, beijingBoundaryTs(filters.dateTo, '23:59:59'))`。
 */
export function beijingBoundaryTs(dateStr: string, time: '00:00:00' | '23:59:59') {
  return sql`${`${dateStr} ${time}`}::timestamp AT TIME ZONE 'Asia/Shanghai'`
}

/**
 * 日期筛选结束边界的次日零点，供半开区间 `[from, nextDay(to))` 使用。
 *
 * 不能使用 `< 当日 23:59:59`：timestamptz 保留微秒，该写法会漏掉结束日
 * `23:59:59.000000` 及之后的最后一秒数据。日期加法留在 PG 内完成，避免 JS 时区漂移。
 */
export function beijingNextDayBoundaryTs(dateStr: string) {
  return sql`(${dateStr}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'`
}
