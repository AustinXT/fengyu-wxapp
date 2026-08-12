/**
 * utils/role.ts hasRole helper 测试
 *
 * Wave 2 S4：取代 magic string roles 数组判定（如 profile.ts 此前的
 * `['manager','admin','finance'].some(r => roles.includes(r))`）。
 */

import { hasRole, canAccessManagement, isManagementMode, isManager } from '../../utils/role'

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
  function setAvailableLoginLevels(availableLoginLevels: string[] | undefined) {
    const fakeApp = { globalData: { availableLoginLevels } }
    ;(globalThis as any).getApp = () => fakeApp
  }
  afterEach(() => {
    delete (globalThis as any).getApp
  })

  test('availableLoginLevels 含 management → true（权限矩阵驱动）', () => {
    setAvailableLoginLevels(['store', 'management'])
    expect(canAccessManagement()).toBe(true)
    setAvailableLoginLevels(['management'])
    expect(canAccessManagement()).toBe(true)
  })

  test('availableLoginLevels 不含 management → false', () => {
    setAvailableLoginLevels(['store'])
    expect(canAccessManagement()).toBe(false)
    setAvailableLoginLevels([])
    expect(canAccessManagement()).toBe(false)
    setAvailableLoginLevels(undefined)
    expect(canAccessManagement()).toBe(false)
  })
})

describe('门店运行态角色判定', () => {
  function setGlobalData(globalData: Record<string, unknown>) {
    ;(globalThis as any).getApp = () => ({ globalData })
  }

  afterEach(() => {
    delete (globalThis as any).getApp
  })

  test('仅 management 登录模式才是管理层页面运行态', () => {
    setGlobalData({ loginLevel: 'management' })
    expect(isManagementMode()).toBe(true)

    setGlobalData({ loginLevel: 'store' })
    expect(isManagementMode()).toBe(false)
  })

  test('店长必须在门店模式且当前门店命中 managerStores', () => {
    setGlobalData({
      loginLevel: 'store',
      currentStoreId: 'store-a',
      boundStoreId: 'store-a',
      managerStores: [{ storeId: 'store-a', storeName: 'A 店' }],
      managerStoreIds: [],
    })
    expect(isManager()).toBe(true)

    setGlobalData({
      loginLevel: 'store',
      currentStoreId: 'store-b',
      boundStoreId: 'store-a',
      managerStores: [{ storeId: 'store-a', storeName: 'A 店' }],
      managerStoreIds: [],
    })
    expect(isManager()).toBe(false)
  })

  test('managerStoreIds 可兼容没有门店对象的 auth 缓存', () => {
    setGlobalData({
      loginLevel: 'store',
      currentStoreId: 'store-b',
      managerStores: [],
      managerStoreIds: ['store-b'],
    })
    expect(isManager()).toBe(true)
  })

  test('管理层模式即使店长管辖当前门店也不可执行门店店长操作', () => {
    setGlobalData({
      loginLevel: 'management',
      currentStoreId: 'store-a',
      managerStores: [{ storeId: 'store-a', storeName: 'A 店' }],
      managerStoreIds: ['store-a'],
    })
    expect(isManager()).toBe(false)
  })
})
