import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  localExecute: vi.fn(),
  transaction: vi.fn(),
  series: vi.fn(),
  marketNewCustomers: vi.fn(),
}))
vi.mock('@/db', () => ({ db: { execute: state.execute, transaction: state.transaction } }))
vi.mock('./operating-series', () => ({ series: state.series, marketNewCustomers: state.marketNewCustomers }))
vi.mock('./operating-objects', () => ({
  directory: async () => ({
    stores: [{ id: 's1', name: '门店', market_id: 'm1', area: '市场' }],
    people: [{ employeeId: 'e1', name: '员工', storeId: 's1' }],
    fullMarkets: ['m1'],
  }),
  participantObjects: () => [{ scope: 'personal', scopeId: 'e1', employeeId: 'e1' }],
}))
import { resolve as resolvePeriod, workspace } from './workspace'
import type { AuthSession } from '@/lib/types'

const period = {
  id: 'p1', name: '经营月', start_date: '2026-10-01', end_date: '2026-10-28', version: 1,
  weeks: [0, 1, 2, 3].map(i => ({
    id: `w${i + 1}`, name: `第${i + 1}周`,
    start: `2026-10-${String(i * 7 + 1).padStart(2, '0')}`,
    end: `2026-10-${String(i * 7 + 7).padStart(2, '0')}`,
  })),
}
const session = {
  employeeId: 'e1', roles: [{ role: 'admin', scopeType: '总部', isSuperAdmin: true }],
  permissions: { actions: ['data_center:dashboard'], scopeStoreIds: ['s1'] },
} as AuthSession
const dialect = new PgDialect()
const text = (statement: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(statement).sql
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T04:00:00Z'))
  state.execute.mockImplementation(async statement => {
    const sql = text(statement)
    if (sql.startsWith('SELECT * FROM daily_operating_periods')) return [period]
    if (sql.startsWith('SELECT id,name')) return [{ id: 'p1', name: '经营月' }]
    if (sql === 'SELECT store_id FROM stores') return [{ store_id: 's1' }]
    return []
  })
  state.localExecute.mockResolvedValue([])
  state.transaction.mockImplementation(async callback => callback({ execute: state.localExecute }))
  state.series.mockResolvedValue([{ scope: 'personal', id: 'e1', date: '2026-10-04', sales: 100, visits: 1 }])
  state.marketNewCustomers.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('经营页面按需统计与事务内查询设置', () => {
  it('门店周期快照优先于重叠的旧全局周期', async () => {
    const result = await resolvePeriod(async () => [
      { ...period, id: 'legacy', region_id: null },
      { ...period, id: 'regional', region_id: 'm1' },
    ], { date: '2026-10-04' }, 'm2', 's1')
    expect(result.period?.id).toBe('regional')
  })
  it('个人进度保留统计值，JIT 设置仅在统计事务内执行', async () => {
    const result = await workspace(session)
    expect(result.rows[0].values.sales.monthDone).toBe(100)
    expect(result.rows[0].values.visits.weekDone).toBe(1)
    expect(state.transaction).toHaveBeenCalledTimes(1)
    expect(state.localExecute.mock.calls.map(([sql]) => text(sql))).toEqual(['SET LOCAL jit = off'])
    expect(state.execute.mock.calls.map(([sql]) => text(sql))).not.toContain('SET LOCAL jit = off')
    expect(state.marketNewCustomers).not.toHaveBeenCalled()
    expect(state.execute.mock.calls.map(([sql]) => text(sql)).some(sql => sql.startsWith('SELECT * FROM daily_pk_stores'))).toBe(false)
  })
  it('市场进度仍按顾客去重读取市场新客', async () => {
    await workspace(session, { dimension: 'market' })
    expect(state.marketNewCustomers).toHaveBeenCalledTimes(1)
  })
  it('填报元数据不触发实际统计，越权筛选先被拒绝', async () => {
    await workspace(session, {}, false, true)
    expect(state.transaction).not.toHaveBeenCalled()
    expect(state.series).not.toHaveBeenCalled()
    await expect(workspace(session, { storeId: 'outside' })).rejects.toThrow('PERMISSION_DENIED')
    expect(state.transaction).not.toHaveBeenCalled()
  })
})
