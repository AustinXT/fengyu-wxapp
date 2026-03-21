import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrgNode } from "@/lib/types"

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

/** 构建组织节点的完整路径（跳过 headquarters 根节点），用 "/" 拼接 */
export function buildOrgPath(nodeId: string | null, orgNodes: OrgNode[]): string {
  if (!nodeId || orgNodes.length === 0) return ""
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  const names: string[] = []
  let current = map.get(nodeId)
  for (let i = 0; i < 5 && current; i++) {
    if (i === 0 || current.type !== "headquarters") {
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
    if (current.type === "market") return current.id
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return null
}
