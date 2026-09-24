import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, within } from '@testing-library/react'
import { MatrixTable, type MatrixColumn } from './matrix-table'

/**
 * #368 验收：两行表头、冻结列、合计行、动态列四种形态（不依赖页面单完成）。
 * 合计口径的逐项断言在 lib/data-center/matrix.test.ts，这里守「渲染出来的就是那个口径」。
 */

interface Row {
  id: string
  name: string
  kind?: 'subtotal'
  cells: Record<string, number | null>
}

const ROWS: Row[] = [
  { id: 'c1', name: '张三', cells: { 'd1:sales': 100, 'd1:consume': 20, 'd2:sales': null, 'd2:consume': -5, rate: 0.5 } },
  { id: 'c2', name: '李四', cells: { 'd1:sales': 300, 'd1:consume': 40, 'd2:sales': 50, 'd2:consume': 0, rate: 0.1 } },
  { id: 'm1', name: '南昌小计', kind: 'subtotal', cells: { 'd1:sales': 400, 'd1:consume': 60, 'd2:sales': 50, 'd2:consume': -5 } },
]

function buildColumns(days: string[], extra: Partial<MatrixColumn<Row>> = {}): MatrixColumn<Row>[] {
  return [
    { key: 'name', header: '顾客', width: 120, freeze: 'left', cell: (r) => r.name, sortable: true },
    ...days.flatMap((day) => (['sales', 'consume'] as const).map((metric): MatrixColumn<Row> => ({
      key: `${day}:${metric}`,
      header: metric === 'sales' ? '业绩' : '消耗',
      group: { key: day, header: day },
      width: 90,
      align: 'right',
      weekend: day === 'd2',
      value: (r) => r.cells[`${day}:${metric}`],
      aggregate: { kind: 'sum' },
      sortable: true,
    }))),
    {
      key: 'rate',
      header: '付清率',
      hint: '已付清单数 ÷ 总单数',
      width: 90,
      freeze: 'right',
      unit: 'percent',
      value: (r) => r.cells.rate,
      aggregate: { kind: 'ratio', numerator: (r) => r.cells['d1:consume'], denominator: (r) => r.cells['d1:sales'] },
      ...extra,
    },
  ]
}

function headerRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('thead tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th')).map((th) => ({
      text: th.textContent?.replace(/[▲▼?]/g, '').trim(),
      colSpan: th.colSpan,
      rowSpan: th.rowSpan,
    })),
  )
}

function footerTexts(container: HTMLElement) {
  return Array.from(container.querySelectorAll('tfoot td')).map((td) => td.textContent?.trim())
}

describe('MatrixTable · 两行分组表头', () => {
  it('colSpan / rowSpan 正确：未分组列纵向合并，同组列横向合并', () => {
    const { container } = render(<MatrixTable columns={buildColumns(['d1', 'd2'])} rows={ROWS} rowKey={(r) => r.id} />)
    expect(headerRows(container)).toEqual([
      [
        { text: '顾客', colSpan: 1, rowSpan: 2 },
        { text: 'd1', colSpan: 2, rowSpan: 1 },
        { text: 'd2', colSpan: 2, rowSpan: 1 },
        { text: '付清率', colSpan: 1, rowSpan: 2 },
      ],
      [
        { text: '业绩', colSpan: 1, rowSpan: 1 },
        { text: '消耗', colSpan: 1, rowSpan: 1 },
        { text: '业绩', colSpan: 1, rowSpan: 1 },
        { text: '消耗', colSpan: 1, rowSpan: 1 },
      ],
    ])
  })

  it('动态列增删后表头与数据不错位（每行单元格数 = 叶子列数，值落在对应列）', () => {
    const { container, rerender } = render(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} />,
    )
    const cellsOf = () => Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()))
    expect(cellsOf()[0]).toEqual(['张三', '100.00', '20.00', '50.00%'])

    rerender(<MatrixTable columns={buildColumns(['d1', 'd2'])} rows={ROWS} rowKey={(r) => r.id} />)
    expect(cellsOf()[0]).toEqual(['张三', '100.00', '20.00', '--', '-5.00', '50.00%'])
    expect(headerRows(container)[1]).toHaveLength(4)

    rerender(<MatrixTable columns={buildColumns(['d2'])} rows={ROWS} rowKey={(r) => r.id} />)
    expect(cellsOf()[1]).toEqual(['李四', '50.00', '0.00', '10.00%'])
  })
})

