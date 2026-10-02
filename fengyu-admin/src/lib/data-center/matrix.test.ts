import { describe, expect, it } from 'vitest'
import {
  buildMatrixHeaderLayout,
  computeFrozenPositions,
  computeMatrixTotals,
  listMonthDays,
  nextMatrixSort,
  sortMatrixRows,
  type MatrixColumnSpec,
} from './matrix'

interface Row {
  id: string
  store: string
  sales: number | null
  paid: number | null
  visits: number | null
  subtotal?: boolean
}

const ROWS: Row[] = [
  { id: 's1', store: '一店', sales: 100, paid: 30, visits: 10 },
  { id: 's2', store: '二店', sales: 300, paid: 60, visits: 30 },
  { id: 'm1', store: '南昌小计', sales: 400, paid: 90, visits: 40, subtotal: true },
  { id: 's3', store: '三店', sales: null, paid: 10, visits: 0 },
]

const COLUMNS: MatrixColumnSpec<Row>[] = [
  { key: 'store', width: 120, freeze: 'left' },
  { key: 'sales', value: (r) => r.sales, aggregate: { kind: 'sum' } },
  { key: 'paid', value: (r) => r.paid, aggregate: { kind: 'sum' } },
  {
    key: 'paidRate',
    // 各行比率的平均是 (0.3 + 0.2) / 2 = 0.25；正确的合计是 90 / 400 = 0.225
    value: (r) => (r.sales ? (r.paid ?? 0) / r.sales : null),
    aggregate: { kind: 'ratio', numerator: (r) => (r.sales == null ? null : r.paid), denominator: (r) => r.sales },
  },
  { key: 'technicians', value: (r) => r.visits, aggregate: { kind: 'server' } },
  { key: 'note' },
]

