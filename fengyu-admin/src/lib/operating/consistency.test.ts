import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { resolve as pathResolve } from 'node:path'
import { series, marketNewCustomers } from './operating-series'
import { directory, participantObjects } from './operating-objects'
import { buildRows } from './operating-rows'
import { expand } from './target-write'
import * as rules from './operating-target'
const require = createRequire(import.meta.url)
const cloud = (name: string) =>
  require(
    pathResolve(
      process.cwd(),
      '../fengyu-daily/cloudfunctions/dailyApi/utils/' + name,
    ),
  )
const period = {
  start: '2026-09-26',
  end: '2026-10-25',
  weeks: [
    { id: 'a', start: '2026-09-26', end: '2026-10-03' },
    { id: 'b', start: '2026-10-04', end: '2026-10-10' },
    { id: 'c', start: '2026-10-11', end: '2026-10-17' },
    { id: 'd', start: '2026-10-18', end: '2026-10-25' },
  ],
}
const stores = [
  { id: 's1', market_id: 'm1', name: '门店1', area: '南昌' },
  { id: 's2', market_id: 'm1', name: '门店2', area: '南昌' },
]
describe('日报和Web独立实现口径守护', () => {
  it('统计SQL、参数与有效服务过滤完全一致', async () => {
    const capture = async (fn: any) => {
      const calls: any[] = []
      await fn(async (text: string, args: unknown[]) => {
        calls.push([text.replace(/\s+/g, ' ').trim(), args])
        return []
      })
      return calls
    }
    const options = {
      storeIds: ['s1'],
      employeeIds: ['e1'],
      start: period.start,
      end: period.end,
    }
    expect(await capture((q: any) => series(q, options))).toEqual(
      await capture((q: any) => cloud('operating-series').series(q, options)),
    )
    expect(
      await capture((q: any) =>
        marketNewCustomers(q, ['s1'], period.start, period.end),
      ),
    ).toEqual(
      await capture((q: any) =>
        cloud('operating-series').marketNewCustomers(
          q,
          ['s1'],
          period.start,
          period.end,
        ),
      ),
    )
    expect(await capture((q: any) => directory(q, ['s1']))).toEqual(
      await capture((q: any) =>
        cloud('operating-objects').directory(q, ['s1']),
      ),
    )
  })
  it('岗位映射范围一致，无门店总监不自动归入其他门店或班级', () => {
    const people = [
      { employeeId: 'e', storeId: 's1' },
      { employeeId: 'boss', storeId: 's1', manager: true },
      { employeeId: 'director', market_id: 'm1' },
      { employeeId: 'assignedDirector', storeId: 's1', market_id: 'm1' },
      { employeeId: 'none' },
    ]
    const dir = { stores, people, fullMarkets: ['m1'] },
      assignments = [
        { store_id: 's1', class_id: 'c1' },
        { store_id: 's2', class_id: 'c2' },
      ]
    expect(participantObjects(dir, assignments)).toEqual(
      cloud('operating-objects').participantObjects(dir, assignments),
    )
    expect(
      participantObjects(dir, assignments).map((p: any) => p.scope),
    ).toEqual(['personal', 'store', 'market'])
    const partial = { ...dir, fullMarkets: [] }
    expect(
      participantObjects(partial, assignments).some(
        (p: any) => p.scope === 'market',
      ),
    ).toBe(false)
  })
  it('五项余额、零与未设置、日期分解及金额精度保持一致', () => {
    const target = {
      scope: 'store',
      scope_id: 's1',
      month_confirmed: true,
      sales: 10001,
      consumption: 20000,
      visits: 10,
      new_customers: 0,
      projects: null,
      weeks: {
        a: { sales: 2000, consumption: 1000, visits: 2, newCustomers: 0 },
        b: { sales: 3000, consumption: 2000, visits: 3, newCustomers: 0 },
        c: { sales: 4000, consumption: 3000, visits: 4, newCustomers: 0 },
      },
    }
    const cloudExpand = require(
      pathResolve(
        process.cwd(),
        '../fengyu-daily/cloudfunctions/dailyApi/routes/target.js',
      ),
    ).expand
    expect(expand(target, period)).toEqual(cloudExpand(target, period))
    const objects = [{ scope: 'store', scopeId: 's1' }],
      events = [
        {
          scope: 'store',
          id: 's1',
          date: '2026-10-03',
          sales: 5000,
          consumption: 6000,
          visits: 1,
          newCustomers: 0,
          projects: 2,
        },
      ]
    const rows = buildRows(
      objects,
      events,
      [target],
      period,
      period.weeks[0],
      '2026-10-04',
      expand,
    )
    expect(rows).toEqual(
      cloud('operating-rows').buildRows(
        objects,
        events,
        [target],
        period,
        period.weeks[0],
        '2026-10-04',
        cloudExpand,
      ),
    )
    expect(rows[0].values.projects.monthTarget).toBe(null)
    expect(rows[0].values.newCustomers.monthTarget).toBe(0)
    for (const value of ['0', '100.01', '999999.99'])
      expect(rules.cents(value)).toBe(cloud('operating-target').cents(value))
  })
})
