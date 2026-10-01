import { describe, expect, it } from 'vitest'
import {
  flattenMenuItems,
  getMenuItemForPath,
  getVisibleMenuItems,
  hasMenuItemAccess,
  isMenuParent,
  MENU_CONFIG,
} from './menu'
import { DATA_CENTER_TABS } from './data-center/params'
import { DATA_CENTER_REPORT_LIST } from './data-center/reports'
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
    // hidden 入口（如骨架已就绪、内容未交付的经营明细报表）对谁都不显示
    expect(visibleLeaves(makeSession({ role: 'admin' }))).toHaveLength(flattenMenuItems().filter((item) => !item.hidden).length)
    expect(nodes.filter(isMenuParent).map((node) => node.label)).toEqual([
      '经营业务', '客户运营', '商品商城', '库存管理', '组织管理', '数据中心', '系统管理',
    ])
  })

  it('父级只在至少一个子项有权时出现', () => {
    const nodes = getVisibleMenuItems(makeSession({ role: 'product' }))
    expect(nodes.some((node) => isMenuParent(node) && node.label === '组织管理')).toBe(false)
    expect(nodes.some((node) => isMenuParent(node) && node.label === '商品商城')).toBe(true)
  })

  it('既有角色不再自动取得进销存入口', () => {
    expect(visibleLabels(makeSession({ role: 'manager' }))).toEqual(expect.arrayContaining([
      '开单', '订单管理', '顾客管理',
    ]))
    expect(visibleLabels(makeSession({ role: 'manager' }))).not.toContain('门店业务')
    expect(visibleLabels(makeSession({ role: 'finance' }))).toEqual(expect.arrayContaining([
      '订单管理', '营业额分配',
    ]))
    expect(visibleLabels(makeSession({ role: 'hr' }))).toEqual(expect.arrayContaining([
      '组织架构', '门店管理', '员工管理', '权限管理',
    ]))
    expect(visibleLabels(makeSession({ role: 'product' }))).toEqual(expect.arrayContaining([
      '商品管理', '商城管理',
    ]))
    expect(visibleLabels(makeSession({ role: 'customer_mgr' }))).toEqual(expect.arrayContaining([
      '顾客管理', '疗程卡管理',
    ]))
  })

  it('门店业务必须具备门店库存办理动作', () => {
    const item = flattenMenuItems().find((entry) => entry.href === '/inventory/operations/store')
    expect(item).toBeDefined()
    expect(hasMenuItemAccess(item!, ['inventory:list'], ['门店'])).toBe(false)
    expect(hasMenuItemAccess(item!, ['inventory:store_operate'], ['门店'])).toBe(true)
    expect(hasMenuItemAccess(item!, ['inventory:store_operate'], ['市场'])).toBe(false)
  })

  it('资料配置的历史深链沿用同一菜单项', () => {
    expect(getMenuItemForPath(MENU_CONFIG, '/inventory/suppliers')?.label).toBe('资料配置')
    expect(getMenuItemForPath(MENU_CONFIG, '/inventory/sku-mappings')?.href).toBe('/inventory/skus')
    expect(getMenuItemForPath(MENU_CONFIG, '/inventory/promotions')?.href).toBe('/inventory/skus')
  })

  it('库存业务按组织范围显示', () => {
    expect(visibleLabels(makeSession({ role: 'admin', scopeType: '总部' }))).toEqual(expect.arrayContaining([
      '供应链业务', '市场业务', '门店业务',
    ]))
    expect(visibleLabels(makeSession({ role: 'inventory_supply_chain_operator' as RoleType, scopeType: '总部' }))).toContain('供应链业务')
    expect(visibleLabels(makeSession({ role: 'inventory_market_finance' as RoleType, scopeType: '市场' }))).toContain('市场业务')
    expect(visibleLabels(makeSession({ role: 'inventory_store_operator' as RoleType, scopeType: '门店' }))).toContain('门店业务')
    expect(visibleLabels(makeSession({ role: 'inventory_market_finance' as RoleType, scopeType: '市场' }))).not.toContain('门店业务')
  })

  it('多角色菜单取并集', () => {
    const labels = visibleLabels(makeSession({ role: 'hr' }, { role: 'inventory_supply_chain_operator' as RoleType, scopeType: '总部' }))
    expect(labels).toEqual(expect.arrayContaining(['组织架构', '权限管理', '资料配置', '供应链业务']))
  })

  it('系统自检仅向持有专用权限的超级管理员展示', () => {
    expect(visibleLabels(makeSession({ role: 'admin' }))).toContain('系统自检')
    for (const role of ['manager', 'finance', 'hr', 'product', 'customer_mgr'] as RoleType[]) {
      expect(visibleLabels(makeSession({ role }))).not.toContain('系统自检')
    }
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

  // menu.ts 的 4 个 href 是纯字符串字面量，tsc 管不到；漏配只会表现为「侧边栏少一个入口」，
  // 没有任何别的测试会红（page-permission-coverage 的守护是 menu → gates 单向的，
  // menu 自己漏了它就遍历不到）。
  it('每个数据中心板块都有侧边栏入口', () => {
    const hrefs = new Set(leaves.map((item) => item.href))
    for (const board of DATA_CENTER_TABS) {
      expect(hrefs.has(`/data-center/${board}`), `板块 ${board} 缺侧边栏入口`).toBe(true)
    }
  })

  // 经营明细报表（#367）：入口来自 reports.ts 登记表，下钻子页不进菜单。
  it('每个经营明细报表（下钻子页除外）都有侧边栏入口，并挂在「数据中心」下的对应分段', () => {
    const dataCenter = MENU_CONFIG.find((node) => isMenuParent(node) && node.label === '数据中心')
    expect(dataCenter && isMenuParent(dataCenter)).toBe(true)
    const children = isMenuParent(dataCenter!) ? dataCenter.children : []
    for (const report of DATA_CENTER_REPORT_LIST) {
      const item = children.find((child) => child.href === report.path)
      if (report.parent) {
        expect(item, `下钻页 ${report.path} 不应进菜单`).toBeUndefined()
        continue
      }
      expect(item, `报表 ${report.path} 缺侧边栏入口`).toBeDefined()
      expect(item!.section).toBe(report.menu?.section)
      expect(item!.requiredAllActions).toEqual([...report.requiredActions])
    }
    // 同一分段的子项必须相邻，否则侧边栏会把同一个小标题渲染两次
    const sections = children.map((child) => child.section)
    const firstSeen = sections.filter((section, index) => section !== sections[index - 1])
    expect(new Set(firstSeen).size).toBe(firstSeen.length)
  })

  it('只有 dashboard 的账号看不到顾客明细 / 员工提成入口；有专用权限点的可见（入口打开后）', () => {
    const reportItems = flattenMenuItems().filter((item) => item.section && item.section !== '看板')
    const byHref = (href: string) => ({ ...reportItems.find((item) => item.href === href)!, hidden: false })
    const dashboardOnly = ['data_center:dashboard']
    expect(hasMenuItemAccess(byHref('/data-center/daily-overview'), dashboardOnly)).toBe(true)
    expect(hasMenuItemAccess(byHref('/data-center/operating-master'), dashboardOnly)).toBe(true)
    for (const href of ['/data-center/customer-frequency', '/data-center/remaining-cards']) {
      expect(hasMenuItemAccess(byHref(href), dashboardOnly), href).toBe(false)
      expect(hasMenuItemAccess(byHref(href), [...dashboardOnly, 'data_center:customer_detail']), href).toBe(true)
      // 缺 dashboard 只有专用权限点也不可见
      expect(hasMenuItemAccess(byHref(href), ['data_center:customer_detail']), href).toBe(false)
    }
    expect(hasMenuItemAccess(byHref('/data-center/commission-daily'), dashboardOnly)).toBe(false)
    expect(hasMenuItemAccess(byHref('/data-center/commission-daily'), [...dashboardOnly, 'data_center:staff_commission'])).toBe(true)
  })

  it('顾客频率表：dashboard 与 customer_detail 由两个角色各给一半 → 菜单不可见（与页面 / action 的同角色闸门一致）', () => {
    type Role = AuthSession['roles'][number]
    const role = (actions: string[], scopeId: string): Role => ({
      role: 'manager', scopeId, scopeType: '门店', actions, scopeStoreIds: [scopeId], scopeOrgNodeIds: [scopeId],
    })
    const asSession = (roles: Role[]): AuthSession => ({
      employeeId: 'EMP-1', name: '测试', phone: '', roles,
      permissions: { actions: [...new Set(roles.flatMap((r) => r.actions ?? []))], scopeStoreIds: roles.map((r) => r.scopeId) },
    })
    const labels = (session: AuthSession) =>
      getVisibleMenuItems(session).flatMap((node) => ('children' in node ? node.children : [node])).map((item) => item.label)

    const split = asSession([role(['data_center:dashboard'], 'S1'), role(['data_center:customer_detail'], 'S2')])
    expect(labels(split)).not.toContain('顾客频率表')
    // dashboard 类入口不受影响
    expect(labels(split)).toContain('销售')
    const same = asSession([role(['data_center:dashboard', 'data_center:customer_detail'], 'S1')])
    expect(labels(same)).toContain('顾客频率表')
  })

  it('提成明细高亮员工提成日报（前缀匹配），不误伤其它数据中心子项', () => {
    expect(getMenuItemForPath(MENU_CONFIG, '/data-center/commission-daily/detail')?.href).toBe('/data-center/commission-daily')
    expect(getMenuItemForPath(MENU_CONFIG, '/data-center/customer-frequency')?.href).toBe('/data-center/customer-frequency')
    expect(getMenuItemForPath(MENU_CONFIG, '/data-center/customer')?.href).toBe('/data-center/customer')
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
