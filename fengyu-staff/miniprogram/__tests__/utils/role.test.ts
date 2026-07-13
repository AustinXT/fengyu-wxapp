/**
 * utils/role.ts hasRole helper 测试
 *
 * Wave 2 S4：取代 magic string roles 数组判定（如 profile.ts 此前的
 * `['manager','admin','finance'].some(r => roles.includes(r))`）。
 */

import { hasRole, canAccessManagement } from '../../utils/role'

// 在 globalThis 上注入 getApp mock；每个 test 通过 setGlobalRoles 改 globalData.roles
function setGlobalRoles(roles: string[] | undefined) {
  const fakeApp = {
    globalData: {
      roles,
    },
  }
  ;(globalThis as any).getApp = () => fakeApp
}

describe('hasRole', () => {
  afterEach(() => {
    delete (globalThis as any).getApp
  })

  test('单角色命中：globalData.roles 含目标角色 → true', () => {
    setGlobalRoles(['manager'])
    expect(hasRole('manager')).toBe(true)
  })

  test('单角色未命中：globalData.roles 不含目标角色 → false', () => {
    setGlobalRoles(['hr'])
    expect(hasRole('manager')).toBe(false)
  })

  test('多角色任一命中：可变参数中任意角色匹配即 true', () => {
    setGlobalRoles(['finance'])
    expect(hasRole('admin', 'finance')).toBe(true)
  })

  test('多角色全部未命中：所有指定角色均不在 roles 中 → false', () => {
    setGlobalRoles(['hr'])
    expect(hasRole('manager', 'admin', 'finance')).toBe(false)
  })

  test('roles 为空数组 → false', () => {
    setGlobalRoles([])
    expect(hasRole('manager')).toBe(false)
  })

  test('roles 为 undefined（globalData 未初始化场景）→ false', () => {
    setGlobalRoles(undefined)
    expect(hasRole('manager')).toBe(false)
  })

  test('未传任何 roleName → false（空 .some 永远 false）', () => {
    setGlobalRoles(['manager'])
    expect(hasRole()).toBe(false)
  })
})

describe('canAccessManagement', () => {
  function setStaffLevel(staffLevel: string | null | undefined) {
    const fakeApp = { globalData: { staffLevel } }
    ;(globalThis as any).getApp = () => fakeApp
  }
  afterEach(() => {
    delete (globalThis as any).getApp
  })

  test('headquarters / market / store_manager → true（店长放开管理层视图）', () => {
    setStaffLevel('headquarters')
    expect(canAccessManagement()).toBe(true)
    setStaffLevel('market')
    expect(canAccessManagement()).toBe(true)
    setStaffLevel('store_manager')
    expect(canAccessManagement()).toBe(true)
  })

  test('store_staff / null / undefined → false（美容师与未登录不放开）', () => {
    setStaffLevel('store_staff')
    expect(canAccessManagement()).toBe(false)
    setStaffLevel(null)
    expect(canAccessManagement()).toBe(false)
    setStaffLevel(undefined)
    expect(canAccessManagement()).toBe(false)
  })
})
