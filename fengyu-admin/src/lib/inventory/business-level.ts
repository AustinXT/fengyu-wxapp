import { notFound } from 'next/navigation'
import type { InventoryDocType, InventoryLocationType } from '@/lib/inventory/types'
import type { AuthSession } from '@/lib/types'

export const INVENTORY_BUSINESS_LEVELS = ['supply-chain', 'market', 'store'] as const
export type InventoryBusinessLevel = (typeof INVENTORY_BUSINESS_LEVELS)[number]

const LEVEL_SCOPE_ACCESS: Record<InventoryBusinessLevel, readonly AuthSession['roles'][number]['scopeType'][]> = {
  'supply-chain': ['总部'],
  market: ['总部', '市场'],
  store: ['总部', '市场', '门店'],
}

export function canAccessInventoryBusinessLevel(session: AuthSession, level: InventoryBusinessLevel): boolean {
  return session.roles.some((role) => LEVEL_SCOPE_ACCESS[level].includes(role.scopeType))
}

export function requireInventoryBusinessLevel(
  session: AuthSession | null,
  level: InventoryBusinessLevel,
): asserts session is AuthSession {
  if (!session || !canAccessInventoryBusinessLevel(session, level)) notFound()
}

export function inventoryBusinessPath(level: InventoryBusinessLevel): string {
  return `/inventory/operations/${level}`
}

export function inventoryBusinessLocationType(level: InventoryBusinessLevel): InventoryLocationType {
  return level === 'supply-chain' ? '总部' : level === 'market' ? '市场' : '门店'
}

const GENERIC_DOC_BUSINESS_LEVEL: Partial<Record<InventoryDocType, InventoryBusinessLevel>> = {
  内部领用: 'supply-chain',
  市场间调货出库: 'market',
  市场产品报损: 'market',
  市场产品盘溢: 'market',
  市场库存盘点: 'market',
  分院调货出库: 'store',
  院顾客产品出库: 'store',
  院顾客退货: 'store',
  院产品报损: 'store',
  分院库存盘点: 'store',
}

export function genericDocBusinessLevel(docType: InventoryDocType): InventoryBusinessLevel | null {
  return GENERIC_DOC_BUSINESS_LEVEL[docType] ?? null
}

export function getDefaultInventoryBusinessLevel(session: AuthSession): InventoryBusinessLevel {
  if (canAccessInventoryBusinessLevel(session, 'supply-chain')) return 'supply-chain'
  if (canAccessInventoryBusinessLevel(session, 'market')) return 'market'
  return 'store'
}
