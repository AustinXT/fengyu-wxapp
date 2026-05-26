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
