/**
 * getDailyOverview 装配逻辑单测（#369）
 *
 * 关注点（SQL 口径由 consistency.daily-overview.test.ts 守护，拆分 / 勾稽由 lib 单测守护）：
 *   1. 取数前先校验 scope（非总部不以 all 取数）
 *   2. 较上期：基期早于范围数据起点 → 基期置 null → 「--」；否则正常出百分比
 *   3. KPI 键与单位
 *
 * Mock 策略：drizzle `sql` 换成「记下模板文本」的假实现，db.execute 按 SQL 特征分发（不按调用顺序，
 * 往 Promise.all 里插查询不会让夹具错位）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

type FakeSql = { text: string; values: unknown[] }

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]): FakeSql => ({ text: strings.join('?'), values }),
    { raw: vi.fn(() => ({ text: '', values: [] })), join: vi.fn(() => ({ text: '', values: [] })) },
  ),
}))

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ requirePermission: vi.fn(), isAdminScope: vi.fn(() => true) }))
vi.mock('@/lib/data-center/scope-sql', () => ({
  scopeFilterSql: vi.fn(() => ({ text: 'SCOPE', values: [] })),
  scopeStoreSkeletonSql: vi.fn(() => ({ text: 'SKELETON', values: [] })),
}))
vi.mock('@/lib/data-center/context', () => ({
  validateScope: vi.fn(),
  resolveScopeName: vi.fn(async () => '全部'),
}))
vi.mock('@/lib/data-center/data-start-query', () => ({ loadStoreDataStarts: vi.fn() }))

import { getDailyOverview } from '../daily-overview'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { validateScope } from '@/lib/data-center/context'
import { loadStoreDataStarts } from '@/lib/data-center/data-start-query'

const STORES = [
  { store_id: 'S1', store_name: '蓝莱店', market_id: 'M1', market_name: '南昌凤御' },
  { store_id: 'S2', store_name: '绿湖店', market_id: 'M1', market_name: '南昌凤御' },
]

/** 按 SQL 特征返回夹具；previous 区间的两条标量查询按日期参数区分 */
function route(previous: { performance: string; service: string }) {
  vi.mocked(db.execute).mockImplementation((async (query: FakeSql) => {
    const text = query.text
    if (text === 'SKELETON') return STORES
    if (text.includes('FROM product_categories')) {
      return [
        { category_id: 'P1', category_name: '招牌', product_kind: null, sort_order: 1, is_valid: true },
        { category_id: 'C1', category_name: '绝对招牌', product_kind: '招牌', sort_order: 1, is_valid: true },
      ]
    }
    if (text.includes('WITH pay AS')) {
      return [
        { kind: 'total', store_id: 'S1', sales_category: null, category_id: null, amount: '200.00' },
        { kind: 'part', store_id: 'S1', sales_category: '自销自耗', category_id: 'C1', amount: '150' },
        { kind: 'part', store_id: 'S1', sales_category: '生态合作', category_id: 'C1', amount: '50' },
      ]
    }
    if (text.includes("sale_order_type = '充值单'")) return [{ store_id: 'S2', amount: '50.00' }]
    if (text.includes('GROUP BY so.store_id, sit.sales_category')) {
      return [{ store_id: 'S1', sales_category: '他销他耗', amount: '80.00' }]
    }
    if (text.includes("IN ('销售单', '转换单', '充值单')")) return [{ v: previous.performance }]
    if (text.includes('SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v')) return [{ v: previous.service }]
    throw new Error(`未预期的 SQL：${text.slice(0, 80)}`)
  }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-25T10:00:00+08:00'))
  vi.mocked(getSession).mockResolvedValue({ employeeId: 'e1', roles: [], permissions: { actions: [], scopeStoreIds: [] } } as never)
  vi.mocked(loadStoreDataStarts).mockResolvedValue({
    S1: { performance: '2026-07-08', service: '2026-07-08' },
    S2: { performance: '2026-08-08', service: '2026-08-01' },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getDailyOverview', () => {
  it('默认上月（2026-08）：基期 2026-07 早于范围起点 07-08 → 较上期「--」，不出割点伪增幅', async () => {
    route({ performance: '100.00', service: '100.00' })
    const result = await getDailyOverview({})

    expect(result.period.current).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(result.period.previous).toEqual({ start: '2026-07-01', end: '2026-07-31' })
    expect(result.kpis.performanceTotal).toEqual({ value: 250, mom: { kind: 'na' }, unit: 'amount' })
    expect(result.kpis.serviceTotal).toEqual({ value: 80, mom: { kind: 'na' }, unit: 'amount' })
  })

  it('基期不早于范围起点：正常算较上期（业绩按业绩轴、服务按服务轴）', async () => {
    route({ performance: '125.00', service: '160.00' })
    const result = await getDailyOverview({ period: 'custom', start: '2026-09-01', end: '2026-09-24' })

    expect(result.period.previous).toEqual({ start: '2026-08-08', end: '2026-08-31' })
    expect(result.kpis.performanceTotal.mom).toEqual({ kind: 'pct', value: 1 })
    expect(result.kpis.serviceTotal.mom).toEqual({ kind: 'pct', value: -0.5 })
    // 基期查询用的是基期区间
    const previousCalls = vi.mocked(db.execute).mock.calls
      .map(([query]) => query as unknown as FakeSql)
      .filter((query) => query.values.includes('2026-08-08'))
    expect(previousCalls).toHaveLength(2)
  })

  it('数据起点取数失败：较上期降级为「--」，页面照常出数', async () => {
    route({ performance: '125.00', service: '160.00' })
    vi.mocked(loadStoreDataStarts).mockRejectedValueOnce(new Error('statement timeout'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await getDailyOverview({ period: 'custom', start: '2026-09-01', end: '2026-09-24' })

    expect(result.kpis.performanceTotal).toEqual({ value: 250, mom: { kind: 'na' }, unit: 'amount' })
    expect(result.kpis.serviceTotal.mom).toEqual({ kind: 'na' })
  })

  it('KPI：占比分母含充值，平均单店业绩按门店行数（含零业绩门店）', async () => {
    route({ performance: '0', service: '0' })
    const result = await getDailyOverview({})

    expect(result.storeCount).toBe(2)
    expect(result.kpis.selfShare).toEqual({ value: 150 / 250, unit: 'percent' })
    expect(result.kpis.ecoShare).toEqual({ value: 50 / 250, unit: 'percent' })
    expect(result.kpis.averagePerStore).toEqual({ value: 125, unit: 'amount' })
    expect(result.scope).toEqual({ type: 'all', name: '全部' })
  })

  it('先校验 scope：越权直接抛出，不取数', async () => {
    route({ performance: '0', service: '0' })
    vi.mocked(validateScope).mockRejectedValueOnce(new Error('PERMISSION_DENIED: 越权访问其他市场数据'))

    await expect(getDailyOverview({ scope: 'market', scopeId: 'M9' })).rejects.toThrow('PERMISSION_DENIED')
    expect(validateScope).toHaveBeenCalledWith(expect.anything(), { type: 'market', id: 'M9' })
    expect(db.execute).not.toHaveBeenCalled()
  })
})
