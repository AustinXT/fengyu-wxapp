import { describe, expect, it, vi } from 'vitest'

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ notFound: notFoundMock }))

import type { AuthSession } from './types'
import {
  hasUiCapability,
  sanitizePermissionMatrix,
  sanitizeRoleDefinitionActions,
  validatePermissionMatrix,
} from './permission-contract'
import { requireUiPageCapability } from './page-capability'

const knownActions = [
  'coupon:list', 'coupon:create',
  'employee:list', 'employee:create',
  'sale_order:list', 'sale_order:delete',
  'store:lakala_config', 'inventory:update',
]

function matrix(overrides: Partial<Record<'admin' | 'manager', string[]>> = {}) {
  return {
    admin: [],
    manager: [],
    finance: [],
    hr: [],
    product: [],
    customer_mgr: [],
    staff: [],
    ...overrides,
  }
}

function session(actions: string[]): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '测试用户',
    phone: '13800138000',
    roles: [],
    permissions: { actions, scopeStoreIds: [] },
  }
}

describe('permission-contract', () => {
  it('拒绝未知 action，并一次返回缺失页面依赖', () => {
    const result = validatePermissionMatrix(matrix({
      manager: ['coupon:create', 'unknown:action'],
    }), knownActions)

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing_ui_dependency', action: 'coupon:create', missing: ['coupon:list'] }),
      expect.objectContaining({ kind: 'unknown_action', action: 'unknown:action' }),
    ]))
  })

  it('非 admin 不可授予物理删除、收款配置与未交付库存能力', () => {
    const result = validatePermissionMatrix(matrix({
      manager: ['sale_order:delete', 'store:lakala_config', 'inventory:update'],
    }), knownActions)

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'not_grantable', action: 'sale_order:delete', grantability: 'admin_only' }),
      expect.objectContaining({ kind: 'not_grantable', action: 'store:lakala_config', grantability: 'admin_only' }),
      expect.objectContaining({ kind: 'not_grantable', action: 'inventory:update', grantability: 'undelivered' }),
    ]))
  })

  it('读取历史矩阵时清洗未知、不可授予和未交付能力', () => {
    const result = sanitizePermissionMatrix(matrix({
      admin: ['coupon:list', 'unknown:action', 'inventory:update'],
      manager: ['coupon:list', 'sale_order:delete', 'store:lakala_config'],
    }), knownActions)

    expect(result.admin).toEqual(['coupon:list'])
    expect(result.manager).toEqual(['coupon:list'])
  })

  it('读取角色定义时按高级能力清洗遗留权限', () => {
    const legacy = [
      'coupon:list',
      'sale_order:delete',
      'store:lakala_config',
      'inventory:update',
      'lakala:onboarding:create',
    ]

    expect(sanitizeRoleDefinitionActions(legacy, false, knownActions)).toEqual(['coupon:list'])
    expect(sanitizeRoleDefinitionActions(legacy, true, knownActions)).toEqual([
      'coupon:list',
      'sale_order:delete',
      'store:lakala_config',
    ])
  })

  it('UI capability 必须同时满足 action 与页面硬依赖', () => {
    expect(hasUiCapability(['employee:create'], 'employee:create')).toBe(false)
    expect(hasUiCapability(
      ['employee:list', 'employee:create', 'org:list', 'store:list'],
      'employee:create',
    )).toBe(true)
  })

  it('SSR 直达页对无能力用户统一 notFound，并支持任一可达 action', () => {
    expect(() => requireUiPageCapability(session(['coupon:list']), 'coupon:create')).toThrow('NEXT_NOT_FOUND')
    expect(() => requireUiPageCapability(session(['coupon:list']), ['coupon:create', 'coupon:list'])).not.toThrow()
  })
})
