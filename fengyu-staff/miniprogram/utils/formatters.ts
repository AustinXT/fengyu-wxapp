// utils/formatters.ts — 通用格式化工具

// '待确认收款' 不再是 DB enum，仅 order-qrcode 用作"线下已选、待确认"的 UI-only 计算标签
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

/**
 * iOS-safe 日期解析：ISO 串（含 T）原样传入，dash-space 串（YYYY-MM-DD HH:mm:ss）
 * 先把 '-' 换成 '/' 再解析（iOS 微信 new Date('YYYY-MM-DD HH:mm:ss') 会失败）。
 * 解析失败返回 null，避免 NaN 透传到 UI。
 */
export function safeParseDate(v: any): Date | null {
  if (!v) return null
  const d = new Date(typeof v === 'string' ? (v.includes('T') ? v : v.replace(/-/g, '/')) : v)
  return isNaN(d.getTime()) ? null : d
}

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss（默认带秒）
 */
export function formatDateTime(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm（不含秒，用于明确不需要秒的展示位置）
 */
export function formatDateTimeShort(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 格式化为 YYYY-MM-DD（仅日期，不含时间）
 * 用于 pg date 列（如 service_date / 优惠券过期日）展示，避免裸绑定 UTC 串偏移日期
 */
export function formatDate(v: any): string {
  if (!v) return ''
  const d = safeParseDate(v)
  if (!d) return String(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
  const start = safeParseDate(startTime)
  if (!start) return ''
  const current = now || new Date()
  const diffMin = Math.floor((current.getTime() - start.getTime()) / 60000)
  if (diffMin < 60) return `进行中 ${diffMin}分钟`
  const h = Math.floor(diffMin / 60)
  const min = diffMin % 60
  return `进行中 ${h}小时${min > 0 ? min + '分钟' : ''}`
}

/** 优惠券折扣展示：折扣券→"8折"，现金券/品项券→"¥10"（镜像 client utils/format.ts） */
export function formatDiscount(coupon: { couponType: string; discountValue: number | string }): string {
  if (coupon.couponType === '折扣券') {
    return `${Math.round(Number(coupon.discountValue) * 10)}折`
  }
  return `¥${Number(coupon.discountValue).toFixed(0)}`
}