describe('computeMatrixTotals', () => {
  it('不分页：可加列合计 = 逐行求和，且小计行不参与（否则同一笔钱算两遍）', () => {
    const totals = computeMatrixTotals(COLUMNS, ROWS, { paginated: false, isSubtotal: (r) => !!r.subtotal })
    expect(totals.sales).toBe(400)
    expect(totals.paid).toBe(100)
  })

  it('比率合计 = 合计分子 ÷ 合计分母，不取各行比率的平均', () => {
    const rows = ROWS.filter((r) => !r.subtotal && r.sales != null)
    const totals = computeMatrixTotals(COLUMNS, rows, { paginated: false })
    expect(totals.paidRate).toBeCloseTo(90 / 400, 10)
    expect(totals.paidRate).not.toBeCloseTo(0.25, 5)
  })

  it('比率：分子或分母任一为空的行整行不计入（只计一半会拉偏合计）', () => {
    const rows: Row[] = [
      { id: 'a', store: 'a', sales: 100, paid: 50, visits: 0 },
      { id: 'b', store: 'b', sales: 100, paid: null, visits: 0 }, // 分子空：若分母照计，合计变 50/200
      { id: 'c', store: 'c', sales: null, paid: 30, visits: 0 }, // 分母空：若分子照计，合计变 80/100
    ]
    const columns: MatrixColumnSpec<Row>[] = [
      { key: 'rate', aggregate: { kind: 'ratio', numerator: (r) => r.paid, denominator: (r) => r.sales } },
    ]
    expect(computeMatrixTotals(columns, rows, { paginated: false }).rate).toBe(0.5)
  })

  it('比率分母合计 ≤ 0 → null（与 efficiency.ratio 一致）', () => {
    const columns: MatrixColumnSpec<Row>[] = [
      { key: 'rate', aggregate: { kind: 'ratio', numerator: (r) => r.paid, denominator: (r) => r.sales } },
    ]
    const rows: Row[] = [{ id: 'a', store: 'a', sales: -100, paid: 10, visits: 0 }]
    expect(computeMatrixTotals(columns, rows, { paginated: false }).rate).toBeNull()
  })

  it('服务端合计是 PG numeric 字符串时按数值解析，而不是显示为空', () => {
    const totals = computeMatrixTotals(COLUMNS, [], {
      paginated: true,
      serverTotals: { sales: '1234.50' as unknown as number, paid: '' as unknown as number, technicians: 'abc' as unknown as number },
    })
    expect(totals.sales).toBe(1234.5)
    expect(totals.paid).toBeNull()
    expect(totals.technicians).toBeNull()
  })

  it('比率分母合计为 0 → null，不出 Infinity / NaN', () => {
    const totals = computeMatrixTotals(COLUMNS, [{ id: 'x', store: 'x', sales: 0, paid: 5, visits: 0 }], { paginated: false })
    expect(totals.paidRate).toBeNull()
  })

  it('去重计数列只认服务端口径，不要求等于逐行和', () => {
    const withoutServer = computeMatrixTotals(COLUMNS, ROWS, { paginated: false })
    expect(withoutServer.technicians).toBeNull()
    const withServer = computeMatrixTotals(COLUMNS, ROWS, { paginated: false, serverTotals: { technicians: 7 } })
    expect(withServer.technicians).toBe(7) // 逐行和是 80，服务端去重后 7
  })

  it('分页：只认服务端全量合计，翻页后合计不变；服务端没给的列留空而不是拿本页凑', () => {
    const serverTotals = { sales: 9_999, paid: 1_234, paidRate: 0.1234 }
    const page1 = computeMatrixTotals(COLUMNS, ROWS.slice(0, 2), { paginated: true, serverTotals })
    const page2 = computeMatrixTotals(COLUMNS, ROWS.slice(2), { paginated: true, serverTotals })
    expect(page1).toEqual(page2)
    expect(page1.sales).toBe(9_999)
    expect(page1.technicians).toBeNull()
  })

  it('没有明细行（空数组 / 只有小计行）→ 可加列合计为 null 而不是 0', () => {
    const onlySubtotal = ROWS.filter((r) => r.subtotal)
    expect(computeMatrixTotals(COLUMNS, onlySubtotal, { paginated: false, isSubtotal: (r) => !!r.subtotal }).sales).toBeNull()
    expect(computeMatrixTotals(COLUMNS, [], { paginated: false }).sales).toBeNull()
  })

  it('全空列合计为 null（不伪造 0），none 列恒为 null；服务端非有限值归一为 null', () => {
    const rows: Row[] = [{ id: 'a', store: 'a', sales: null, paid: null, visits: null }]
    const totals = computeMatrixTotals(COLUMNS, rows, { paginated: false, serverTotals: { paid: Number.NaN } })
    expect(totals.sales).toBeNull()
    expect(totals.paid).toBeNull()
    expect(totals.note).toBeNull()
  })
})

