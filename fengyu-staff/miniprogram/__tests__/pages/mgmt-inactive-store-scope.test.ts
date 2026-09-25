/**
 * 管理层看板 scope 落在已停用门店（#400，admin #293 的 staff 端同型）
 *
 * 口径：「在营」只看门店组织节点 org_nodes.is_active（云函数判定）；停用门店的数据被取数 SQL
 * 全部滤掉，照常取数只会满屏 0。所以：
 *   - 默认范围跳过停用门店；权限内全部停用才落上去
 *   - 落在停用门店 → 「「XX」已停用，无可展示数据」空态；在营门店本期无业绩照常显示 0
 *   - 客量 / 销售 / 品项 / 顾客子页经 query（scopeInactive=1）继承，出同一空态、不取数
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

const appState = { globalData: {} as Record<string, unknown> }
const definitions: Record<string, Record<string, any>> = {}
let registering = ''
let originalGetApp: unknown
let originalPage: unknown
let originalComponent: unknown

function setGlobalData(data: Record<string, unknown>) {
  appState.globalData = { loginLevel: 'management', roleBindings: [], scopedStores: [], ...data }
}

/** Page / Component 实例替身：setData 支持 'a.b' 路径写法 */
function instantiate(name: string, extra: Record<string, unknown> = {}) {
  const def = definitions[name]
  const methods = def.methods || {}
  const inst: Record<string, any> = {
    ...def,
    ...methods,
    ...extra,
    data: JSON.parse(JSON.stringify(def.data)),
    properties: {},
    events: [] as Array<{ name: string; detail: any }>,
  }
  inst.setData = (update: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(update)) {
      const path = key.split('.')
      let target = inst.data
      for (const seg of path.slice(0, -1)) target = target[seg]
      target[path[path.length - 1]] = value
    }
  }
  inst.triggerEvent = (eventName: string, detail: unknown) => inst.events.push({ name: eventName, detail })
  return inst
}

const mocked = vi.mocked(callStaffApi)

/** summary 最小返回：全 0 指标 + scope */
function summaryResp(scope: { type: string; id: string | null; name: string; inactive: boolean }) {
  const pair = { today: 0, month: 0 }
  const triple = { today: 0, month: 0, monthlyAvgPerStore: 0 }
  return {
    date: '2026-09-25',
    scope,
    storeRevenue: triple, shengmeiRevenue: triple, storeConsume: triple, shengmeiConsume: triple,
    footfall: pair, headcount: pair, newMembers: pair, projectCount: pair,
    salesCommissionIncome: pair, serviceCommissionIncome: pair,
    memberCount: 0, retainedMemberCount: 0,
    storeCount: { day: 1, month: 1 }, employeeCount: { day: 3, month: 3 },
  }
}

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  originalComponent = (globalThis as any).Component
  ;(globalThis as any).getApp = () => appState
  ;(globalThis as any).Page = (def: Record<string, any>) => { definitions[registering] = def }
  ;(globalThis as any).Component = (def: Record<string, any>) => { definitions[registering] = def }
  Object.assign((globalThis as any).wx, {
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    reLaunch: vi.fn(),
    stopPullDownRefresh: vi.fn(),
  })

  registering = 'hub'
  await import('../../pages/mgmt-dashboard/mgmt-dashboard')
  registering = 'picker'
  await import('../../components/mgmt-scope-picker/mgmt-scope-picker')
  registering = 'traffic'
  await import('../../packageMgmt/mgmt-traffic-stats/mgmt-traffic-stats')
  registering = 'sales'
  await import('../../pages/sales-data/sales-data')
  registering = 'products'
  await import('../../packageMgmt/mgmt-product-cycle/mgmt-product-cycle')
  registering = 'customers'
  await import('../../packageMgmt/mgmt-customer-list/mgmt-customer-list')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
  ;(globalThis as any).Component = originalComponent
})

beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockReset()
  setGlobalData({})
})

const managerOf = (storeNodeId: string) => ({ role: 'manager', isStoreManager: true, scopeType: '门店', scopeId: storeNodeId })

