/**
 * 管理层看板：只授权无门店市场的账号（#424，admin #399 的 staff 端同型）
 *
 *   - scopeOptions 保留直接授权的无门店市场（如品项公司）→ picker 能回填市场名、能选中它
 *   - 默认范围规则对齐 admin resolveDefaultDataCenterScope：有在营门店时绝不落到无门店市场；
 *     没有在营门店才落到直接授权的无门店市场
 *   - 「店长 + hr@品项公司」混合账号：默认落门店（与 admin 一致），切到门店后还能切回品项公司
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'
import { resolveDefaultMgmtScope, type MgmtScopeOptionsLite, type MgmtScopeValue } from '../../utils/mgmt-scope'
// 跨端行为对照：只在测试里读 admin 的实现（运行时代码各端独立副本，见根 CLAUDE.md）
import { resolveDefaultDataCenterScope } from '../../../../fengyu-admin/src/lib/data-center/scope-options'

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
  appState.globalData = { loginLevel: 'management', roleBindings: [], scopedStores: [], managerStoreIds: [], ...data }
}

/** Page / Component 实例替身：setData 支持 'a.b' 路径写法 */
function instantiate(name: string, props: Record<string, unknown> = {}) {
  const def = definitions[name]
  const methods = def.methods || {}
  const inst: Record<string, any> = {
    ...def,
    ...methods,
    data: JSON.parse(JSON.stringify(def.data)),
    properties: {
      ...Object.fromEntries(Object.entries(def.properties || {}).map(([k, v]: [string, any]) => [k, v?.value])),
      ...props,
    },
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

const PX = { id: 'org-px', name: '品项公司', stores: [] as Array<{ storeId: string; storeName: string }> }
const NC = { id: 'org-nc', name: '南昌凤御', stores: [{ storeId: 'store-ld', storeName: '南昌龙大店' }, { storeId: 'store-xy', storeName: '南昌新园店' }] }
const JJ = { id: 'org-jj', name: '九江凤御', stores: [{ storeId: 'store-lw', storeName: '九江蓝湾店' }] }

const opts = (allowedMarketIds: string[], markets: MgmtScopeOptionsLite['markets'], allowAll = false): MgmtScopeOptionsLite =>
  ({ allowAll, allowedMarketIds, markets })

describe('resolveDefaultMgmtScope', () => {
  test('总部 → 全部市场', () => {
    expect(resolveDefaultMgmtScope(opts([], [NC, PX], true), null, [])).toEqual({ scopeType: 'all', scopeId: null, scopeName: '全部市场' })
  })

  test('只授权品项公司（无门店市场）→ 落到品项公司，带市场名', () => {
    expect(resolveDefaultMgmtScope(opts([PX.id], [PX]), null, [])).toEqual({
      scopeType: 'market', scopeId: PX.id, scopeName: '品项公司', marketId: PX.id,
    })
  })

  test('店长 + hr@品项公司：页面初判落品项公司 → 纠正到店长门店（与 admin 单店落门店一致）', () => {
    const current: MgmtScopeValue = { scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' }
    const jjOnly = { ...NC, stores: [NC.stores[0]] }
    expect(resolveDefaultMgmtScope(opts([PX.id], [jjOnly, PX]), current, [])).toEqual({
      scopeType: 'store', scopeId: 'store-ld', scopeName: '南昌凤御 · 南昌龙大店', marketId: NC.id,
    })
  })

  test('有门店的授权市场优先于无门店市场（市场经理 + hr@品项公司 → 市场经理的市场）', () => {
    const current: MgmtScopeValue = { scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' }
    expect(resolveDefaultMgmtScope(opts([NC.id, PX.id], [NC, PX]), current, [])).toMatchObject({ scopeType: 'market', scopeId: NC.id })
  })

  test('页面初判已属于命中档位 → 原样保留（不按下拉排序改掉）', () => {
    const market: MgmtScopeValue = { scopeType: 'market', scopeId: JJ.id, scopeName: '九江凤御' }
    expect(resolveDefaultMgmtScope(opts([NC.id, JJ.id], [JJ, NC]), market, [])).toBe(market)
    const store: MgmtScopeValue = { scopeType: 'store', scopeId: 'store-xy', scopeName: '南昌新园店' }
    expect(resolveDefaultMgmtScope(opts([], [NC]), store, [])).toBe(store)
    // 门店档只纠正档位：不在在营列表里的初判门店（停用 / inactiveStores 未知）也保留，交 #400
    const offList: MgmtScopeValue = { scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店', inactive: true }
    expect(resolveDefaultMgmtScope(opts([], [NC]), offList, ['store-xy'])).toBe(offList)
  })

  test('只有门店级权限 → 店长管辖门店优先', () => {
    expect(resolveDefaultMgmtScope(opts([], [NC]), null, ['store-xy'])).toMatchObject({ scopeType: 'store', scopeId: 'store-xy' })
    expect(resolveDefaultMgmtScope(opts([], [NC]), null, [])).toMatchObject({ scopeType: 'store', scopeId: 'store-ld' })
  })

  test('没有在营门店也没有授权市场 → null（保留页面初判，交 #400 停用逻辑）', () => {
    expect(resolveDefaultMgmtScope(opts([], []), null, [])).toBeNull()
    // 未授权的空市场（门店级账号的祖先市场）不算
    expect(resolveDefaultMgmtScope(opts([], [PX]), null, [])).toBeNull()
  })
})

describe('scope-picker · 无门店市场回填与默认纠正', () => {
  function pickerWith(applied: Record<string, unknown>, props: Record<string, unknown> = { resolveDefault: true }) {
    const picker = instantiate('picker', props)
    picker.data.applied = applied
    picker.data.current = applied
    return picker
  }
  const resp = (allowedMarketIds: string[], markets: MgmtScopeOptionsLite['markets'], inactiveStores: unknown[] = []) =>
    ({ staffLevel: 'market', allowAll: false, allowedMarketIds, markets, inactiveStores })

  test('hr@品项公司：绑定上无市场名 → 回填「品项公司」，不再显示「全部市场」', async () => {
    mocked.mockResolvedValueOnce(resp([PX.id], [PX]))
    const picker = pickerWith({ scopeType: 'market', scopeId: PX.id, scopeName: '' })
    await picker.loadOptions()

    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司', marketId: PX.id })
    expect(picker.data.marketList).toEqual([{ id: PX.id, name: '品项公司' }])
    expect(picker.data.currentAllowsMarket).toBe(true)
    expect(picker.events.map((e: any) => e.name)).toEqual(['defaultresolved', 'change'])
  })

  test('店长 + hr@品项公司：默认纠正到门店；切到品项公司、再切门店、再切回品项公司都可以', async () => {
    setGlobalData({ managerStoreIds: ['store-lw'] })
    mocked.mockResolvedValue(resp([PX.id], [JJ, PX]))
    const picker = pickerWith({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' })
    await picker.loadOptions()

    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-lw', marketId: JJ.id })
    expect(picker.events.find((e: any) => e.name === 'change').detail).toMatchObject({ scopeType: 'store', scopeId: 'store-lw' })

    const tap = (dataset: Record<string, string>) => ({ currentTarget: { dataset } }) as any
    // 切到品项公司
    picker.onOpen()
    picker.onPickMarket(tap({ marketId: PX.id }))
    expect(picker.data.currentAllowsMarket).toBe(true)
    picker.onPickStore(tap({ storeId: '' }))
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' })
    // 切回门店
    picker.onOpen()
    picker.onPickMarket(tap({ marketId: JJ.id }))
    picker.onPickStore(tap({ storeId: 'store-lw' }))
    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-lw' })
    // 再切回品项公司（修复前品项公司被筛掉，切不回来）
    picker.onOpen()
    picker.onPickMarket(tap({ marketId: PX.id }))
    picker.onConfirm()
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id })
    expect(picker.events.at(-1).detail).toMatchObject({ scopeType: 'market', scopeId: PX.id, userPicked: true })
  })

  test('resolveDefault=false（用户已显式选过）→ 不纠正', async () => {
    mocked.mockResolvedValueOnce(resp([PX.id], [JJ, PX]))
    const picker = pickerWith({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' }, { resolveDefault: false })
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id })
    // 没有纠正（不广播 defaultresolved），只有 marketId 回填的广播，没有被换到门店
    expect(picker.events.map((e: any) => [e.name, e.detail.scopeId])).toEqual([['change', PX.id]])
  })

  test('组件内已有用户选择 → observer 之后的归一化也不纠正', async () => {
    mocked.mockResolvedValueOnce(resp([PX.id], [JJ, PX]))
    const picker = pickerWith({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' }, { resolveDefault: false })
    await picker.loadOptions()
    picker._confirmAndEmit({ scopeType: 'market', marketId: PX.id, scopeId: PX.id, scopeName: '品项公司' })
    picker.properties.resolveDefault = true // 页面属性回传有延迟：组件内 userPicked 兜底
    picker._normalizeApplied()
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id })
  })

  test('初判已正确 → 不换范围，但照样广播 defaultresolved（页面据此关掉后续纠正）', async () => {
    mocked.mockResolvedValueOnce(resp([JJ.id], [JJ]))
    const picker = pickerWith({ scopeType: 'market', scopeId: JJ.id, scopeName: '九江凤御', marketId: JJ.id })
    await picker.loadOptions()
    expect(picker.events).toEqual([{ name: 'defaultresolved', detail: undefined }])
  })

  test('弹窗开着时首次拿到选项（首次加载失败后 onOpen 重拉）→ 不纠正，不覆盖正在选的项', async () => {
    mocked.mockResolvedValueOnce(resp([PX.id], [JJ, PX]))
    const picker = pickerWith({ scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' })
    picker.data.showPopup = true
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: PX.id })
    expect(picker.events.map((e: any) => e.name)).not.toContain('defaultresolved')
  })

  test('scopeOptions 先于页面初判返回：占位「全部市场」不纠正，页面下发初判后经 observer 纠正', async () => {
    setGlobalData({ managerStoreIds: ['store-lw'] })
    mocked.mockResolvedValueOnce(resp([PX.id], [JJ, PX]))
    const picker = pickerWith({ scopeType: 'all', scopeId: null, scopeName: '全部市场' }, { resolveDefault: false })
    await picker.loadOptions()
    expect(picker.events).toEqual([])

    picker.properties.resolveDefault = true // initDashboard 与 defaultScope 同一次 setData 下发
    picker.observers.defaultScope.call(picker, { scopeType: 'market', scopeId: PX.id, scopeName: '品项公司' })
    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-lw' })
    expect(picker.events.map((e: any) => e.name)).toEqual(['defaultresolved', 'change'])
  })

  test('inactiveStores=null 时的停用门店初判 → 不换店（#400：未知不纠正）', async () => {
    mocked.mockResolvedValueOnce(resp([], [JJ], null as any))
    const picker = pickerWith({ scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店', inactive: true })
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-zh', inactive: true })
    expect(picker.events.map((e: any) => e.name)).toEqual(['defaultresolved'])
  })

  test('落在已停用门店 → 不走默认纠正，交 #400 逻辑（autoCorrect=false 时保留并标停用）', async () => {
    mocked.mockResolvedValueOnce(resp([PX.id], [JJ, PX], [{ storeId: 'store-zh', storeName: '九江中辉店' }]))
    const picker = pickerWith(
      { scopeType: 'store', scopeId: 'store-zh', scopeName: '九江中辉店' },
      { resolveDefault: true, autoCorrect: false },
    )
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-zh', inactive: true })
  })
})

describe('hub · 默认纠正每个会话只做一次', () => {
  test('picker 广播 defaultresolved → scopeResolveDefault=false：切 tab 重建的 picker 不再纠正', async () => {
    const hub = instantiate('hub')
    hub.onScopeDefaultResolved()
    expect(hub.data.scopeResolveDefault).toBe(false)

    // 重建的 picker 带页面当前属性：会话中门店全停用、市场经理的市场被换掉的情形不会发生
    mocked.mockResolvedValueOnce({ staffLevel: 'market', allowAll: false, allowedMarketIds: [NC.id], markets: [{ ...NC, stores: [] }, JJ], inactiveStores: [] })
    const picker = instantiate('picker', { resolveDefault: hub.data.scopeResolveDefault })
    picker.data.applied = { scopeType: 'market', scopeId: NC.id, scopeName: '南昌凤御', marketId: NC.id }
    await picker.loadOptions()
    expect(picker.data.applied).toMatchObject({ scopeType: 'market', scopeId: NC.id })
    expect(picker.events).toEqual([])
  })
})

describe('hub · 用户显式选范围后关闭默认纠正', () => {
  test('initDashboard 与初判同一次打开 scopeResolveDefault（此前为 false，不把纠正耗在占位「全部市场」上）', () => {
    setGlobalData({ roleBindings: [{ role: 'hr', scopeType: '市场', scopeId: PX.id, scopeName: '品项公司' }] })
    const hub = instantiate('hub')
    hub.loadSummary = vi.fn()
    expect(hub.data.scopeResolveDefault).toBe(false)
    hub.initDashboard()
    expect(hub.data.scopeResolveDefault).toBe(true)
    expect(hub.data.defaultScope).toMatchObject({ scopeType: 'market', scopeId: PX.id })
  })

  test('picker 回传 userPicked → scopeResolveDefault=false；自动纠正回传不关', () => {
    const hub = instantiate('hub')
    hub.loadSummary = vi.fn()
    hub.data.scopeResolveDefault = true
    hub.onScopeChange({ detail: { scopeType: 'store', scopeId: 'store-lw', scopeName: '九江凤御 · 九江蓝湾店' } })
    expect(hub.data.scopeResolveDefault).toBe(true)
    hub.onScopeChange({ detail: { scopeType: 'market', scopeId: PX.id, scopeName: '品项公司', userPicked: true } })
    expect(hub.data.scopeResolveDefault).toBe(false)
  })
})

/**
 * 跨端行为对照：同一账号在 admin 数据中心与 staff 看板的默认范围一致。
 * staff 没有 admin 的「全部授权门店」（authorized），以「有门店的直接授权市场」或门店代替，因此比较的是：
 *   - 两端都 null / 都 all
 *   - admin 落无门店市场 → staff 落同一市场
 *   - admin 落门店 → staff 覆盖该门店；admin authorized → staff 覆盖的门店非空且 ⊆ 全部授权门店
 */
describe('跨端默认范围对照（admin resolveDefaultDataCenterScope ↔ staff resolveDefaultMgmtScope）', () => {
  interface Fixture {
    hq?: boolean
    /** 直接授权的市场 */
    granted: string[]
    /** 账号可见的在营门店 */
    stores: string[]
    managerStoreIds?: string[]
  }
  const ALL = [NC, JJ, PX]

  function adminDefault(f: Fixture) {
    const markets = ALL
      .map((m) => ({
        id: m.id, name: m.name,
        granted: !!f.hq || f.granted.includes(m.id),
        stores: m.stores.filter((s) => f.hq || f.stores.includes(s.storeId)),
      }))
      // admin 可见市场 = 直接授权 ∪ 门店级账号的祖先市场
      .filter((m) => f.hq || m.granted || m.stores.length > 0)
    return resolveDefaultDataCenterScope({
      topLevel: f.hq ? 'all' : f.granted.length > 0 ? 'market' : 'store',
      markets,
      inactiveStores: [],
    })
  }
  function staffDefault(f: Fixture) {
    // 与 staffApi scopeOptions 同形：有账号门店的市场 + 直接授权的市场
    const markets = ALL
      .map((m) => ({ ...m, stores: m.stores.filter((s) => f.hq || f.stores.includes(s.storeId)) }))
      .filter((m) => f.hq || m.stores.length > 0 || f.granted.includes(m.id))
    return resolveDefaultMgmtScope({ allowAll: !!f.hq, allowedMarketIds: f.granted, markets }, null, f.managerStoreIds || [])
  }
  function staffCovered(s: MgmtScopeValue): string[] {
    if (s.scopeType === 'store') return [s.scopeId!]
    return ALL.find((m) => m.id === s.scopeId)!.stores.map((x) => x.storeId)
  }

  const cases: Array<[string, Fixture]> = [
    ['总部', { hq: true, granted: [], stores: [] }],
    ['hr@品项公司', { granted: [PX.id], stores: [] }],
    ['店长 + hr@品项公司', { granted: [PX.id], stores: ['store-lw'], managerStoreIds: ['store-lw'] }],
    ['市场经理（两店市场）', { granted: [NC.id], stores: ['store-ld', 'store-xy'] }],
    ['市场经理（单店市场）', { granted: [JJ.id], stores: ['store-lw'] }],
    ['市场经理 + hr@品项公司', { granted: [NC.id, PX.id], stores: ['store-ld', 'store-xy'] }],
    ['两店店长（跨市场）', { granted: [], stores: ['store-ld', 'store-lw'], managerStoreIds: ['store-lw'] }],
    ['唯一门店已停用的店长', { granted: [], stores: [] }],
    ['唯一门店已停用的店长 + hr@品项公司', { granted: [PX.id], stores: [] }],
  ]

  test.each(cases)('%s', (_name, f) => {
    const admin = adminDefault(f)
    const staff = staffDefault(f)
    if (admin === null) return expect(staff).toBeNull()
    expect(staff).not.toBeNull()
    if (admin.type === 'all') return expect(staff!.scopeType).toBe('all')
    if (admin.type === 'market') return expect(staff).toMatchObject({ scopeType: 'market', scopeId: admin.id })
    const covered = staffCovered(staff!)
    expect(covered.length).toBeGreaterThan(0)
    if (admin.type === 'store') return expect(covered).toContain(admin.id)
    // authorized：staff 覆盖范围须在全部授权门店之内
    for (const id of covered) expect(f.stores).toContain(id)
  })
})
