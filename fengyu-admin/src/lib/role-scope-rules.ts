import type { RoleType } from './types'

export type OrgNodeType = '总部' | '市场' | '门店' | '部门'

export const ROLE_SCOPE_TYPES: Record<RoleType, OrgNodeType[]> = {
  admin: ['总部'],
  hr: ['总部', '市场', '门店'],
  product: ['总部', '市场', '门店'],
  finance: ['总部', '市场', '门店'],
  customer_mgr: ['总部', '市场', '门店'],
  manager: ['总部', '市场', '门店'],
  staff: ['门店'],
}

export function isScopeTypeValidForRole(role: RoleType, scopeType: OrgNodeType): boolean {
  const allowed = ROLE_SCOPE_TYPES[role]
  return !!allowed && allowed.includes(scopeType)
}
