/**
 * 管理层看板 scope 落在已停用门店（#400，admin #293 的 staff 端同型）
 *
 * 口径：「在营」只看门店组织节点 org_nodes.is_active（云函数判定）；停用门店的数据被取数 SQL
 * 全部滤掉，照常取数只会满屏 0。所以：
 *   - 默认范围跳过停用门店；权限内全部停用才落上去
 *   - 落在停用门店 → 「「XX」已停用，无可展示数据」空态；在营门店本期无业绩照常显示 0
 *   - 销售数据页的取数同样被滤光 → 以 salesData 回包 scope.inactive 出同一空态
 *   - 客量 / 品项 / 顾客子页的接口不滤停用门店（有真实历史数据）→ 照常取数，只在范围标签标「（已停用）」
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
function summaryResp(scope: { type: string; id: string | null; name: string; inactive: boolean; hasActiveAlternative?: boolean }) {
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

// roleBindings.scopeId 是组织节点 id（生产形如 org-门店-<ts>），与 storeId 不同；店长管辖门店走 managerStoreIds
const managerOf = (storeNodeId: string) => ({ role: 'manager', isStoreManager: true, scopeType: '门店', scopeId: storeNodeId })

describe('hub · computeDefaultScope 跳过停用门店', () => {
  test('店长绑定门店已停用、另有在营门店 → 落到第一家在营门店', () => {
    setGlobalData({
      roleBindings: [managerOf('org-门店-zh')],
      managerStoreIds: ['store-zh'],
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
      roleBindings: [managerOf('org-门店-zg')],
      managerStoreIds: ['store-zg'],
      scopedStores: [
        { storeId: 'store-a', storeName: 'A 店', isActive: false },
        { storeId: 'store-zg', storeName: '自贡旭阳店', isActive: false },
      ],
    })
    expect(instantiate('hub').computeDefaultScope()).toEqual({
      scopeType: 'store', scopeId: 'store-zg', scopeName: '自贡旭阳店', inactive: true,
    })
  })

  test('店长管辖门店在营 → 优先它而不是店名排第一的门店（按 managerStoreIds 匹配，非组织节点 id）', () => {
    setGlobalData({
      roleBindings: [managerOf('org-门店-lw')],
      managerStoreIds: ['store-lw'],
      scopedStores: [
        { storeId: 'store-ld', storeName: '九江丽都店', isActive: true },
        { storeId: 'store-lw', storeName: '九江蓝湾店', isActive: true },
      ],
    })
    expect(instantiate('hub').computeDefaultScope().scopeId).toBe('store-lw')
  })

  test('市场账号 → 默认范围带绑定上的市场名（市场下门店全停用被下拉剔除时，触发器不误显示「全部市场」）', () => {
    setGlobalData({ roleBindings: [{ role: 'manager', scopeType: '市场', scopeId: 'org-mkt-zg', scopeName: '自贡凤御' }] })
    expect(instantiate('hub').computeDefaultScope()).toEqual({ scopeType: 'market', scopeId: 'org-mkt-zg', scopeName: '自贡凤御' })
  })

  test('旧缓存无 isActive 字段 → 按在营处理（行为同改动前）', () => {
    setGlobalData({
      roleBindings: [managerOf('org-门店-b')],
      managerStoreIds: ['store-b'],
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
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-zg', name: '自贡旭阳店', inactive: true, hasActiveAlternative: false }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zg', scopeName: '自贡旭阳店', inactive: true })
    await hub.loadSummary()

    expect(hub.data.summaryState).toBe('empty')
    expect(hub.data.summaryEmptyText).toBe('「自贡旭阳店」已停用，无可展示数据')
    expect(hub.data.summaryEmptyHint).toBe('当前账号没有其它在营门店可查看')
    expect(hub.data.display).toBeNull()
  })

  test('后端说有其它在营门店 → 提示去上方切换（判据后端下发，不在前端复算）', async () => {
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-zh', name: '九江中辉店', inactive: true, hasActiveAlternative: true }))
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

  test('只切日期、scope 不变 → 旧日期的迟到响应（含失败）同样丢弃', async () => {
    let rejectOld!: (e: unknown) => void
    mocked
      .mockReturnValueOnce(new Promise((_r, j) => { rejectOld = j }) as any)
      .mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-zh', name: '九江中辉店', inactive: true, hasActiveAlternative: false }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    const first = hub.loadSummary()
    hub.data.selectedDate = '2026-09-24'
    await hub.loadSummary()
    rejectOld(new Error('timeout'))
    await first

    expect(hub.data.summaryState).toBe('empty')
    expect((globalThis as any).wx.showToast).not.toHaveBeenCalled()
  })

  test('响应回来前已切 scope → 丢弃迟到响应，不把停用标记盖到新 scope', async () => {
    let resolve!: (v: unknown) => void
    mocked.mockReturnValueOnce(new Promise((r) => { resolve = r }) as any)
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    const pending = hub.loadSummary()
    hub.data.scope = { scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店' }
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-lw', name: '九江蓝湾店', inactive: false }))
    await hub.loadSummary()
    resolve(summaryResp({ type: 'store', id: 'store-zh', name: '九江中辉店', inactive: true }))
    await pending

    expect(hub.data.scope.inactive).toBe(false)
    expect(hub.data.summaryState).toBe('content')
  })

  test('选择范围 → 切 tab 重建 picker 时回到当前 scope：defaultScope 跟随 onScopeChange 与服务端启停', async () => {
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-a', scopeName: 'A 店' })
    hub.data.defaultScope = { scopeType: 'store', scopeId: 'store-a', scopeName: 'A 店' }
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-b', name: 'B 店', inactive: true, hasActiveAlternative: true }))
    hub.onScopeChange({ detail: { scopeType: 'store', scopeId: 'store-b', scopeName: 'B 店', inactive: false } })
    expect(hub.data.defaultScope).toMatchObject({ scopeId: 'store-b' })
    await vi.waitFor(() => expect(hub.data.summaryState).toBe('empty'))
    expect(hub.data.defaultScope.inactive).toBe(true)
  })

  test('换 scope 后请求失败 → 出错误态，不挂着上一门店的指标', async () => {
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-a', name: 'A 店', inactive: false }))
    const hub = hubAt({ scopeType: 'store', scopeId: 'store-a', scopeName: 'A 店' })
    await hub.loadSummary()
    expect(hub.data.summaryState).toBe('content')

    mocked.mockRejectedValueOnce(new Error('timeout'))
    hub.data.scope = { scopeType: 'store', scopeId: 'store-b', scopeName: 'B 店' }
    await hub.loadSummary()
    expect(hub.data.display).toBeNull()
    expect(hub.data.summaryState).toBe('error')

    // 同 scope 同日期的刷新失败仍保留旧内容
    mocked.mockResolvedValueOnce(summaryResp({ type: 'store', id: 'store-b', name: 'B 店', inactive: false }))
    await hub.loadSummary()
    mocked.mockRejectedValueOnce(new Error('timeout'))
    await hub.loadSummary()
    expect(hub.data.summaryState).toBe('content')
    expect(hub.data.display).not.toBeNull()
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

  test('组件 attached 早于页面 onShow：页面随后下发的默认范围经 observer 接住并纠正', async () => {
    mocked.mockResolvedValueOnce(options())
    const picker = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
    await picker.loadOptions()
    expect(picker.events).toEqual([])

    picker.observers.defaultScope.call(picker, { scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    expect(picker.data.applied).toMatchObject({ scopeId: 'store-lw' })
    expect(picker.events[0].detail).toMatchObject({ scopeId: 'store-lw', inactive: false })
  })

  test('选项未加载时 observer 只记下默认值，加载后再校正；用户显式选过后不被默认值覆盖', async () => {
    const picker = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
    picker.observers.defaultScope.call(picker, { scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    expect(picker.data.applied.scopeId).toBe('store-zh')
    mocked.mockResolvedValueOnce(options({ markets: [] }))
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeId: 'store-zh', inactive: true })

    picker._confirmAndEmit({ scopeType: 'store', marketId: 'mkt-jj', scopeId: 'store-lw', scopeName: '九江凤御 · 九江蓝湾店' })
    picker.observers.defaultScope.call(picker, { scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    expect(picker.data.applied.scopeId).toBe('store-lw')
  })

  test('inactiveStores=null（服务端查询失败 / 旧云函数）→ 不纠正，也不撤已知的停用标记', async () => {
    mocked.mockResolvedValueOnce(options({ inactiveStores: null }))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店', inactive: true })
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeId: 'store-zh', inactive: true })
    expect(picker.events).toEqual([])
  })

  test('两条查询间门店被停用、同店同时出现在下拉与 inactiveStores → 停用优先，不把它当替代门店', async () => {
    mocked.mockResolvedValueOnce(options({
      markets: [{ id: 'mkt-jj', name: '九江凤御', stores: [{ storeId: 'store-zh', storeName: '九江中辉店' }] }],
    }))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' })
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeId: 'store-zh', inactive: true })
  })

  test('页面据 summary 确认的启停同步到触发器（appliedInactive observer）', () => {
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-lw', scopeName: '九江蓝湾店' })
    picker.observers.appliedInactive.call(picker, true)
    expect(picker.data.applied.inactive).toBe(true)
    picker.observers.appliedInactive.call(picker, false)
    expect(picker.data.applied.inactive).toBe(false)

    const all = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
    all.observers.appliedInactive.call(all, true)
    expect(all.data.applied.inactive).toBeUndefined()
  })

  test('显式选择时按停用集合如实标注 inactive（两条查询之间被停用的窗口）', async () => {
    mocked.mockResolvedValueOnce(options())
    const picker = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
    await picker.loadOptions()
    picker._confirmAndEmit({ scopeType: 'store', marketId: 'mkt-jj', scopeId: 'store-zh', scopeName: '九江凤御 · 九江中辉店' })
    expect(picker.events.at(-1).detail).toMatchObject({ scopeId: 'store-zh', inactive: true })
    picker._confirmAndEmit({ scopeType: 'store', marketId: 'mkt-jj', scopeId: 'store-lw', scopeName: '九江凤御 · 九江蓝湾店' })
    expect(picker.events.at(-1).detail).toMatchObject({ scopeId: 'store-lw', inactive: false })
  })

  test('首次加载失败 → 打开弹窗时重拉', async () => {
    mocked.mockRejectedValueOnce(new Error('network'))
    const picker = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
    await picker.loadOptions()
    expect(picker.data.optionsLoaded).toBe(false)
    mocked.mockResolvedValueOnce(options())
    picker.onOpen()
    await vi.waitFor(() => expect(picker.data.optionsLoaded).toBe(true))
    expect(mocked).toHaveBeenCalledTimes(2)
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

describe('子页：销售数据以回包出空态；客量 / 品项 / 顾客照常取数只标注', () => {
  const inactiveQuery = {
    scopeType: 'store',
    scopeId: 'store-ld',
    scopeName: encodeURIComponent('南昌龙大店'),
    scopeInactive: '1',
  }

  test('sales：回包 scope.inactive=true → 空态，文案对齐 #293', async () => {
    mocked.mockResolvedValueOnce({ scope: { type: 'store', id: 'store-ld', name: '南昌龙大店', inactive: true } })
    const page = instantiate('sales')
    page.onLoad(inactiveQuery)
    await vi.waitFor(() => expect(page.data.state).toBe('empty'))
    expect(page.data.inactiveText).toBe('「南昌龙大店」已停用，无可展示数据')
    expect(page.data.scopeInactive).toBe(true)
  })

  test('sales：query 带停用标记但回包说在营（期间已启用）→ 以回包为准照常渲染', async () => {
    mocked.mockResolvedValueOnce({ totalRevenue: '0.00', scope: { type: 'store', id: 'store-ld', name: '南昌龙大店', inactive: false } })
    const page = instantiate('sales')
    page.onLoad(inactiveQuery)
    await vi.waitFor(() => expect(page.data.state).toBe('content'))
    expect(page.data.scopeInactive).toBe(false)
    expect(page.data.totalRevenue).toBe('0.00')
  })

  test('sales：旧云函数回包无 scope → 照常渲染 0（向后兼容）', async () => {
    mocked.mockResolvedValueOnce({ totalRevenue: '0.00' })
    const page = instantiate('sales')
    page.onLoad({ scopeType: 'store', scopeId: 'store-lw', scopeName: encodeURIComponent('九江蓝湾店') })
    await vi.waitFor(() => expect(page.data.state).toBe('content'))
  })

  // 这三页的接口（mgmt-traffic / mgmt-product / mgmt-customer）不叠加启停过滤：
  // 南昌龙大店在 prod 有 1 个顾客、25 张销售单，整页空态会把真实数据藏掉。
  test.each(['traffic', 'products'])('%s：照常调云函数，范围标签标已停用', (name) => {
    mocked.mockResolvedValue({})
    const page = instantiate(name)
    page.onLoad(inactiveQuery)
    expect(page.data.scopeInactive).toBe(true)
    expect(callStaffApi).toHaveBeenCalled()
  })

  test('customers：onShow 照常拉首页，范围标签标已停用', () => {
    mocked.mockResolvedValue({ customers: [], page: 1, pageSize: 50, hasMore: false })
    const page = instantiate('customers')
    page.onLoad(inactiveQuery)
    page.onShow()
    expect(page.data.scopeInactive).toBe(true)
    expect(callStaffApi).toHaveBeenCalledWith('mgmtCustomer.search', expect.anything())
  })

  test('customers → 详情：停用标记继续透传，详情页范围标签标注', () => {
    const list = instantiate('customers')
    list.onLoad(inactiveQuery)
    list.onItemTap({ currentTarget: { dataset: { clientUserId: 'cu-1' } } })
    const url = vi.mocked((globalThis as any).wx.navigateTo).mock.calls.at(-1)![0].url as string
    expect(url).toMatch(/scopeInactive=1/)
  })

  test('无停用标记 → 不标注', () => {
    mocked.mockResolvedValue({})
    const page = instantiate('traffic')
    page.onLoad({ scopeType: 'store', scopeId: 'store-lw', scopeName: encodeURIComponent('九江蓝湾店') })
    expect(page.data.scopeInactive).toBe(false)
  })
})
