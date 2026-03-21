// utils/formatters.ts — 通用格式化工具

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
  普通: '普通单',
  福利活动: '福利活动',
  体验: '体验单',
  内部: '内部单',
  回款: '回款单',
  转换: '转换单',
  退款: '退款单',
}

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss
 */
export function formatDateTime(v: any): string {
  if (!v) return ''
  const d = new Date(typeof v === 'string' ? (v.includes('T') ? v : v.replace(/-/g, '/')) : v)
  if (isNaN(d.getTime())) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 截取时间字符串的时分部分 (HH:mm)
 */
export function formatTime(timeStr: string | null): string {
  if (!timeStr) return ''
  return timeStr.slice(11, 16) || timeStr
}

/**
 * 计算服务进行中的耗时描述
 * @param startTime 开始时间字符串
 * @param now 可选，覆盖"当前时间"（测试用）
 */
export function getElapsedTime(startTime: string | null, now?: Date): string {
  if (!startTime) return ''
  const start = new Date(startTime.replace(/-/g, '/'))
  const current = now || new Date()
  const diffMin = Math.floor((current.getTime() - start.getTime()) / 60000)
  if (diffMin < 60) return `进行中 ${diffMin}分钟`
  const h = Math.floor(diffMin / 60)
  const min = diffMin % 60
  return `进行中 ${h}小时${min > 0 ? min + '分钟' : ''}`
}
