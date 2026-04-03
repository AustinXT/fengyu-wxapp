import { describe, it, expect } from 'vitest'
import { getVisibleMenuGroups, MENU_CONFIG } from './menu'
import type { AuthSession, RoleType } from './types'

function makeSession(...roles: Array<{ role: RoleType; scopeType?: 'headquarters' | 'market' | 'store' }>): AuthSession {
  return {
    employeeId: 'test',
    name: '测试',
    phone: '13800000000',
    roles: roles.map(r => ({
      role: r.role,
      scopeId: 'test-scope',
      scopeType: r.scopeType ?? 'store',
    })),
    permissions: { actions: [], scopeStoreIds: [] },
  }
}

function getMenuLabels(session: AuthSession): string[] {
  return getVisibleMenuGroups(session).flatMap(g => g.items.map(i => i.label))
}

describe('getVisibleMenuGroups', () => {
  it('admin 看到全部数据管理 + 系统管理菜单', () => {
    const labels = getMenuLabels(makeSession({ role: 'admin' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('组织架构')
    expect(labels).toContain('门店管理')
    expect(labels).toContain('员工管理')
    expect(labels).toContain('商品管理')
    expect(labels).toContain('提成矩阵')
    expect(labels).toContain('优惠券管理')
    expect(labels).toContain('权限管理')
    expect(labels).toContain('操作日志')
    expect(labels).toContain('系统配置')
  })

  it('admin 看不到业务操作菜单', () => {
    const labels = getMenuLabels(makeSession({ role: 'admin' }))
    expect(labels).not.toContain('开单')
    expect(labels).not.toContain('服务单管理')
    expect(labels).not.toContain('预约管理')
    expect(labels).not.toContain('顾客管理')
  })

  it('manager 看到业务管理 + 顾客管理 + 数据中心', () => {
    const labels = getMenuLabels(makeSession({ role: 'manager' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('开单')
    expect(labels).toContain('订单管理')
    expect(labels).toContain('营业额分配')
    expect(labels).toContain('服务单管理')
    expect(labels).toContain('预约管理')
    expect(labels).toContain('顾客管理')
    expect(labels).toContain('经营数据')
  })

  it('manager 看不到系统管理', () => {
    const labels = getMenuLabels(makeSession({ role: 'manager' }))
    expect(labels).not.toContain('权限管理')
    expect(labels).not.toContain('操作日志')
    expect(labels).not.toContain('系统配置')
  })

  it('finance 以只读角色看到订单/分配/顾客/数据中心', () => {
    const labels = getMenuLabels(makeSession({ role: 'finance' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('订单管理')
    expect(labels).toContain('营业额分配')
    expect(labels).toContain('顾客管理')
    expect(labels).toContain('经营数据')
  })

  it('finance 看不到开单/服务单/预约', () => {
    const labels = getMenuLabels(makeSession({ role: 'finance' }))
    expect(labels).not.toContain('开单')
    expect(labels).not.toContain('服务单管理')
    expect(labels).not.toContain('预约管理')
  })

  it('hr 看到组织/门店/员工/权限', () => {
    const labels = getMenuLabels(makeSession({ role: 'hr' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('组织架构')
    expect(labels).toContain('门店管理')
    expect(labels).toContain('员工管理')
    expect(labels).toContain('权限管理')
  })

  it('hr 看不到商品/提成/业务操作', () => {
    const labels = getMenuLabels(makeSession({ role: 'hr' }))
    expect(labels).not.toContain('商品管理')
    expect(labels).not.toContain('提成矩阵')
    expect(labels).not.toContain('开单')
    expect(labels).not.toContain('订单管理')
  })

  it('product 看到商品和优惠券', () => {
    const labels = getMenuLabels(makeSession({ role: 'product' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('商品管理')
    expect(labels).toContain('优惠券管理')
  })

  it('product 看不到其他模块', () => {
    const labels = getMenuLabels(makeSession({ role: 'product' }))
    expect(labels).not.toContain('员工管理')
    expect(labels).not.toContain('订单管理')
    expect(labels).not.toContain('权限管理')
  })

  it('customer_mgr 仅看到顾客管理', () => {
    const labels = getMenuLabels(makeSession({ role: 'customer_mgr' }))
    expect(labels).toContain('工作台')
    expect(labels).toContain('顾客管理')
    expect(labels).toHaveLength(2)
  })

  it('多角色合并菜单（admin + manager）', () => {
    const labels = getMenuLabels(makeSession({ role: 'admin' }, { role: 'manager' }))
    // 应同时看到 admin 和 manager 的菜单
    expect(labels).toContain('组织架构')
    expect(labels).toContain('开单')
    expect(labels).toContain('系统配置')
    expect(labels).toContain('顾客管理')
  })

  it('staff 不可登录管理后台 — 只有工作台', () => {
    const labels = getMenuLabels(makeSession({ role: 'staff' as RoleType }))
    // staff 不在任何菜单的 requiredRoles 中
    expect(labels).toHaveLength(0)
  })

  it('空角色列表无菜单', () => {
    const session = makeSession()
    // makeSession 被传入空参数
    const emptySession: AuthSession = { ...session, roles: [] }
    const labels = getMenuLabels(emptySession)
    expect(labels).toHaveLength(0)
  })

  it('过滤空分组', () => {
    const groups = getVisibleMenuGroups(makeSession({ role: 'product' }))
    groups.forEach(g => {
      expect(g.items.length).toBeGreaterThan(0)
    })
  })
})

describe('MENU_CONFIG 完整性', () => {
  it('所有菜单项都有 href', () => {
    MENU_CONFIG.forEach(group => {
      group.items.forEach(item => {
        expect(item.href).toBeTruthy()
        expect(item.href.startsWith('/')).toBe(true)
      })
    })
  })

  it('所有菜单项都有图标', () => {
    MENU_CONFIG.forEach(group => {
      group.items.forEach(item => {
        expect(item.icon).toBeDefined()
      })
    })
  })

  it('所有菜单项都有 requiredRoles', () => {
    MENU_CONFIG.forEach(group => {
      group.items.forEach(item => {
        expect(item.requiredRoles.length).toBeGreaterThan(0)
      })
    })
  })
})
