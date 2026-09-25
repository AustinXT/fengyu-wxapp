import { describe, expect, it } from 'vitest'
import {
  assembleCommissionMatrix,
  cellTotal,
  commissionDetailHref,
  commissionExportParams,
  commissionFilterSignature,
  compareCommissionKeys,
  decodeCommissionCursor,
  encodeCommissionCursor,
  grainOf,
  parseCommissionDailyOptions,
  parseCommissionDetailFilters,
  parseCommissionDetailPageSize,
  type CommissionAggregateRecord,
  type CommissionDetailKey,
} from './commission-daily'

const AUG = { start: '2026-08-01', end: '2026-08-31' }

function record(partial: Partial<CommissionAggregateRecord>): CommissionAggregateRecord {
  return {
    gk: null, d: null, sale: '0', service: '0', orders: '0', employees: '0', stores: '0',
    employee_id: null, employee_name: null, position_name: null, store_id: null, store_name: null,
    g_gk: 0, g_d: 0,
    ...partial,
  }
}

describe('parseCommissionDailyOptions', () => {
  it('缺省：提成合计视图、按员工、不合并、不搜索、不隐藏 0 行（☆ 默认关）', () => {
    expect(parseCommissionDailyOptions({})).toEqual({ view: 'total', group: 'employee', merge: false, search: '', hideZero: false })
  })

  it('非法值回落默认，重复 key 取第一个，搜索词去空白并截断', () => {
    const options = parseCommissionDailyOptions({ view: ['split', 'sale'], group: 'bogus', merge: '1', q: `  ${'张'.repeat(80)}  `, hideZero: '1' })
    expect(options.view).toBe('split')
    expect(options.group).toBe('employee')
    expect(options.merge).toBe(true)
    expect(options.search).toHaveLength(50)
    expect(options.hideZero).toBe(true)
  })
})

describe('grainOf', () => {
  it('「按员工合并」只在总部（全部）范围生效', () => {
    expect(grainOf({ group: 'employee', merge: true }, true)).toBe('employee')
    expect(grainOf({ group: 'employee', merge: true }, false)).toBe('employee-store')
    expect(grainOf({ group: 'employee', merge: false }, true)).toBe('employee-store')
  })

  it('按岗位汇总优先于合并开关', () => {
    expect(grainOf({ group: 'position', merge: true }, true)).toBe('position')
  })
})

