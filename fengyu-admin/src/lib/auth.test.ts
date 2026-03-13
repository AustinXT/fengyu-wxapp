import { describe, it, expect } from 'vitest'
import { hasPermission, hasRole, getRoleLabel, MOCK_SESSION } from './auth'
import type { AuthSession, RoleType } from './types'

// 构造不同角色的 session 工厂
function makeSession(roles: Array<{ role: RoleType; scopeId: string; scopeType: 'headquarters' | 'market' | 'store' }>, actions: string[] = []): AuthSession {
  return {
    employeeId: 'test-001',
    name: '测试用户',
    phone: '13800000000',
    roles,
    permissions: { actions, scopeStoreIds: [] },
  }
}

describe('hasPermission', () => {
  it('拥有权限返回 true', () => {
    const session = makeSession([], ['org:list', 'org:create'])
    expect(hasPermission(session, 'org:list')).toBe(true)
    expect(hasPermission(session, 'org:create')).toBe(true)
  })

  it('无权限返回 false', () => {
    const session = makeSession([], ['org:list'])
    expect(hasPermission(session, 'org:delete')).toBe(false)
  })

  it('空 actions 列表返回 false', () => {
    const session = makeSession([], [])
    expect(hasPermission(session, 'org:list')).toBe(false)
  })

  it('MOCK_SESSION 拥有 admin 全部权限', () => {
    expect(hasPermission(MOCK_SESSION, 'org:list')).toBe(true)
    expect(hasPermission(MOCK_SESSION, 'permission:assign_admin')).toBe(true)
    expect(hasPermission(MOCK_SESSION, 'sync:trigger')).toBe(true)
  })
})

describe('hasRole', () => {
  it('拥有角色返回 true', () => {
    const session = makeSession([
      { role: 'admin', scopeId: 'hq', scopeType: 'headquarters' },
    ])
    expect(hasRole(session, 'admin')).toBe(true)
  })

  it('不拥有角色返回 false', () => {
    const session = makeSession([
      { role: 'manager', scopeId: 'store-1', scopeType: 'store' },
    ])
    expect(hasRole(session, 'admin')).toBe(false)
    expect(hasRole(session, 'finance')).toBe(false)
  })

  it('多角色场景', () => {
    const session = makeSession([
      { role: 'admin', scopeId: 'hq', scopeType: 'headquarters' },
      { role: 'manager', scopeId: 'store-1', scopeType: 'store' },
    ])
    expect(hasRole(session, 'admin')).toBe(true)
    expect(hasRole(session, 'manager')).toBe(true)
    expect(hasRole(session, 'hr')).toBe(false)
  })

  it('空角色列表返回 false', () => {
    const session = makeSession([])
    expect(hasRole(session, 'admin')).toBe(false)
  })
})

describe('getRoleLabel', () => {
  it.each([
    ['admin', '超级管理员'],
    ['manager', '店长'],
    ['finance', '财务'],
    ['hr', '人事'],
    ['product', '商品管理员'],
    ['customer_mgr', '顾客管理员'],
    ['staff', '员工'],
  ] as const)('角色 %s → %s', (role, label) => {
    expect(getRoleLabel(role)).toBe(label)
  })

  it('未知角色返回原值', () => {
    expect(getRoleLabel('unknown' as RoleType)).toBe('unknown')
  })
})
