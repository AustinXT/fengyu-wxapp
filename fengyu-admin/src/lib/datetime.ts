/**
 * 东八区（Asia/Shanghai）日期工具入口。
 *
 * 注意：`new Date().toISOString().slice(0,10)` 永远按 UTC 取日期，
 * 北京时间凌晨 00:00–08:00 会回退到前一天。凡"取今天的日期"一律用本模块。
 *
 * `shanghaiToday` 复用 data-center 既有实现（Intl.DateTimeFormat），单一来源。
 */
export { shanghaiToday } from './data-center/time-range'
import { shanghaiToday } from './data-center/time-range'

/** 东八区 YYYYMMDD（8 位，订单号/流水号日期段用） */
export function shanghaiYmd(now: Date = new Date()): string {
  return shanghaiToday(now).replace(/-/g, '')
}

/**
 * Asia/Shanghai 固定时区格式化（不依赖运行环境 TZ）—— admin 所有时间展示的**单一来源**。
 * `lib/utils.ts` 的 `formatDate/formatDateTime` 与 `lib/export-xlsx.ts` 的 `fmtDate/fmtDateTime` 均转调此处。
 *
 * 入参通常是 Server Action `toISOString()` 出来的 UTC 串（migration 0076 起 timestamp 列为
 * `timestamp with time zone`，PG 发 +08 偏移字面，Drizzle 读成正确绝对时刻再 toISOString），
 * 故须按 Asia/Shanghai 还原显示；裸读 ISO 会差 8 小时，
 * 用浏览器本地时区方法（getHours 等）则在非北京浏览器下偏移——这里用 Intl 固定时区根治。
 */
const shanghaiParts = (() => {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  return (d: Date) => {
    const p: Record<string, string> = {}
    for (const { type, value } of fmt.formatToParts(d)) p[type] = value
    return p
  }
})()

/** 格式化为 Asia/Shanghai `YYYY-MM-DD HH:mm:ss`（默认带秒）。 */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = shanghaiParts(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/**
 * 格式化为 Asia/Shanghai `YYYY-MM-DD`。
 * 纯日期串（Drizzle `date` 列，无 `T`）直接截断不做时区转换；带 `T` 的 ISO datetime 串
 * （`timestamp` 列 toISOString）走 Asia/Shanghai 还原取北京日期，避免裸截 UTC 日期跨午夜偏一天。
 */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return ''
  if (typeof v === 'string' && !v.includes('T')) return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = shanghaiParts(d)
  return `${p.year}-${p.month}-${p.day}`
}
