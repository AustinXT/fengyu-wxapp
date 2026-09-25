import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  InventoryLocationFilterOptions,
  InventoryMovementPage,
  InventoryMovementRow,
} from '@/lib/inventory/types'

const { mockCreateExportJob, mockSetMany, urlState } = vi.hoisted(() => ({
  mockCreateExportJob: vi.fn(),
  mockSetMany: vi.fn(),
  urlState: { params: new URLSearchParams() },
}))

vi.mock('@/lib/hooks/use-url-filters', () => ({
  useUrlFilters: () => ({
    get: (key: string, defaultValue = '') => urlState.params.get(key) ?? defaultValue,
    setMany: mockSetMany,
  }),
}))

vi.mock('@/actions/export-jobs', () => ({ createExportJob: mockCreateExportJob }))

import InventoryMovementsPage from './inventory-movements-page'

const locationFilterOptions: InventoryLocationFilterOptions = {
  headquarters: [],
  markets: [{
    locationId: 'M1',
    name: '南昌市场',
    canSelectInventory: true,
    stores: [{ locationId: 'S1', name: '红谷滩店' }],
  }],
  defaultLocationId: 'M1',
}

function row(id: number, overrides: Partial<InventoryMovementRow> = {}): InventoryMovementRow {
  return {
    id,
    lotId: 11,
    skuId: 'SKU-1',
    skuName: '玻尿酸面膜',
    specName: '25ml*5',
    batchNo: 'B-1',
    docId: `YTH-${id}`,
    docType: '院退货',
    direction: '出库',
    quantityDelta: -3,
    quantityBefore: 10,
    quantityAfter: 7,
    counterpartyName: '南昌市场',
    operatorId: 'E1',
    operatorName: '张三',
    remark: null,
    createdAt: '2026-09-26 10:00:00',
    ...overrides,
  }
}

function page(rows: InventoryMovementRow[], overrides: Partial<InventoryMovementPage> = {}): InventoryMovementPage {
  return { rows, total: rows.length, hasPrev: false, hasNext: false, ...overrides }
}

function renderPage(props: Partial<Parameters<typeof InventoryMovementsPage>[0]> = {}) {
  return render(
    <InventoryMovementsPage
      page={page([row(1)])}
      hasQuery
      errorMessage={null}
      canExport
      canOpenDoc
      locationFilterOptions={locationFilterOptions}
      selectedLocationId="S1"
      {...props}
    />,
  )
}

beforeEach(() => {
  mockCreateExportJob.mockReset()
  mockSetMany.mockReset()
  urlState.params = new URLSearchParams('location=S1&batch=B-1')
})

describe('InventoryMovementsPage（#360）', () => {
  it('没有 inventory:export 的账号看不到导出按钮', () => {
    renderPage({ canExport: false })
    expect(screen.queryByRole('button', { name: '导出' })).toBeNull()
  })

  it('导出创建 inventory-movements 异步任务，载荷是页面解析后的主体与当前条件', async () => {
    urlState.params = new URLSearchParams('location=S9&sku=SKU-1&start=2026-09-01&end=2026-09-30&after=5')
    mockCreateExportJob.mockResolvedValue({ reused: false })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(mockCreateExportJob).toHaveBeenCalledTimes(1))
    // 主体取服务端解析值（S1）而不是 URL 原值；翻页游标不进导出条件
    expect(mockCreateExportJob).toHaveBeenCalledWith({
      exportType: 'inventory-movements',
      payload: { location: 'S1', sku: 'SKU-1', batch: '', start: '2026-09-01', end: '2026-09-30' },
    })
  })

  it('没有查询结果时导出按钮禁用', () => {
    renderPage({ page: page([]) })
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled()
  })

  it('有 inventory:list 时单号可跳转单据详情，否则只显示纯文本；无单据流水单号留空', () => {
    const rows = [row(1), row(2, { docId: null, docType: null, direction: '调整', quantityDelta: 1 })]
    const { unmount } = renderPage({ page: page(rows) })
    expect(screen.getByRole('link', { name: 'YTH-1' })).toHaveAttribute('href', '/inventory/docs/YTH-1')
    expect(screen.queryByText('YTH-2')).toBeNull()
    unmount()
    renderPage({ page: page(rows), canOpenDoc: false })
    expect(screen.queryByRole('link', { name: 'YTH-1' })).toBeNull()
    expect(screen.getByText('YTH-1')).toBeInTheDocument()
  })

  it('按商品编号查询才显示「批号」列；数量带正负号', () => {
    const { unmount } = renderPage({ page: page([row(1), row(2, { direction: '入库', quantityDelta: 5 })]) })
    expect(screen.queryByRole('columnheader', { name: '批号' })).toBeNull()
    expect(screen.getByText('-3')).toBeInTheDocument()
    expect(screen.getByText('+5')).toBeInTheDocument()
    unmount()
    urlState.params = new URLSearchParams('location=S1&sku=SKU-1')
    renderPage({ page: page([row(1, { batchNo: 'B-9' })]) })
    expect(screen.getByRole('columnheader', { name: '批号' })).toBeInTheDocument()
    expect(screen.getByText('B-9')).toBeInTheDocument()
  })

  it('翻页用末行 / 首行 id 作 keyset 游标，互斥清掉另一方向', () => {
    renderPage({ page: page([row(7), row(9)], { hasPrev: true, hasNext: true, total: 60 }) })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(mockSetMany).toHaveBeenLastCalledWith({ after: '9', before: '' })
    fireEvent.click(screen.getByRole('button', { name: '上一页' }))
    expect(mockSetMany).toHaveBeenLastCalledWith({ before: '7', after: '' })
    expect(screen.getByText('共 60 条')).toBeInTheDocument()
  })

  it('首末页禁用对应方向的翻页', () => {
    renderPage({ page: page([row(1)], { hasPrev: false, hasNext: false }) })
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('查询按所选方式二选一写入 URL，并重置翻页游标', () => {
    renderPage()
    const mode = screen.getByRole('combobox', { name: '查询方式' })
    fireEvent.change(mode, { target: { value: 'sku' } })
    fireEvent.change(screen.getByPlaceholderText('输入完整商品编号'), { target: { value: ' SKU-1 ' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(mockSetMany).toHaveBeenLastCalledWith({ sku: 'SKU-1', batch: '', after: '', before: '' })
  })

  it('非法条件显示错误提示；未输入条件时给出引导空态', () => {
    const { unmount } = renderPage({ page: page([]), errorMessage: '开始日期不能晚于结束日期' })
    expect(screen.getByText('开始日期不能晚于结束日期')).toBeInTheDocument()
    unmount()
    renderPage({ page: page([]), hasQuery: false })
    const table = screen.getByRole('table')
    expect(within(table).getByText('请选择库存主体，并输入商品编号或批号后查询')).toBeInTheDocument()
  })
})