describe('MatrixTable · 合计行', () => {
  it('不分页：可加列 = 逐行求和（小计行不计入），比率 = 合计分子 ÷ 合计分母', () => {
    const { container } = render(
      <MatrixTable
        columns={buildColumns(['d1', 'd2'])}
        rows={ROWS}
        rowKey={(r) => r.id}
        isSubtotal={(r) => r.kind === 'subtotal'}
        totals={{}}
      />,
    )
    // rate 合计 = (20 + 40) / (100 + 300) = 15%，不是 (50% + 10%) / 2 = 30%
    expect(footerTexts(container)).toEqual(['合计', '400.00', '60.00', '50.00', '-5.00', '15.00%'])
  })

  it('分页：合计取服务端全量值，翻页后不变；服务端没给的列留空', () => {
    const serverTotals = { 'd1:sales': 12_345.6, 'd1:consume': 789, rate: 0.064 }
    const pagination = { page: 1, pageSize: 1, total: 2, onPageChange: vi.fn() }
    const { container, rerender } = render(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS.slice(0, 1)} rowKey={(r) => r.id} pagination={pagination} totals={{ values: serverTotals }} />,
    )
    const page1 = footerTexts(container)
    rerender(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS.slice(1, 2)} rowKey={(r) => r.id} pagination={{ ...pagination, page: 2 }} totals={{ values: serverTotals }} />,
    )
    expect(footerTexts(container)).toEqual(page1)
    expect(page1).toEqual(['合计', '12,345.60', '789.00', '6.40%'])

    rerender(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS.slice(1, 2)} rowKey={(r) => r.id} pagination={{ ...pagination, page: 2 }} totals={{ values: {} }} />,
    )
    // 没有服务端合计时绝不拿本页 300 冒充合计
    expect(footerTexts(container)).toEqual(['合计', '--', '--', '--'])
  })

  it('去重计数列以服务端口径为准，可以不等于逐行和', () => {
    const columns: MatrixColumn<Row>[] = [
      { key: 'name', header: '门店', cell: (r) => r.name },
      { key: 'staff', header: '美容师人数', unit: 'count', value: () => 3, aggregate: { kind: 'server' } },
    ]
    const { container, rerender } = render(<MatrixTable columns={columns} rows={ROWS.slice(0, 2)} rowKey={(r) => r.id} totals={{}} />)
    expect(footerTexts(container)).toEqual(['合计', '--'])
    rerender(<MatrixTable columns={columns} rows={ROWS.slice(0, 2)} rowKey={(r) => r.id} totals={{ values: { staff: 4 } }} />)
    expect(footerTexts(container)).toEqual(['合计', '4'])
  })

  it('负数合计标红；totals 缺省不渲染合计行', () => {
    const { container, rerender } = render(<MatrixTable columns={buildColumns(['d2'])} rows={ROWS.slice(0, 1)} rowKey={(r) => r.id} totals={{}} />)
    const negative = Array.from(container.querySelectorAll('tfoot span')).find((el) => el.textContent === '-5.00')
    expect(negative?.className).toContain('text-[var(--destructive)]')
    rerender(<MatrixTable columns={buildColumns(['d2'])} rows={ROWS.slice(0, 1)} rowKey={(r) => r.id} />)
    expect(container.querySelector('tfoot')).toBeNull()
  })
})

describe('MatrixTable · 冻结列与样式', () => {
  it('左右冻结列带 sticky 偏移，表头冻结角层级高于表头', () => {
    const { container } = render(<MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} totals={{}} />)
    const firstBody = container.querySelector('tbody td') as HTMLElement
    expect(firstBody.style.position).toBe('sticky')
    expect(firstBody.style.left).toBe('0px')
    expect(firstBody.className).toContain('z-10')
    const lastBody = container.querySelector('tbody tr')!.lastElementChild as HTMLElement
    expect(lastBody.style.right).toBe('0px')
    const corner = container.querySelector('thead th') as HTMLElement
    expect(corner.className).toContain('z-30')
    expect(corner.style.left).toBe('0px')
    const footCorner = container.querySelector('tfoot td') as HTMLElement
    expect(footCorner.style.bottom).toBe('0px')
    expect(footCorner.className).toContain('z-30')
  })

  it('小计行加粗且不响应行点击；单元格状态 / 周末列样式', () => {
    const onRowClick = vi.fn()
    const columns = buildColumns(['d1', 'd2']).map((column) => column.key === 'd1:sales'
      ? { ...column, tone: (r: Row) => (r.id === 'c1' ? 'pending' as const : r.id === 'c2' ? 'muted' as const : null) }
      : column)
    const { container } = render(
      <MatrixTable columns={columns} rows={ROWS} rowKey={(r) => r.id} isSubtotal={(r) => r.kind === 'subtotal'} onRowClick={onRowClick} />,
    )
    const [first, second, subtotal] = Array.from(container.querySelectorAll('tbody tr')) as HTMLElement[]
    expect(first.querySelectorAll('td')[1].dataset.tone).toBe('pending')
    expect(second.querySelectorAll('td')[1].dataset.tone).toBe('muted')
    expect(subtotal.dataset.subtotal).toBe('true')
    expect(subtotal.querySelectorAll('td')[1].dataset.tone).toBeUndefined()
    fireEvent.click(subtotal)
    fireEvent.click(first)
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(first.querySelectorAll('td')[3].className).toContain('bg-[#FAFAF7]') // d2 周末列
  })
})

