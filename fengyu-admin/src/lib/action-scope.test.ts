import { describe, expect, it } from 'vitest'
import type { AuthSession } from './types'
import { scopeSessionToActions, scopeSessionToAllActions } from './action-scope'

/**
 * 说明.md §9.3 负向矩阵：一次操作所需的多个权限必须来自同一个角色绑定，
 * 禁止把不同 scope 的权限拼接后越权操作。
 */

type RoleBinding = AuthSession['roles'][number]

function makeSession(roles: RoleBinding[]): AuthSession {
  return {
    employeeId: 'E-SCOPE',
    name: '测试员工',
    phone: '13800000000',
    roles,
    permissions: {
      actions: Array.from(new Set(roles.flatMap((role) => role.actions ?? []))),
      scopeStoreIds: Array.from(new Set(roles.flatMap((role) => role.scopeStoreIds ?? []))),
      scopeOrgNodeIds: Array.from(new Set(roles.flatMap((role) => role.scopeOrgNodeIds ?? []))),
    },
  }
}

describe('scopeSessionToAllActions — §9.3 多权限必须同一角色绑定', () => {
  it('跨绑定拼接（各持一半权限）时 roles 清空且 scope 归零，禁止并集越权', () => {
    const session = makeSession([
      {
        role: 'inventory_market_finance', scopeId: 'MKT-A', scopeType: '市场',
        actions: ['inventory:create_doc'],
        scopeStoreIds: ['STORE-A1'], scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
      },
      {
        role: 'inventory_market_finance', scopeId: 'MKT-B', scopeType: '市场',
        actions: ['inventory:self_purchase_receive'],
        scopeStoreIds: ['STORE-B1'], scopeOrgNodeIds: ['MKT-B', 'NODE-B1'],
      },
    ])

    const scoped = scopeSessionToAllActions(session, [
      'inventory:create_doc',
      'inventory:self_purchase_receive',
    ])

    expect(scoped.roles).toEqual([])
    expect(scoped.permissions.scopeStoreIds).toEqual([])
    expect(scoped.permissions.scopeOrgNodeIds).toEqual([])
  })

  it('同一绑定齐备全部动作时仅保留该绑定 scope，不并入其它绑定', () => {
    const session = makeSession([
      {
        role: 'inventory_market_finance', scopeId: 'MKT-A', scopeType: '市场',
        actions: ['inventory:create_doc', 'inventory:self_purchase_receive'],
        scopeStoreIds: ['STORE-A1'], scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
      },
      {
        role: 'inventory_market_finance', scopeId: 'MKT-B', scopeType: '市场',
        actions: ['inventory:create_doc'],
        scopeStoreIds: ['STORE-B1'], scopeOrgNodeIds: ['MKT-B', 'NODE-B1'],
      },
    ])

    const scoped = scopeSessionToAllActions(session, [
      'inventory:create_doc',
      'inventory:self_purchase_receive',
    ])

    expect(scoped.roles.map((role) => role.scopeId)).toEqual(['MKT-A'])
    expect(scoped.permissions.scopeStoreIds).toEqual(['STORE-A1'])
    expect(scoped.permissions.scopeOrgNodeIds).toEqual(['MKT-A', 'NODE-A1'])
  })

  it('兼容路径：角色缺少 scope 元数据的旧会话原样返回（登录会话始终带元数据）', () => {
    const session = makeSession([
      { role: 'admin', scopeId: 'HQ', scopeType: '总部' },
    ])

    const scoped = scopeSessionToAllActions(session, ['inventory:create_doc'])

    expect(scoped).toBe(session)
  })
})

describe('scopeSessionToActions — 单动作 scope 与角色绑定', () => {
  it('未授予该动作的绑定不贡献 scope（价格档位绑定不放大数据范围）', () => {
    const session = makeSession([
      {
        role: 'inventory_market_finance', scopeId: 'MKT-A', scopeType: '市场',
        actions: ['inventory:list'],
        scopeStoreIds: ['STORE-A1'], scopeOrgNodeIds: ['MKT-A', 'NODE-A1'],
      },
      {
        role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
        actions: ['inventory:supply_chain_price_view'],
        scopeStoreIds: ['STORE-A1', 'STORE-B1'], scopeOrgNodeIds: ['HQ', 'MKT-A', 'MKT-B'],
      },
    ])

    const scoped = scopeSessionToActions(session, ['inventory:list'])

    expect(scoped.roles.map((role) => role.scopeId)).toEqual(['MKT-A'])
    expect(scoped.permissions.scopeStoreIds).toEqual(['STORE-A1'])
    expect(scoped.permissions.scopeOrgNodeIds).toEqual(['MKT-A', 'NODE-A1'])
  })
})