describe('hub · computeDefaultScope 跳过停用门店', () => {
  test('店长绑定门店已停用、另有在营门店 → 落到第一家在营门店', () => {
    setGlobalData({
      roleBindings: [managerOf('store-zh')],
      scopedStores: [
        { storeId: 'store-zh', storeName: '九江中辉店', isActive: false },
        { storeId: 'store-lw', storeName: '九江蓝湾店', isActive: true },
      ],
    })
    expect(instantiate('hub').computeDefaultScope()).toEqual({
      scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店',
    })
  })

  test('按店名排第一的门店已停用 → 跳到下一家在营门店', () => {
    setGlobalData({
      roleBindings: [{ role: 'customer_mgr', scopeType: '门店', scopeId: 'x' }],
      scopedStores: [
        { storeId: 'store-ld', storeName: '南昌龙大店', isActive: false },
        { storeId: 'store-xy', storeName: '南昌新园店', isActive: true },
      ],
    })
    expect(instantiate('hub').computeDefaultScope().scopeId).toBe('store-xy')
  })

  test('权限内全部停用 → 仍落到店长绑定门店，标 inactive', () => {
    setGlobalData({
      roleBindings: [managerOf('store-zg')],
      scopedStores: [
        { storeId: 'store-a', storeName: 'A 店', isActive: false },
        { storeId: 'store-zg', storeName: '自贡旭阳店', isActive: false },
      ],
    })
    expect(instantiate('hub').computeDefaultScope()).toEqual({
      scopeType: 'store', scopeId: 'store-zg', scopeName: '自贡旭阳店', inactive: true,
    })
  })

  test('旧缓存无 isActive 字段 → 按在营处理（行为同改动前）', () => {
    setGlobalData({
      roleBindings: [managerOf('store-b')],
      scopedStores: [{ storeId: 'store-a', storeName: 'A 店' }, { storeId: 'store-b', storeName: 'B 店' }],
    })
    expect(instantiate('hub').computeDefaultScope().scopeId).toBe('store-b')
  })
})

