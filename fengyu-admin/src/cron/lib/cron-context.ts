/**
 * CronContext — cron STEP 时间注入上下文
 *
 * 生产路径：runDailyJobs() 不传 ctx → 全部 helper 退化为 PG 原生 NOW()/CURRENT_DATE/JS new Date()。
 * 测试路径：runDailyJobs() 读取 env CRON_REFERENCE_DATE 解析为 Date 注入；
 *           STEP SQL 中所有 NOW()/CURRENT_DATE 字面量通过 helper 替换为绑定参数化时间戳。
 *
 * 设计约束：
 *   - 不影响业务逻辑，仅做时间源切换
 *   - SQL helper 返回 drizzle sql 片段（可直接嵌入 sql`...`）
 *   - JS helper 与 SQL helper 用同一 ctx 保证 JS dateStamp 与 PG 时间一致
 *   - referenceDate 锚点为 Asia/Shanghai 03:00（cron 实际触发时刻）
 */

import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

export interface CronContext {
  /** undefined → 生产路径用 NOW()/CURRENT_DATE；定义 → 测试用注入时刻 */
  referenceDate?: Date
}

/**
 * 返回 SQL date 片段。
 *   ctx.referenceDate 为 undefined → sql.raw('CURRENT_DATE')（生产路径，保留字面量以兼容单元测试形态断言）
 *   定义 → sql`('YYYY-MM-DD'::date)`
 */
export function dateSqlOf(ctx?: CronContext): SQL {
  if (!ctx?.referenceDate) return sql.raw('CURRENT_DATE')
  const dateStr = formatDateStamp(ctx.referenceDate)
  return sql`(${dateStr}::date)`
}

/**
 * 返回 SQL timestamptz 片段。
 *   ctx.referenceDate 为 undefined → sql.raw('NOW()')（生产路径，保留字面量）
 *   定义 → sql`('ISO timestamptz'::timestamptz)`
 */
export function nowSqlOf(ctx?: CronContext): SQL {
  if (!ctx?.referenceDate) return sql.raw('NOW()')
  const iso = ctx.referenceDate.toISOString()
  return sql`(${iso}::timestamptz)`
}

/**
 * JS 时刻获取（用于函数体内 new Date()）。
 */
export function nowOf(ctx?: CronContext): Date {
  return ctx?.referenceDate ?? new Date()
}

/**
 * JS 'YYYY-MM-DD' 日期戳（用于 operation_logs.target_id 等）。
 * 使用 referenceDate 的 Asia/Shanghai 日历日期（与 PG CURRENT_DATE 在 Asia/Shanghai 时区一致）。
 */
export function dateStampOf(ctx?: CronContext): string {
  return formatDateStamp(nowOf(ctx))
}

/**
 * 内部 helper：Date → 'YYYY-MM-DD'（Asia/Shanghai 时区）。
 * 为避免 toISOString() 在 UTC 时区滚日，显式按 +08:00 偏移格式化。
 */
function formatDateStamp(d: Date): string {
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000
  const shanghai = new Date(shanghaiMs)
  return shanghai.toISOString().slice(0, 10)
}
