import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrgNode } from "@/lib/types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number | string | null | undefined): string {
  // 历史 WorkFine 拉取的订单/明细金额字段可能为 NULL；空串/非数值同样兜底，
  // 避免 num.toFixed() 在渲染期抛错导致整页白屏（React #419）。
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (num == null || Number.isNaN(num)) return '¥0.00'
  return `¥${num.toFixed(2)}`
}

/**
 * @deprecated 仅对 11 位手机号脱敏，其他长度返回明文。新代码请用
 * `import { formatPhoneSafe } from '@/lib/format'`（基于 pii.maskPhone，全长度统一脱敏）。
 */
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
 * - 现金券/品项券：min(discountValue, totalAmount)
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

/** 构建组织节点的完整路径（跳过 headquarters 根节点），用 "/" 拼接 */
export function buildOrgPath(nodeId: string | null, orgNodes: OrgNode[]): string {
  if (!nodeId || orgNodes.length === 0) return ""
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  const names: string[] = []
  let current = map.get(nodeId)
  for (let i = 0; i < 5 && current; i++) {
    if (i === 0 || current.type !== "总部") {
      names.unshift(current.name)
    }
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return names.join("/")
}

/** 查找组织节点所属的市场节点 ID（向上遍历 parentId 链） */
export function findAncestorMarketId(nodeId: string | null, orgNodes: OrgNode[]): string | null {
  if (!nodeId || orgNodes.length === 0) return null
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  let current = map.get(nodeId)
  for (let i = 0; i < 5 && current; i++) {
    if (current.type === "市场") return current.id
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return null
}
