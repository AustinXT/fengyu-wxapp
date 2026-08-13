import { describe, expect, it } from 'vitest'
import {
  flattenMenuItems,
  getMenuItemForPath,
  getVisibleMenuItems,
  hasMenuItemAccess,
  isMenuParent,
  MENU_CONFIG,
} from './menu'
import { DEFAULT_PERMISSION_MATRIX } from './permissions'
import type { AuthSession, RoleType } from './types'

function makeSession(...roles: Array<{ role: RoleType; scopeType?: '总部' | '市场' | '门店' }>): AuthSession {
  const actions = [...new Set(roles.flatMap((item) => DEFAULT_PERMISSION_MATRIX[item.role] ?? []))]
  return {
    employeeId: 'test',
    name: '测试',
    phone: '13800000000',
    roles: roles.map((item) => ({
      role: item.role,
      scopeId: 'test-scope',
      scopeType: item.scopeType ?? (item.role === 'admin' ? '总部' : '门店'),
    })),
    permissions: { actions, scopeStoreIds: [] },
  }
}

function visibleLeaves(session: AuthSession) {
  return flattenMenuItems(getVisibleMenuItems(session))
}

function visibleLabels(session: AuthSession) {
  return visibleLeaves(session).map((item) => item.label)
}

describe('业务域菜单（权限点驱动）', () => {
  it('admin 可见全部叶子菜单和全部业务域', () => {
    const nodes = getVisibleMenuItems(makeSession({ role: 'admin' }))
    expect(visibleLeaves(makeSession({ role: 'admin' }))).toHaveLength(flattenMenuItems().length)
    expect(nodes.filter(isMenuParent).map((node) => node.label)).toEqual([
      '经营业务', '客户运营', '商品商城', '进销存', '组织商户', '系统管理',
    ])
  })

  it('父级只在至少一个子项有权时出现', () => {
    const nodes = getVisibleMenuItems(makeSession({ role: 'product' }))
    expect(nodes.some((node) => isMenuParent(node) && node.label === '组织商户')).toBe(false)
    expect(nodes.some((node) => isMenuParent(node) && node.label === '商品商城')).toBe(true)
  })

  it('各角色仍取得既有可访问页面', () => {
    expect(visibleLabels(makeSession({ role: 'manager' }))).toEqual(expect.arrayContaining([
      '开单', '订单管理', '顾客管理', '门店业务', '单据中心',
    ]))
    expect(visibleLabels(makeSession({ role: 'finance' }))).toEqual(expect.arrayContaining([
      '订单管理', '营业额分配', '库存查询', '门店业务', '单据中心',
    ]))
    expect(visibleLabels(makeSession({ role: 'hr' }))).toEqual(expect.arrayContaining([
      '组织架构', '门店管理', '员工管理', '权限管理',
    ]))
    expect(visibleLabels(makeSession({ role: 'product' }))).toEqual(expect.arrayContaining([
      '商品管理', '商城管理', '资料配置',
    ]))
    expect(visibleLabels(makeSession({ role: 'customer_mgr' }))).toEqual(expect.arrayContaining([
      '顾客管理', '疗程卡管理', '库存查询',
    ]))
  })

  it('库存业务与单据中心需要同时具备两项读取权限', () => {
    const item = flattenMenuItems().find((entry) => entry.href === '/inventory/operations/store')
    expect(item).toBeDefined()
    expect(hasMenuItemAccess(item!, ['inventory:list'])).toBe(false)
    expect(hasMenuItemAccess(item!, ['inventory:stock_list'])).toBe(false)
    expect(hasMenuItemAccess(item!, ['inventory:list', 'inventory:stock_list'])).toBe(true)
  })

  it('资料配置的历史深链沿用同一菜单项', () => {
    const visible = getVisibleMenuItems(makeSession({ role: 'product' }))
    expect(getMenuItemForPath(visible, '/inventory/suppliers')?.label).toBe('资料配置')
    expect(getMenuItemForPath(visible, '/inventory/sku-mappings')?.href).toBe('/inventory/skus')
    expect(getMenuItemForPath(visible, '/inventory/promotions')?.href).toBe('/inventory/skus')
    expect(getMenuItemForPath(visible, '/inventory/procurement/PROC-1')?.href).toBe('/inventory/operations/store')
  })

  it('库存业务按组织范围显示', () => {
    expect(visibleLabels(makeSession({ role: 'admin', scopeType: '总部' }))).toEqual(expect.arrayContaining([
      '供应链业务', '市场业务', '门店业务',
    ]))
    expect(visibleLabels(makeSession({ role: 'manager', scopeType: '市场' }))).toEqual(expect.arrayContaining([
      '市场业务', '门店业务',
    ]))
    expect(visibleLabels(makeSession({ role: 'manager', scopeType: '门店' }))).not.toContain('市场业务')
  })

  it('多角色菜单取并集', () => {
    const labels = visibleLabels(makeSession({ role: 'hr' }, { role: 'product' }))
    expect(labels).toEqual(expect.arrayContaining(['组织架构', '商品管理', '权限管理', '资料配置']))
  })

  it('staff 和空权限均没有菜单', () => {
    expect(visibleLabels(makeSession({ role: 'staff' as RoleType }))).toEqual([])
    const empty = makeSession()
    expect(visibleLabels({ ...empty, permissions: { actions: [], scopeStoreIds: [] } })).toEqual([])
  })
})

describe('MENU_CONFIG 完整性', () => {
  const leaves = flattenMenuItems()

  it('叶子菜单的 URL、图标和权限门槛完整', () => {
    for (const item of leaves) {
      expect(item.href.startsWith('/')).toBe(true)
      expect(item.icon).toBeDefined()
      expect(item.requiredActions.length).toBeGreaterThan(0)
    }
  })

  it('每个业务域均有子页', () => {
    for (const node of MENU_CONFIG.filter(isMenuParent)) {
      expect(node.children.length, `${node.label} 缺少二级菜单`).toBeGreaterThan(0)
    }
  })

  it('所有菜单权限均来自权限目录', () => {
    const all = new Set(DEFAULT_PERMISSION_MATRIX.admin)
    for (const item of leaves) {
      for (const action of [...item.requiredActions, ...(item.requiredAllActions ?? [])]) {
        expect(all.has(action), `菜单「${item.label}」门槛 ${action} 不在 ALL_ACTIONS`).toBe(true)
      }
    }
  })
})