describe('assembleCommissionMatrix · 三层勾稽', () => {
  // 张三在 S1、S2 两店；李四只有 S1，08-03 有一笔退款冲销（业绩为负）
  const records: CommissionAggregateRecord[] = [
    record({ gk: 'E1|S1', d: '2026-08-01', sale: '100.10', service: '20.00', orders: '2' }),
    record({ gk: 'E1|S1', d: '2026-08-02', sale: '0', service: '30.05', orders: '1' }),
    record({ gk: 'E1|S2', d: '2026-08-02', sale: '0', service: '0', orders: '1' }),
    record({ gk: 'E2|S1', d: '2026-08-03', sale: '-50.00', service: '0', orders: '1' }),
    record({ gk: 'E1|S1', g_d: 1, sale: '100.10', service: '50.05', orders: '3', employees: '1', stores: '1', employee_id: 'E1', employee_name: '张三', position_name: '美容师', store_id: 'S1', store_name: '蓝莱店' }),
    record({ gk: 'E1|S2', g_d: 1, sale: '0', service: '0', orders: '1', employees: '1', stores: '1', employee_id: 'E1', employee_name: '张三', position_name: '美容师', store_id: 'S2', store_name: '绿湖店' }),
    record({ gk: 'E2|S1', g_d: 1, sale: '-50.00', service: '0', orders: '1', employees: '1', stores: '1', employee_id: 'E2', employee_name: '李四', position_name: null, store_id: 'S1', store_name: '蓝莱店' }),
    record({ g_gk: 1, d: '2026-08-01', sale: '100.10', service: '20.00', orders: '2' }),
    record({ g_gk: 1, d: '2026-08-02', sale: '0', service: '30.05', orders: '2' }),
    record({ g_gk: 1, d: '2026-08-03', sale: '-50.00', service: '0', orders: '1' }),
    record({ g_gk: 1, g_d: 1, sale: '50.10', service: '50.05', orders: '5', employees: '2' }),
  ]

  it('格子 / 行合计 / 表尾按日合计 / 右下总计 逐分勾稽（含负数格）', () => {
    const { rows, totals } = assembleCommissionMatrix(records, 'employee-store')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const sumOfCells = Object.values(row.days).reduce((sum, cell) => sum + cellTotal(cell), 0)
      expect(sumOfCells).toBeCloseTo(cellTotal(row.total), 10)
    }
    for (const [day, cell] of Object.entries(totals.days)) {
      const column = rows.reduce((sum, row) => sum + cellTotal(row.days[day]), 0)
      expect(column).toBeCloseTo(cellTotal(cell), 10)
    }
    expect(rows.reduce((sum, row) => sum + cellTotal(row.total), 0)).toBeCloseTo(cellTotal(totals.total), 10)
    expect(cellTotal(totals.total)).toBeCloseTo(100.15, 10)
    expect(totals.employeeCount).toBe(2)
    expect(totals.rowCount).toBe(3)
  })

  it('0 提成行照常保留（不做 >0 过滤），负数格保留原值', () => {
    const { rows } = assembleCommissionMatrix(records, 'employee-store')
    expect(rows.find((row) => row.key === 'E1|S2')?.total).toEqual({ sale: 0, service: 0, orders: 1 })
    expect(rows.find((row) => row.key === 'E2|S1')?.days['2026-08-03'].sale).toBe(-50)
  })

  it('行属性：员工 × 门店视图带门店，无岗位回落「（无岗位）」', () => {
    const { rows } = assembleCommissionMatrix(records, 'employee-store')
    expect(rows.find((row) => row.key === 'E1|S2')).toMatchObject({ employeeId: 'E1', employeeName: '张三', storeId: 'S2', storeName: '绿湖店' })
    expect(rows.find((row) => row.key === 'E2|S1')?.positionName).toBe('（无岗位）')
  })

  it('合并视图：多店行门店列显示「多店（N）」且不带 storeId（下钻不限门店）', () => {
    const { rows } = assembleCommissionMatrix([
      record({ gk: 'E1', g_d: 1, sale: '1', service: '2', orders: '2', employees: '1', stores: '2', employee_id: 'E1', employee_name: '张三', position_name: '美容师', store_id: 'S1', store_name: '蓝莱店' }),
    ], 'employee')
    expect(rows[0]).toMatchObject({ employeeId: 'E1', storeId: null, storeName: '多店（2）', storeCount: 2 })
  })

  it('岗位视图：行名 = 岗位，第二列人数取去重员工数，不带员工 id（不能下钻）', () => {
    const { rows } = assembleCommissionMatrix([
      record({ gk: '美容师', g_d: 1, sale: '1', service: '2', orders: '3', employees: '4', stores: '2', employee_id: 'E1', position_name: '美容师' }),
    ], 'position')
    expect(rows[0]).toMatchObject({ employeeName: '美容师', positionName: '美容师', employeeCount: 4, employeeId: null })
  })
})

describe('明细筛选', () => {
  it('当日参数必须在所选月份内，否则按全月；类型只认 sale / service', () => {
    expect(parseCommissionDetailFilters({ date: '2026-08-15', type: 'service' }, AUG)).toMatchObject({ date: '2026-08-15', source: 'service' })
    expect(parseCommissionDetailFilters({ date: '2026-09-01', type: 'x' }, AUG)).toMatchObject({ date: null, source: null })
    expect(parseCommissionDetailFilters({ date: '2026-08-32' }, AUG).date).toBeNull()
  })

  it('员工 / 门店 id 照原值过滤（只截长度），不合法的不放宽成「全部」；空串视为未指定', () => {
    expect(parseCommissionDetailFilters({ employeeId: 'FY-260728032', storeId: 'S1' }, AUG)).toMatchObject({ employeeId: 'FY-260728032', storeId: 'S1' })
    expect(parseCommissionDetailFilters({ employeeId: "E1' OR 1=1" }, AUG).employeeId).toBe("E1' OR 1=1")
    expect(parseCommissionDetailFilters({ employeeId: 'x'.repeat(200) }, AUG).employeeId).toHaveLength(80)
    expect(parseCommissionDetailFilters({ employeeId: '  ' }, AUG).employeeId).toBeNull()
  })

  it('每页条数白名单，缺省 50', () => {
    expect(parseCommissionDetailPageSize('100')).toBe(100)
    expect(parseCommissionDetailPageSize('2.5')).toBe(50)
    expect(parseCommissionDetailPageSize(undefined)).toBe(50)
  })
})

