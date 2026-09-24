import { describe, expect, it } from 'vitest'
import { countLeftFrozen, toWorkerExportColumns, type MatrixExportColumnSpec } from './matrix-export'

interface Row { name: string; sales: number | null; rate: number | null; visits: number }

const COLUMNS: MatrixExportColumnSpec<Row>[] = [
  { key: 'name', header: '顾客', width: 120, freeze: 'left', exportValue: (r) => r.name, exportWidth: 20 },
  { key: 'sales', header: '业绩', group: { key: 'd1', header: '1日' }, value: (r) => r.sales, aggregate: { kind: 'sum' } },
  { key: 'rate', header: '付清率', unit: 'percent', group: { key: 'd1', header: '1日' }, value: (r) => r.rate },
  { key: 'visits', header: '到店', unit: 'count', value: (r) => r.visits, aggregate: { kind: 'server' } },
]

describe('toWorkerExportColumns', () => {
  const columns = toWorkerExportColumns(COLUMNS, { sales: '1234.567' as unknown as number, rate: 0.12345, visits: 7 })
  const row: Row = { name: '张三', sales: 100.456, rate: 0.5, visits: 2.4 }

  it('表头 / 分组 / 数字格式与页面同源：占比表头追加 (%)，维度列不加格式', () => {
    expect(columns.map((c) => c.header)).toEqual(['顾客', '业绩', '付清率(%)', '到店'])
    expect(columns.map((c) => c.group?.key)).toEqual([undefined, 'd1', 'd1', undefined])
    expect(columns.map((c) => c.numFmt)).toEqual([undefined, '#,##0.00', '0.00', '#,##0'])
    expect(columns[0].width).toBe(20)
  })

  it('数据写原始数值（金额 2 位、占比转百分数、计数取整），维度列用 exportValue', () => {
    expect(columns.map((c) => c.value(row))).toEqual(['张三', 100.46, 50, 2])
    expect(columns[1].value({ ...row, sales: null })).toBe('')
  })

  it('合计只取服务端值并按单位转换（含字符串 numeric）；没给的列不写', () => {
    expect(columns.map((c) => c.total)).toEqual([undefined, 1234.57, 12.35, 7])
    const withoutTotals = toWorkerExportColumns(COLUMNS)
    expect(withoutTotals.every((c) => !('total' in c))).toBe(true)
  })
})

describe('countLeftFrozen', () => {
  it('只数左侧冻结前缀', () => {
    expect(countLeftFrozen(COLUMNS)).toBe(1)
    expect(countLeftFrozen([{ key: 'a' }, { key: 'b', freeze: 'left' }])).toBe(0)
  })
})
