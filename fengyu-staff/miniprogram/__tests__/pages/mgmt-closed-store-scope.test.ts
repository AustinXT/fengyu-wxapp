/**
 * 管理层看板范围下拉 · 只关店、组织节点仍启用的门店（#422）
 *
 * 这类门店照常留在下拉里（统计范围只看节点 is_active，#401；关店前的历史数据照常可查），但：
 *   - 下拉里标「（已关店）」，免得选中后看到关店后区间 0 业绩误判为数据异常
 *   - 选市场（无市场维度权限）时默认门店跳过已关店门店；该市场全关了才回落到第一家
 * closed 标记由云函数 scopeOptions 下发（staffApi utils/store-closed-label.js）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

let def: Record<string, any>
let originalComponent: unknown
let originalGetApp: unknown

/** Component 实例替身：setData 支持 'a.b' 路径写法 */
function instantiate() {
  const methods = def.methods || {}
  const inst: Record<string, any> = {
    ...def,
    ...methods,
    data: JSON.parse(JSON.stringify(def.data)),
    properties: Object.fromEntries(
      Object.entries(def.properties || {}).map(([k, v]: [string, any]) => [k, v?.value]),
    ),
    events: [] as Array<{ name: string; detail: any }>,
  }
  inst.setData = (update: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(update)) {
      const segs = key.split('.')
      let target = inst.data
      for (const seg of segs.slice(0, -1)) target = target[seg]
      target[segs[segs.length - 1]] = value
    }
  }
  inst.triggerEvent = (name: string, detail: unknown) => inst.events.push({ name, detail })
  return inst
}

const mocked = vi.mocked(callStaffApi)

beforeAll(async () => {
  originalComponent = (globalThis as any).Component
  originalGetApp = (globalThis as any).getApp
  ;(globalThis as any).Component = (d: Record<string, any>) => { def = d }
  ;(globalThis as any).getApp = () => ({ globalData: {} })
  Object.assign((globalThis as any).wx, { showToast: vi.fn() })
  await import('../../components/mgmt-scope-picker/mgmt-scope-picker')
})

afterAll(() => {
  ;(globalThis as any).Component = originalComponent
  ;(globalThis as any).getApp = originalGetApp
})

beforeEach(() => {
  mocked.mockReset()
})

/** 门店级账号（市场不在直接授权里）：选市场时落到该市场的某家门店 */
async function storeLevelPicker(stores: Array<{ storeId: string; storeName: string; closed?: boolean }>) {
  mocked.mockResolvedValueOnce({
    staffLevel: 'store_manager',
    allowAll: false,
    allowedMarketIds: [],
    markets: [{ id: 'mkt-jj', name: '九江凤御', stores }],
    inactiveStores: [],
  })
  const picker = instantiate()
  await picker.loadOptions()
  picker.onPickMarket({ currentTarget: { dataset: { marketId: 'mkt-jj' } } })
  return picker
}

describe('scope-picker · onPickMarket 默认门店跳过已关店门店', () => {
  test('第一家已关店 → 默认落到第一家未关店门店', async () => {
    const picker = await storeLevelPicker([
      { storeId: 'store-a', storeName: '九江爱琴海店', closed: true },
      { storeId: 'store-b', storeName: '九江八里湖店', closed: true },
      { storeId: 'store-c', storeName: '九江蓝湾店' },
    ])
    expect(picker.data.current).toMatchObject({
      scopeType: 'store', marketId: 'mkt-jj', scopeId: 'store-c', scopeName: '九江凤御 · 九江蓝湾店',
    })
  })

  test('全部已关店 → 回落到第一家', async () => {
    const picker = await storeLevelPicker([
      { storeId: 'store-a', storeName: '九江爱琴海店', closed: true },
      { storeId: 'store-b', storeName: '九江八里湖店', closed: true },
    ])
    expect(picker.data.current).toMatchObject({ scopeType: 'store', scopeId: 'store-a' })
  })

  test('无关店标记（旧云函数 / 查询失败不打标）→ 行为不变，取第一家', async () => {
    const picker = await storeLevelPicker([
      { storeId: 'store-a', storeName: '九江爱琴海店' },
      { storeId: 'store-c', storeName: '九江蓝湾店' },
    ])
    expect(picker.data.current).toMatchObject({ scopeType: 'store', scopeId: 'store-a' })
  })

  test('有市场维度权限 → 仍落市场本身，不受关店影响', async () => {
    mocked.mockResolvedValueOnce({
      staffLevel: 'market',
      allowAll: false,
      allowedMarketIds: ['mkt-jj'],
      markets: [{ id: 'mkt-jj', name: '九江凤御', stores: [{ storeId: 'store-a', storeName: '九江爱琴海店', closed: true }] }],
      inactiveStores: [],
    })
    const picker = instantiate()
    await picker.loadOptions()
    picker.onPickMarket({ currentTarget: { dataset: { marketId: 'mkt-jj' } } })
    expect(picker.data.current).toMatchObject({ scopeType: 'market', scopeId: 'mkt-jj' })
  })

  test('已关店门店照常可选（显式点选不被拦截）', async () => {
    const picker = await storeLevelPicker([
      { storeId: 'store-a', storeName: '九江爱琴海店', closed: true },
      { storeId: 'store-c', storeName: '九江蓝湾店' },
    ])
    picker.onPickStore({ currentTarget: { dataset: { storeId: 'store-a' } } })
    expect(picker.data.applied).toMatchObject({ scopeType: 'store', scopeId: 'store-a' })
    expect(picker.events.at(-1)).toMatchObject({ name: 'change', detail: { scopeId: 'store-a', userPicked: true } })
  })
})

describe('scope-picker · 下拉「（已关店）」后缀', () => {
  test('门店行按 item.closed 追加后缀（与 admin 同文案）', () => {
    const wxml = fs.readFileSync(
      path.resolve(__dirname, '../../components/mgmt-scope-picker/mgmt-scope-picker.wxml'),
      'utf8',
    )
    const rows = wxml.match(/bindtap="onPickStore"\s*>([^<]*)<\/view>/g) || []
    // 「全部门店」行 + 门店行，门店行必须带后缀
    expect(rows.some((r) => r.includes("{{ item.storeName }}{{ item.closed ? '（已关店）' : '' }}"))).toBe(true)
  })
})