describe('明细 keyset 游标', () => {
  const signature = commissionFilterSignature({ scope: 'all', month: '2026-08', employeeId: 'E1' })

  it('编解码往返，签名不符 / 损坏 / 字段非法一律回到第一页（null）', () => {
    const key: CommissionDetailKey = { d: '2026-08-02', t: 'service', id: 12345 }
    const cursor = encodeCommissionCursor(key, signature)
    expect(decodeCommissionCursor(cursor, signature)).toEqual(key)
    expect(decodeCommissionCursor(cursor, commissionFilterSignature({ scope: 'all', month: '2026-07', employeeId: 'E1' }))).toBeNull()
    expect(decodeCommissionCursor('not-base64!!', signature)).toBeNull()
    expect(decodeCommissionCursor(encodeCommissionCursor({ d: '2026-08-02', t: 'bogus' as never, id: 1 }, signature), signature)).toBeNull()
    expect(decodeCommissionCursor(encodeCommissionCursor({ d: '2026-08-02', t: 'sale', id: -1 }, signature), signature)).toBeNull()
  })

  it('签名与参数顺序无关', () => {
    expect(commissionFilterSignature({ b: '2', a: '1' })).toBe(commissionFilterSignature({ a: '1', b: '2' }))
  })

  it('排序 (日期 DESC, 来源类型, 主键 DESC)：两表撞号的 id 靠来源类型区分，全序无并列', () => {
    const keys: CommissionDetailKey[] = [
      { d: '2026-08-01', t: 'sale', id: 7 },
      { d: '2026-08-02', t: 'service', id: 7 },
      { d: '2026-08-02', t: 'sale', id: 7 },
      { d: '2026-08-02', t: 'sale', id: 9 },
    ]
    const sorted = [...keys].sort(compareCommissionKeys)
    expect(sorted).toEqual([
      { d: '2026-08-02', t: 'sale', id: 9 },
      { d: '2026-08-02', t: 'sale', id: 7 },
      { d: '2026-08-02', t: 'service', id: 7 },
      { d: '2026-08-01', t: 'sale', id: 7 },
    ])
    for (let i = 1; i < sorted.length; i += 1) expect(compareCommissionKeys(sorted[i - 1], sorted[i])).toBeLessThan(0)
  })
})

describe('下钻链接与导出参数', () => {
  it('员工 × 门店行：带 scope、月份、员工、门店、日期、类型与 returnTo', () => {
    const href = commissionDetailHref({
      scope: 'market', scopeId: 'M1', month: '2026-08', employeeId: 'E1', storeId: 'S1',
      date: '2026-08-02', source: 'sale', returnTo: '/data-center/commission-daily?month=2026-08',
    })
    const url = new URL(href, 'http://x')
    expect(url.pathname).toBe('/data-center/commission-daily/detail')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'market', scopeId: 'M1', month: '2026-08', employeeId: 'E1', storeId: 'S1',
      date: '2026-08-02', type: 'sale', returnTo: '/data-center/commission-daily?month=2026-08',
    })
  })

  it('合并视图不带门店', () => {
    expect(commissionDetailHref({ month: '2026-08', employeeId: 'E1', storeId: null })).not.toContain('storeId')
  })

  it('导出参数剔除游标 / 分页 / returnTo（returnTo 可能超过导出参数 240 字上限）', () => {
    expect(commissionExportParams([
      ['month', '2026-08'], ['after', 'abc'], ['before', 'x'], ['size', '100'], ['returnTo', '/x'.repeat(200)], ['type', 'sale'], ['q', ''],
    ])).toEqual({ month: '2026-08', type: 'sale' })
  })

  it('导出的搜索词与页面同一截断（50 字）', () => {
    expect(commissionExportParams([['q', `  ${'张'.repeat(80)}  `]]).q).toHaveLength(50)
  })
})
