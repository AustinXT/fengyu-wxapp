import { describe, expect, it, vi } from 'vitest'

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ notFound: notFoundMock }))

import type { AuthSession } from './types'
import {
  addActionWithUiDependencies,
  getMissingUiDependencies,
  hasAllUiCapabilities,
  hasUiCapability,
  removeActionWithDependents,
  sanitizePermissionMatrix,
  sanitizeRoleDefinitionActions,
  validatePermissionMatrix,
} from './permission-contract'
import { requireAllUiPageCapabilities, requireUiPageCapability } from './page-capability'

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

  it('非 admin 不可授予物理删除和收款配置；已交付库存能力按依赖校验', () => {
    const result = validatePermissionMatrix(matrix({
      manager: ['sale_order:delete', 'store:lakala_config', 'inventory:update'],
    }), knownActions)

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'not_grantable', action: 'sale_order:delete', grantability: 'admin_only' }),
      expect.objectContaining({ kind: 'not_grantable', action: 'store:lakala_config', grantability: 'admin_only' }),
      expect.objectContaining({ kind: 'missing_ui_dependency', action: 'inventory:update', missing: ['inventory:stock_list'] }),
    ]))
  })

  it('读取历史矩阵时清洗未知和不可授予能力，保留已交付库存能力', () => {
    const result = sanitizePermissionMatrix(matrix({
      admin: ['coupon:list', 'unknown:action', 'inventory:update'],
      manager: ['coupon:list', 'sale_order:delete', 'store:lakala_config'],
    }), knownActions)

    expect(result.admin).toEqual(['coupon:list', 'inventory:update'])
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

    expect(sanitizeRoleDefinitionActions(legacy, false, knownActions)).toEqual(['coupon:list', 'inventory:update'])
    expect(sanitizeRoleDefinitionActions(legacy, true, knownActions)).toEqual([
      'coupon:list',
      'inventory:update',
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

  it('勾选库存特殊权限会递归补齐接口依赖，取消前置权限会撤销依赖项', () => {
    const granted = addActionWithUiDependencies([], 'inventory:market_sku_manage')
    expect(granted).toEqual(expect.arrayContaining([
      'inventory:market_sku_manage', 'inventory:market_price_view',
      'inventory:list', 'inventory:stock_list',
    ]))
    expect(getMissingUiDependencies(granted, 'inventory:market_sku_manage')).toEqual([])
    expect(hasAllUiCapabilities(granted, ['inventory:market_sku_manage', 'inventory:market_price_view'])).toBe(true)
    const removed = removeActionWithDependents(granted, 'inventory:stock_list')
    expect(removed).toEqual(expect.arrayContaining(['inventory:list']))
    expect(removed).not.toEqual(expect.arrayContaining([
      'inventory:market_sku_manage', 'inventory:market_price_view', 'inventory:stock_list',
    ]))
  })

  it('SSR 直达页对无能力用户统一 notFound，并支持任一可达 action', () => {
    expect(() => requireUiPageCapability(session(['coupon:list']), 'coupon:create')).toThrow('NEXT_NOT_FOUND')
    expect(() => requireUiPageCapability(session(['coupon:list']), ['coupon:create', 'coupon:list'])).not.toThrow()
  })

  it('多个 SSR 接口是 AND 关系，缺任一项都不渲染页面', () => {
    expect(() => requireAllUiPageCapabilities(session(['inventory:list']), ['inventory:list', 'inventory:stock_list'])).toThrow('NEXT_NOT_FOUND')
    expect(() => requireAllUiPageCapabilities(session(['inventory:list', 'inventory:stock_list']), ['inventory:list', 'inventory:stock_list'])).not.toThrow()
  })
})
