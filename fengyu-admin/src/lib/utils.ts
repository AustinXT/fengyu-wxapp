import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  return `¥${num.toFixed(2)}`
}

export function formatPhone(phone: string): string {
  if (!phone || phone.length !== 11) return phone
  return `${phone.slice(0, 3)}****${phone.slice(7)}`
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

/**
 * 计算给定订单金额下，优惠券的实际抵扣金额。
 * - 现金券/项目券：min(discountValue, totalAmount)
 * - 折扣券：totalAmount × (1 - discountValue)，可选 maxDiscount 封顶
 */
export function calcCouponDiscount(
  couponType: string,
  discountValue: string,
  maxDiscount: string | null,
  totalAmount: number,
): number {
  const dv = parseFloat(discountValue)
  if (couponType === '折扣券') {
    const saved = totalAmount * (1 - dv)
    return maxDiscount ? Math.min(saved, parseFloat(maxDiscount)) : saved
  }
  return Math.min(dv, totalAmount)
}
