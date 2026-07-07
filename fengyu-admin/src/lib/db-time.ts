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
 *   - 凡是 Date 已经过算术 / 来自外部入参的，用 `beijingTs(d)`。
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
  const wallClock = fmtDateTime(d) // 'YYYY-MM-DD HH:mm:ss' Asia/Shanghai 墙钟
  return sql`${wallClock}::timestamp AT TIME ZONE 'Asia/Shanghai'`
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
