import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrgNode } from "@/lib/types"
import { fmtDate, fmtDateTime } from "@/lib/datetime"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number | string | null | undefined): string {
  
  
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (num == null || Number.isNaN(num)) return '¥0.00'
  return `¥${num.toFixed(2)}`
}


export function formatPhone(phone: string): string {
  if (!phone || phone.length !== 11) return phone
  return `${phone.slice(0, 3)}****${phone.slice(7)}`
}


export function formatDate(date: string | Date | null | undefined): string {
  return fmtDate(date)
}


export function formatDateTime(date: string | Date | null | undefined): string {
  return fmtDateTime(date)
}


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
