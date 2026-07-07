
export { shanghaiToday } from './data-center/time-range'
import { shanghaiToday } from './data-center/time-range'


export function shanghaiYmd(now: Date = new Date()): string {
  return shanghaiToday(now).replace(/-/g, '')
}


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


export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = shanghaiParts(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}


export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return ''
  if (typeof v === 'string' && !v.includes('T')) return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = shanghaiParts(d)
  return `${p.year}-${p.month}-${p.day}`
}