describe('hub · summary 空态以服务端 scope.inactive 为准', () => {
  function hubAt(scope: Record<string, unknown>) {
    const hub = instantiate('hub')
    hub.data.selectedDate = '2026-09-25'
    hub.data.scope = scope
    return hub
  }

  test('停用门店 → empty 空态 + 文案对齐 #293；无其它在营门店时给出说明', async () => {
    setGlobalData({ roleBindings: [managerOf('store-zg')], scopedStores: [{ storeId: 'store-zg', storeName: '自贡旭阳店', isActive: false }] })
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-zg', name: '自贡旭阳店', inactive: true }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zg', scopeName: '自贡旭阳店', inactive: true })
    await hub.loadSummary()

    expect(hub.data.summaryState).toBe('empty')
    expect(hub.data.summaryEmptyText).toBe('「自贡旭阳店」已停用，无可展示数据')
    expect(hub.data.summaryEmptyHint).toBe('当前账号没有其它在营门店可查看')
    expect(hub.data.display).toBeNull()
  })

  test('有其它在营门店 → 提示去上方切换', async () => {
    setGlobalData({
      scopedStores: [
        { storeId: 'store-zh', storeName: '九江中辉店', isActive: false },
        { storeId: 'store-lw', storeName: '九江蓝湾店', isActive: true },
      ],
    })
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-zh', name: '九江中辉店', inactive: true }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    await hub.loadSummary()

    expect(hub.data.scope.inactive).toBe(true)
    expect(hub.data.summaryEmptyHint).toBe('请点击上方范围切换到在营门店')
  })

  test('在营门店本期无业绩 → 照常渲染 0，不出空态', async () => {
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-lw', name: '九江蓝湾店', inactive: false }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店' })
    await hub.loadSummary()

    expect(hub.data.summaryState).toBe('content')
    expect(hub.data.display.storeRevenue.today).toBe('0.00')
    expect(hub.data.scope.inactive).toBe(false)
  })

  test('响应回来前已切 scope → 丢弃迟到响应，不把停用标记盖到新 scope', async () => {
    let resolve!: (v: unknown) => void
    mocked.mockReturnValueOnce(new Promise((r) => { resolve = r }) as any)
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    const pending = hub.loadSummary()
    hub.data.scope = { scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店' }
    resolve(summaryResp({ type: 'store', id: 'store-zh', name: '九江中辉店', inactive: true }))
    await pending

    expect(hub.data.scope.inactive).toBeUndefined()
    expect(hub.data.summaryState).not.toBe('empty')
  })

  test('子页入口透传 scopeInactive=1（客量 / 销售 / 品项 / 顾客）', () => {
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店', inactive: true })
    for (const entry of ['traffic', 'sales', 'products', 'customers']) {
      hub.onEntryTap({ currentTarget: { dataset: { entry } } })
    }
    const urls = vi.mocked((globalThis as any).wx.navigateTo).mock.calls.map((c: any[]) => c[0].url as string)
    expect(urls).toHaveLength(4)
    for (const url of urls) expect(url).toMatch(/\?scopeType=store&scopeId=store-zh&scopeName=.+&scopeInactive=1$/)

    const active = hubAt({ scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店', inactive: false })
    expect(active.buildScopeQuery()).not.toContain('scopeInactive')
  })
})

describe('scope-picker · 纠正落在停用门店的默认范围', () => {
  const options = (overrides: Record<string, unknown> = {}) => ({
    staffLevel: 'store_manager',
    allowAll: false,
    allowedMarketIds: [],
    markets: [{ id: 'mkt-jj', name: '九江凤御', stores: [{ storeId: 'store-lw', storeName: '九江蓝湾店' }] }],
    inactiveStores: [{ storeId: 'store-zh', storeName: '九江中辉店' }],
    ...overrides,
  })
  function pickerWith(applied: Record<string, unknown>) {
    const picker = instantiate('picker')
    picker.data.applied = applied
    picker.data.current = applied
    return picker
  }

  test('有在营门店可选 → 纠正到第一家在营门店并广播', async () => {
    mocked.mockResolvedValueOnce(options())
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    await picker.loadOptions()

    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-lw', scopeName: '九江凤御 · 九江蓝湾店' })
    expect(picker.events).toEqual([{ name: 'change', detail: { scopeType: 'store', scopeId: 'store-lw', scopeName: '九江凤御 · 九江蓝湾店', inactive: false } }])
  })

  test('没有在营门店 → 保留停用门店，标 inactive（触发器显示「（已停用）」）', async () => {
    mocked.mockResolvedValueOnce(options({ markets: [] }))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    await picker.loadOptions()

    expect(picker.data.applied).toMatchObject({ scopeId: 'store-zh', inactive: true })
    expect(picker.events[0].detail).toMatchObject({ scopeId: 'store-zh', inactive: true })
  })

  test('页面已标 inactive 且服务端同判 → 不重复广播', async () => {
    mocked.mockResolvedValueOnce(options({ markets: [] }))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店', inactive: true })
    await picker.loadOptions()
    expect(picker.events).toEqual([])
  })

  test('页面初判停用、服务端说在营 → 撤掉标记', async () => {
    mocked.mockResolvedValueOnce(options({ inactiveStores: [] }))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店', inactive: true })
    await picker.loadOptions()
    expect(picker.data.applied.inactive).toBe(false)
    expect(picker.events[0].detail).toMatchObject({ scopeId: 'store-lw', inactive: false })
  })

  test('只关店、节点在营（不在下拉也不在 inactiveStores）→ 不纠正，保留其历史数据', async () => {
    mocked.mockResolvedValueOnce(options())
    const applied = { scopeType: 'store', scopeId: 'store-closed', scopeName: '只关店' }
    const picker = pickerWith(applied)
    await picker.loadOptions()
    expect(picker.data.applied).toEqual(applied)
    expect(picker.events).toEqual([])
  })
})

describe('子页经 query 继承停用标记：出空态、不取数', () => {
  const query = {
    scopeType: 'store',
    scopeId: 'store-ld',
    scopeName: encodeURIComponent('南昌龙大店'),
    scopeInactive: '1',
  }

  test.each(['traffic', 'sales', 'products'])('%s：onLoad 不调云函数', (name) => {
    const page = instantiate(name)
    page.onLoad(query)
    expect(page.data.inactiveText).toBe('「南昌龙大店」已停用，无可展示数据')
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('customers：onShow 拉首页也被拦下', async () => {
    const page = instantiate('customers')
    page.onLoad(query)
    page.onShow()
    await Promise.resolve()
    expect(page.data.inactiveText).toBe('「南昌龙大店」已停用，无可展示数据')
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('无停用标记 → 照常取数', () => {
    mocked.mockResolvedValue({})
    const page = instantiate('traffic')
    page.onLoad({ scopeType: 'store', scopeId: 'store-lw', scopeName: encodeURIComponent('九江蓝湾店') })
    expect(page.data.inactiveText).toBe('')
    expect(callStaffApi).toHaveBeenCalled()
  })
})
