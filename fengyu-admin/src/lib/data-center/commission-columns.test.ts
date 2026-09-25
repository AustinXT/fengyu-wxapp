import { describe, expect, it } from 'vitest'
import {
  buildCommissionDailyColumns,
  buildCommissionDetailColumns,
  commissionDailyTotalsMap,
  commissionTotalsLabel,
  parseCommissionSort,
  sortCommissionDailyRows,
  DEFAULT_COMMISSION_SORT,
} from './commission-columns'
import type { CommissionDailyRow, CommissionDailyTotals } from './commission-daily'
import { buildMatrixHeaderLayout, computeFrozenPositions } from './matrix'
import { countLeftFrozen, toWorkerExportColumns } from './matrix-export'

function row(key: string, name: string, days: Record<string, [number, number, number]>, extra: Partial<CommissionDailyRow> = {}): CommissionDailyRow {
  const cells = Object.fromEntries(Object.entries(days).map(([d, [sale, service, orders]]) => [d, { sale, service, orders }]))
  const total = Object.values(cells).reduce((acc, c) => ({ sale: acc.sale + c.sale, service: acc.service + c.service, orders: acc.orders + c.orders }), { sale: 0, service: 0, orders: 0 })
  return {
    key, employeeId: key.split('|')[0], employeeName: name, positionName: '美容师', storeId: 'S1', storeName: '蓝莱店',
    storeCount: 1, employeeCount: 1, days: cells, total, ...extra,
  }
}

const TODAY = '2026-09-25'

describe('buildCommissionDailyColumns', () => {
  it('提成合计视图：左冻结 姓名/岗位/门店，每天一列，右冻结「本期合计」；周末列标记', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'total', grain: 'employee-store', today: TODAY })
    expect(columns.slice(0, 3).map((c) => c.header)).toEqual(['姓名', '岗位', '门店'])
    expect(columns.filter((c) => c.day && c.day !== 'total')).toHaveLength(31)
    expect(columns.at(-1)).toMatchObject({ key: 'total', header: '本期合计', freeze: 'right' })
    // 2026-08-01 是周六
    expect(columns.find((c) => c.key === 'd:2026-08-01')?.weekend).toBe(true)
    expect(columns.find((c) => c.key === 'd:2026-08-03')?.weekend).toBe(false)
    expect(() => computeFrozenPositions(columns)).not.toThrow()
    expect(countLeftFrozen(columns)).toBe(3)
  })

  it('双列视图：每天拆「业绩 / 消耗」两列、表头两行，右侧合计同样拆两列', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'split', grain: 'employee-store', today: TODAY })
    const layout = buildMatrixHeaderLayout(columns)
    expect(layout.depth).toBe(2)
    expect(columns.filter((c) => c.group?.key === 'day:2026-08-02').map((c) => c.header)).toEqual(['业绩', '消耗'])
    expect(columns.filter((c) => c.freeze === 'right').map((c) => c.key)).toEqual(['total:sale', 'total:service'])
    expect(() => computeFrozenPositions(columns)).not.toThrow()
  })

  it('仅业绩 / 仅消耗：取对应部分', () => {
    const r = row('E1|S1', '张三', { '2026-08-02': [10, 20, 1] })
    const sale = buildCommissionDailyColumns({ month: '2026-08', view: 'sale', grain: 'employee-store', today: TODAY })
    const service = buildCommissionDailyColumns({ month: '2026-08', view: 'service', grain: 'employee-store', today: TODAY })
    expect(sale.find((c) => c.key === 'd:2026-08-02')?.value?.(r)).toBe(10)
    expect(service.find((c) => c.key === 'd:2026-08-02')?.value?.(r)).toBe(20)
    expect(sale.find((c) => c.key === 'total')?.value?.(r)).toBe(10)
  })

  it('2026-07：07-01~07-07 早于数据起点照常显示 0（不是空），未来日期留空', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-09', view: 'total', grain: 'employee-store', today: TODAY })
    const r = row('E1|S1', '张三', {})
    expect(columns.find((c) => c.key === 'd:2026-09-25')?.value?.(r)).toBe(0)
    expect(columns.find((c) => c.key === 'd:2026-09-26')?.value?.(r)).toBeNull()

    const july = buildCommissionDailyColumns({ month: '2026-07', view: 'total', grain: 'employee-store', today: TODAY })
    for (let day = 1; day <= 7; day += 1) {
      expect(july.find((c) => c.key === `d:2026-07-0${day}`)?.value?.(r)).toBe(0)
    }
  })

  it('岗位视图：左冻结 岗位 / 人数，人数合计取服务端去重人数', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'total', grain: 'position', today: TODAY })
    expect(columns.slice(0, 2).map((c) => c.header)).toEqual(['岗位', '人数'])
    expect(columns[1].aggregate).toEqual({ kind: 'server' })
  })
})

