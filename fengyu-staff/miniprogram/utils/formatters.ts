


export const STATUS_CLASS: Record<string, string> = {
  '待支付': 'pending',
  '待确认收款': 'pending',
  '已支付': 'success',
  '已完成': 'done',
  '支付失败': 'error',
  '已关闭': 'done',
  '待审批': 'pending',
}

export const ORDER_TYPE_LABEL: Record<string, string> = {
  销售单: '销售单',
  内部单: '内部单',
  转换单: '转换单',
  充值单: '充值卡',
  寄存单: '寄存单',
}


export function safeParseDate(v: any): Date | null {
  if (!v) return null
  const d = new Date(typeof v === 'string' ? (v.includes('T') ? v : v.replace(/-/g, '/')) : v)
  return isNaN(d.getTime()) ? null : d
}


export function formatDateTime(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}


export function formatDateTimeShort(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}


export function formatDate(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}


export function formatTime(timeStr: string | null): string {
  if (!timeStr) return ''
  return timeStr.slice(11, 16) || timeStr
}


export function getElapsedTime(startTime: string | null, now?: Date): string {
  const start = safeParseDate(startTime)
  if (!start) return ''
  const current = now || new Date()
  const diffMin = Math.floor((current.getTime() - start.getTime()) / 60000)
  if (diffMin < 60) return `进行中 ${diffMin}分钟`
  const h = Math.floor(diffMin / 60)
  const min = diffMin % 60
  return `进行中 ${h}小时${min > 0 ? min + '分钟' : ''}`
}
