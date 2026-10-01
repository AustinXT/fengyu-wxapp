import { describe, expect, it } from 'vitest'
import type { AuthSession } from './types'
import { canAdjustFrozenAllocation, canSaveAllocation, isAllocationFrozen } from './allocation-freeze'

const DAY = 86400000
const NOW = Date.parse('2026-09-30T00:00:00.000Z')

function session(roles: AuthSession['roles']): AuthSession {
  return {
    employeeId: 'test', name: 'test', phone: '', roles,
    permissions: {
      actions: ['allocation:list', 'allocation:save', 'employee:list', 'sale_order:list', 'service:list', 'store:list'],
      scopeStoreIds: ['A', 'B'],
    },
  }
}

const role = (name: AuthSession['roles'][number]['role'], stores: string[], actions = ['allocation:save']): AuthSession['roles'][number] => ({
  role: name, scopeId: name, scopeType: '门店', actions,
  scopeStoreIds: stores, scopeOrgNodeIds: stores,
})

describe('分配冻结边界', () => {
  it('严格超过 72 小时才冻结；空锚点与无效锚点保持放行', () => {
    expect(isAllocationFrozen(new Date(NOW - 3 * DAY), NOW)).toBe(false)
    expect(isAllocationFrozen(new Date(NOW - 3 * DAY - 1), NOW)).toBe(true)
    expect(isAllocationFrozen(null, NOW)).toBe(false)
    expect(isAllocationFrozen('invalid', NOW)).toBe(false)
  })

  it('店长冻结后无权；财务只在本角色授权的门店可调整，不能借店长范围扩权', () => {
    expect(canAdjustFrozenAllocation(session([role('manager', ['A'])]), 'A')).toBe(false)
    const mixed = session([role('manager', ['A']), role('finance', ['B'])])
    expect(canAdjustFrozenAllocation(mixed, 'A')).toBe(false)
    expect(canAdjustFrozenAllocation(mixed, 'B')).toBe(true)
    expect(canAdjustFrozenAllocation(session([role('finance', ['B'], ['allocation:list'])]), 'B')).toBe(false)
  })

  it('系统管理员与拥有超级管理员能力的自定义角色可调整', () => {
    expect(canAdjustFrozenAllocation(session([role('admin', [])]), 'A')).toBe(true)
    expect(canAdjustFrozenAllocation(session([{ ...role('manager', []), isSuperAdmin: true }]), 'A')).toBe(true)
    expect(canAdjustFrozenAllocation(session([{ ...role('admin', ['A']), isSuperAdmin: false }]), 'A')).toBe(false)
  })

  it('后台按钮与写入规则一致：店长仅冻结前可编辑，财务冻结后只可编辑自身门店', () => {
    expect(canSaveAllocation(session([role('manager', ['A'])]), 'A', false)).toBe(true)
    expect(canSaveAllocation(session([role('manager', ['A'])]), 'A', true)).toBe(false)
    const mixed = session([role('manager', ['A']), role('finance', ['B'])])
    expect(canSaveAllocation(mixed, 'A', true)).toBe(false)
    expect(canSaveAllocation(mixed, 'B', true)).toBe(true)
    expect(canSaveAllocation(mixed, 'C', false)).toBe(false)
    expect(canSaveAllocation(session([role('finance', ['B'], ['allocation:list'])]), 'B', false)).toBe(false)
  })
})