describe('表尾合计与导出', () => {
  const totals: CommissionDailyTotals = {
    days: { '2026-08-02': { sale: 10, service: 20, orders: 2 }, '2026-08-03': { sale: -5, service: 0, orders: 1 } },
    total: { sale: 5, service: 20, orders: 3 },
    employeeCount: 2,
    rowCount: 3,
  }

  it('按日合计 / 本期合计取自服务端合计（列取值函数作用在合计伪行上）', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'split', grain: 'employee-store', today: TODAY })
    const map = commissionDailyTotalsMap(columns, totals)
    expect(map['d:2026-08-02:sale']).toBe(10)
    expect(map['d:2026-08-03:sale']).toBe(-5)
    expect(map['d:2026-08-04:service']).toBe(0)
    expect(map['total:sale']).toBe(5)
    expect(map['total:service']).toBe(20)
    // 文字列不出合计
    expect(Object.prototype.hasOwnProperty.call(map, 'name')).toBe(false)
  })

  it('表尾标签：按员工「合计（N 人）」按去重员工数，按岗位「合计（N 个岗位）」', () => {
    expect(commissionTotalsLabel('employee-store', totals)).toBe('合计（2 人）')
    expect(commissionTotalsLabel('position', totals)).toBe('合计（3 个岗位）')
  })

  it('导出列与页面同源：表头、分组、冻结、合计值一致，金额写原始数值', () => {
    const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'split', grain: 'employee-store', today: TODAY })
    const exported = toWorkerExportColumns(columns, commissionDailyTotalsMap(columns, totals))
    expect(exported.map((c) => c.header).slice(0, 5)).toEqual(['姓名', '岗位', '门店', '业绩', '消耗'])
    expect(exported[3].group).toEqual({ key: 'day:2026-08-01', header: '1日' })
    expect(exported.find((c) => c.header === '业绩' && c.group?.key === 'day:2026-08-03')?.total).toBe(-5)
    const r = row('E1|S1', '张三', { '2026-08-01': [12.345, 0, 1] })
    expect(exported[0].value(r)).toBe('张三')
    expect(exported[3].value(r)).toBe(12.35)
  })
})

describe('排序', () => {
  const columns = buildCommissionDailyColumns({ month: '2026-08', view: 'total', grain: 'employee-store', today: TODAY })

  it('默认按本期提成合计降序；非法 / 不存在的列回落默认', () => {
    expect(parseCommissionSort({}, columns)).toEqual(DEFAULT_COMMISSION_SORT)
    expect(parseCommissionSort({ sort: 'd:2026-09-01' }, columns)).toEqual(DEFAULT_COMMISSION_SORT)
    expect(parseCommissionSort({ sort: 'name', dir: 'asc' }, columns)).toEqual({ key: 'name', direction: 'asc' })
  })

  it('同值按行键兜底（#282），负数排在 0 之后', () => {
    const rows = [
      row('E3|S1', '王五', { '2026-08-01': [0, 0, 1] }),
      row('E2|S1', '李四', { '2026-08-01': [-5, 0, 1] }),
      row('E1|S2', '张三', { '2026-08-01': [0, 0, 1] }),
      row('E1|S1', '张三', { '2026-08-01': [10, 0, 1] }),
    ]
    expect(sortCommissionDailyRows(rows, columns, DEFAULT_COMMISSION_SORT).map((r) => r.key)).toEqual(['E1|S1', 'E1|S2', 'E3|S1', 'E2|S1'])
  })

  it('双列视图下默认键不是列 key，仍按行的提成合计排', () => {
    const split = buildCommissionDailyColumns({ month: '2026-08', view: 'split', grain: 'employee-store', today: TODAY })
    const rows = [row('E1|S1', '张三', { '2026-08-01': [0, 1, 1] }), row('E2|S1', '李四', { '2026-08-01': [5, 0, 1] })]
    expect(sortCommissionDailyRows(rows, split, DEFAULT_COMMISSION_SORT).map((r) => r.key)).toEqual(['E2|S1', 'E1|S1'])
  })
})

describe('buildCommissionDetailColumns', () => {
  it('字段顺序与 issue 一致；限定员工时不出员工列', () => {
    expect(buildCommissionDetailColumns({ showEmployee: false }).map((c) => c.header)).toEqual([
      '门店', '日期', '订单号', '顾客姓名', '订单类型', '项目名称', '实收金额', '消耗额', '分配金额', '提成点', '提成', '提成类型',
    ])
    expect(buildCommissionDetailColumns({ showEmployee: true }).map((c) => c.header)).toContain('员工')
  })

  it('合计只来自服务端：消耗额（服务行专有）不出合计，提成点合计为平均提成点', () => {
    const columns = buildCommissionDetailColumns({ showEmployee: false })
    expect(columns.find((c) => c.key === 'consume')?.aggregate).toBeUndefined()
    expect(columns.find((c) => c.key === 'rate')?.aggregate).toEqual({ kind: 'server' })
    const exported = toWorkerExportColumns(columns, { received: 1, allocated: 2, commission: 3, rate: 0.05 })
    expect(exported.find((c) => c.header === '提成点(%)')?.total).toBe(5)
  })
})
