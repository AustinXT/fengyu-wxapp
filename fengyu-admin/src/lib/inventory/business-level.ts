import { notFound } from 'next/navigation'
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

export function getDefaultInventoryBusinessLevel(session: AuthSession): InventoryBusinessLevel {
  if (canAccessInventoryBusinessLevel(session, 'supply-chain')) return 'supply-chain'
  if (canAccessInventoryBusinessLevel(session, 'market')) return 'market'
  return 'store'
}