describe('MatrixTable · 右冻结分组 / 浮点噪声', () => {
  it('右冻结分组表头按末列吸附：right = 0 而不是首列的偏移', () => {
    const columns: MatrixColumn<Row>[] = [
      { key: 'name', header: '员工', width: 120, freeze: 'left', cell: (r) => r.name },
      { key: 'd1', header: '1日', width: 90, value: (r) => r.cells['d1:sales'] },
      { key: 'sum:sales', header: '业绩', width: 90, freeze: 'right', group: { key: 'sum', header: '合计' }, value: (r) => r.cells['d1:sales'] },
      { key: 'sum:consume', header: '消耗', width: 90, freeze: 'right', group: { key: 'sum', header: '合计' }, value: (r) => r.cells['d1:consume'] },
    ]
    const { container } = render(<MatrixTable columns={columns} rows={ROWS} rowKey={(r) => r.id} />)
    const groupCell = Array.from(container.querySelectorAll('thead tr:first-child th')).find((th) => th.textContent === '合计') as HTMLTableCellElement
    expect(groupCell.colSpan).toBe(2)
    expect(groupCell.style.right).toBe('0px')
    const [sales, consume] = Array.from(container.querySelectorAll('thead tr:nth-child(2) th')) as HTMLElement[]
    expect(sales.style.right).toBe('90px')
    expect(consume.style.right).toBe('0px')
  })

  it('相抵后的浮点噪声不显示成红色 -0.00', () => {
    const columns: MatrixColumn<Row>[] = [
      { key: 'name', header: '门店', cell: (r) => r.name },
      { key: 'v', header: '金额', value: () => 0.1 + 0.2 - 0.3 - 1e-16 * 3 - 0.0000000001 },
    ]
    const { container } = render(<MatrixTable columns={columns} rows={ROWS.slice(0, 1)} rowKey={(r) => r.id} />)
    const cell = container.querySelectorAll('tbody td')[1].querySelector('span') as HTMLElement
    expect(cell.textContent).toBe('0.00')
    expect(cell.className).not.toContain('destructive')
  })
})

describe('MatrixTable · 排序与提示', () => {
  it('点可排序表头按 desc → asc 切换并回调，aria-sort 标注当前列', () => {
    const onSortChange = vi.fn()
    const { container, rerender } = render(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} onSortChange={onSortChange} />,
    )
    fireEvent.click(within(container.querySelector('thead') as HTMLElement).getAllByRole('button', { name: /业绩/ })[0])
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'd1:sales', direction: 'desc' })
    rerender(
      <MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} sort={{ key: 'd1:sales', direction: 'desc' }} onSortChange={onSortChange} />,
    )
    const sorted = container.querySelector('th[aria-sort]')
    expect(sorted?.getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(within(sorted as HTMLElement).getByRole('button'))
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'd1:sales', direction: 'asc' })
  })

  it('列头说明浮层渲染到 body 下，不在表格滚动容器内（不会被 overflow 裁掉）', () => {
    const { container } = render(<MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} />)
    const trigger = container.querySelector('[aria-label="已付清单数 ÷ 总单数"]') as HTMLElement
    fireEvent.mouseEnter(trigger.parentElement!)
    const tooltip = document.body.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toBe('已付清单数 ÷ 总单数')
    expect(container.contains(tooltip)).toBe(false)
    fireEvent.mouseLeave(trigger.parentElement!)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('浮层在任意滚动时收起；上方空间不足时翻到下方', () => {
    const { container } = render(<MatrixTable columns={buildColumns(['d1'])} rows={ROWS} rowKey={(r) => r.id} />)
    const host = (container.querySelector('[aria-label="已付清单数 ÷ 总单数"]') as HTMLElement).parentElement!
    // happy-dom 不排版，getBoundingClientRect 全 0 → 视为贴着视口顶部，应翻到下方
    fireEvent.mouseEnter(host)
    expect(document.body.querySelector('[role="tooltip"]')?.getAttribute('data-placement')).toBe('bottom')
    fireEvent.scroll(container.querySelector('table')!.parentElement!)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })
})