describe('buildMatrixHeaderLayout', () => {
  it('无分组 → 单行表头', () => {
    const layout = buildMatrixHeaderLayout([{ key: 'a' }, { key: 'b' }])
    expect(layout.depth).toBe(1)
    expect(layout.rows).toHaveLength(1)
    expect(layout.rows[0].map((c) => [c.key, c.colSpan, c.rowSpan])).toEqual([['a', 1, 1], ['b', 1, 1]])
  })

  it('两行分组：未分组列 rowSpan=2，同组相邻列合并 colSpan，分组首列记分隔线', () => {
    const day = (d: string) => ({ key: d, header: d })
    const layout = buildMatrixHeaderLayout([
      { key: 'name' },
      { key: 'd1-sales', group: day('d1') },
      { key: 'd1-consume', group: day('d1') },
      { key: 'd2-sales', group: day('d2') },
      { key: 'd2-consume', group: day('d2') },
      { key: 'total' },
    ])
    expect(layout.depth).toBe(2)
    expect(layout.rows[0].map((c) => [c.key, c.colSpan, c.rowSpan])).toEqual([
      ['name', 1, 2],
      ['group:d1', 2, 1],
      ['group:d2', 2, 1],
      ['total', 1, 2],
    ])
    expect(layout.rows[1].map((c) => c.key)).toEqual(['d1-sales', 'd1-consume', 'd2-sales', 'd2-consume'])
    expect([...layout.groupStartKeys]).toEqual(['d1-sales', 'd2-sales'])
    // 每一列在两行表头里恰好被覆盖一次：Σ(顶行 colSpan) = 列数，底行 = 分组内列数
    expect(layout.rows[0].reduce((n, c) => n + c.colSpan, 0)).toBe(6)
  })

  it('同名不同 key 的分组不会被合并', () => {
    const layout = buildMatrixHeaderLayout([
      { key: 'a', group: { key: 'g1', header: '合计' } },
      { key: 'b', group: { key: 'g2', header: '合计' } },
    ])
    expect(layout.rows[0].map((c) => c.colSpan)).toEqual([1, 1])
  })

  it('同一分组的列被隔开 → 抛错（拼错的列定义不能静默渲染成错位表头）', () => {
    expect(() => buildMatrixHeaderLayout([
      { key: 'a', group: { key: 'g', header: 'G' } },
      { key: 'b' },
      { key: 'c', group: { key: 'g', header: 'G' } },
    ])).toThrow(/不相邻/)
  })

  it('动态列增删后表头仍与列一一对应', () => {
    const build = (categories: string[]) => buildMatrixHeaderLayout([
      { key: 'customer' },
      ...categories.flatMap((cat) => [
        { key: `${cat}:count`, group: { key: cat, header: cat } },
        { key: `${cat}:amount`, group: { key: cat, header: cat } },
      ]),
    ])
    const before = build(['面部', '身体'])
    const after = build(['面部', '身体', '仪器'])
    expect(before.rows[1].map((c) => c.firstLeafIndex)).toEqual([1, 2, 3, 4])
    expect(after.rows[1].map((c) => c.key)).toEqual([
      '面部:count', '面部:amount', '身体:count', '身体:amount', '仪器:count', '仪器:amount',
    ])
    expect(after.rows[1].map((c) => c.firstLeafIndex)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('computeFrozenPositions', () => {
  it('左前缀累加偏移，右后缀从右边缘累加，最内侧列标 edge', () => {
    const positions = computeFrozenPositions([
      { key: 'a', width: 100, freeze: 'left' },
      { key: 'b', width: 80, freeze: 'left' },
      { key: 'c' },
      { key: 'd', width: 90, freeze: 'right' },
      { key: 'e', width: 70, freeze: 'right' },
    ])
    expect(positions.get('a')).toEqual({ side: 'left', offset: 0, edge: false })
    expect(positions.get('b')).toEqual({ side: 'left', offset: 100, edge: true })
    expect(positions.has('c')).toBe(false)
    expect(positions.get('e')).toEqual({ side: 'right', offset: 0, edge: false })
    expect(positions.get('d')).toEqual({ side: 'right', offset: 70, edge: true })
  })

  it('分组跨越冻结边界 → 抛错；整组同侧冻结放行', () => {
    const group = { key: 'g', header: 'G' }
    expect(() => computeFrozenPositions([
      { key: 'a', width: 10, freeze: 'left', group },
      { key: 'b', group },
    ])).toThrow(/跨越冻结边界/)
    expect(() => computeFrozenPositions([
      { key: 'x' },
      { key: 'a', group },
      { key: 'b', width: 10, freeze: 'right', group },
    ])).toThrow(/跨越冻结边界/)
    expect(() => computeFrozenPositions([
      { key: 'x' },
      { key: 'a', width: 10, freeze: 'right', group },
      { key: 'b', width: 10, freeze: 'right', group },
    ])).not.toThrow()
  })

  it('冻结列夹在中间 / 超过 4 列 / 缺宽度 → 抛错', () => {
    expect(() => computeFrozenPositions([{ key: 'a' }, { key: 'b', width: 10, freeze: 'left' }, { key: 'c' }])).toThrow(/前缀或右侧后缀/)
    expect(() => computeFrozenPositions(
      Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, width: 10, freeze: 'left' as const })).concat([{ key: 'z' } as never]),
    )).toThrow(/最多冻结 4 列/)
    expect(() => computeFrozenPositions([{ key: 'a', freeze: 'left' }, { key: 'b' }])).toThrow(/宽度/)
  })
})

describe('sortMatrixRows / nextMatrixSort', () => {
  const rowKey = (r: Row) => r.id
  const rows: Row[] = [
    { id: 'c', store: 'c', sales: 100, paid: 0, visits: 0 },
    { id: 'a', store: 'a', sales: 100, paid: 0, visits: 0 },
    { id: 'n', store: 'n', sales: null, paid: 0, visits: 0 },
    { id: 'b', store: 'b', sales: 200, paid: 0, visits: 0 },
  ]

  it('排序值相同按唯一键兜底，空值升降序都在最后', () => {
    expect(sortMatrixRows(rows, (r) => r.sales, 'desc', rowKey).map(rowKey)).toEqual(['b', 'a', 'c', 'n'])
    expect(sortMatrixRows(rows, (r) => r.sales, 'asc', rowKey).map(rowKey)).toEqual(['a', 'c', 'b', 'n'])
  })

  it('数字字符串按数值序（"20" 在 "100" 前）', () => {
    const items = [{ id: 'x', v: '100' }, { id: 'y', v: '20' }]
    expect(sortMatrixRows(items, (r) => r.v, 'asc', (r) => r.id).map((r) => r.id)).toEqual(['y', 'x'])
  })

  it('数字与文本混排时整列按文本比，比较器保持传递性：任意输入排列结果相同', () => {
    const items = [{ id: 'a', v: '2' }, { id: 'b', v: '10' }, { id: 'c', v: '15x' }]
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    const results = permutations.map((order) =>
      sortMatrixRows(order.map((i) => items[i]), (r) => r.v, 'asc', (r) => r.id).map((r) => r.id).join())
    expect(new Set(results).size).toBe(1)
    // 文本模式保留自然序：店2 在 店10 前
    expect(sortMatrixRows([{ id: 'x', v: '店10' }, { id: 'y', v: '店2' }], (r) => r.v, 'asc', (r) => r.id).map((r) => r.id)).toEqual(['y', 'x'])
  })

  it('输入顺序不影响结果（稳定可复现）', () => {
    const reversed = [...rows].reverse()
    expect(sortMatrixRows(reversed, (r) => r.sales, 'desc', rowKey)).toEqual(sortMatrixRows(rows, (r) => r.sales, 'desc', rowKey))
  })

  it('点表头：换列从降序开始，同列降 ↔ 升', () => {
    expect(nextMatrixSort(null, 'sales')).toEqual({ key: 'sales', direction: 'desc' })
    expect(nextMatrixSort({ key: 'sales', direction: 'desc' }, 'sales')).toEqual({ key: 'sales', direction: 'asc' })
    expect(nextMatrixSort({ key: 'sales', direction: 'asc' }, 'sales')).toEqual({ key: 'sales', direction: 'desc' })
    expect(nextMatrixSort({ key: 'sales', direction: 'asc' }, 'paid')).toEqual({ key: 'paid', direction: 'desc' })
  })
})

describe('listMonthDays', () => {
  it('按日历生成当月日期与周末标记，不受运行时区影响', () => {
    const days = listMonthDays('2026-09')
    expect(days).toHaveLength(30)
    expect(days[0]).toEqual({ date: '2026-09-01', day: 1, weekend: false }) // 周二
    expect(days.filter((d) => d.weekend).map((d) => d.day)).toEqual([5, 6, 12, 13, 19, 20, 26, 27])
    expect(listMonthDays('2028-02')).toHaveLength(29)
  })

  it('非法月份抛 INVALID_PARAMS', () => {
    expect(() => listMonthDays('2026-13')).toThrow(/INVALID_PARAMS/)
    expect(() => listMonthDays('2026-9')).toThrow(/INVALID_PARAMS/)
    expect(() => listMonthDays('0099-02')).toThrow(/INVALID_PARAMS/)
  })
})
