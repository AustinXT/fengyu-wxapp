import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
const { setMany, replaceAll, state, exportProps } = vi.hoisted(() => ({ setMany: vi.fn(), replaceAll: vi.fn(), state: { params: new URLSearchParams() }, exportProps: { value: {} as Record<string, unknown> } }))
vi.mock('@/lib/hooks/use-url-filters', () => ({ useUrlFilters: () => ({ get: (key: string) => state.params.get(key) ?? '', setMany, replaceAll }) }))
vi.mock('@/components/ui/export-button', () => ({ ExportButton: (props: Record<string, unknown>) => { exportProps.value = props; return <button disabled={Boolean(props.disabled)}>导出</button> } }))
import PendingReceiptsPage from './pending-receipts-page'
const row = { id: '1', recipientId: 'S1', recipientName: '门店一', marketId: 'M1', marketName: '市场一', docDate: '2026-09-20', docId: 'DOC1', skuId: 'SKU1', skuName: '面膜', batchNo: 'B1', sentQuantity: 10, receivedQuantity: 3, pendingQuantity: 7, transitDays: 9 }
const props = { result: { rows: [row], total: 1, page: 1, pageSize: 20 }, kind: 'store' as const, options: { markets: [{ id: 'M1', name: '市场一' }], stores: [{ id: 'S1', name: '门店一', marketId: 'M1' }] }, error: null, canExport: true }
beforeEach(() => { vi.clearAllMocks(); state.params = new URLSearchParams('market=M1&store=S1&start=2026-09-01&page=3') })
describe('#361 收货跟进页面', () => {
  it('展示同构数量、单号跳转，导出使用同条件且不含页码', () => {
    render(<PendingReceiptsPage {...props} />)
    expect(screen.getByRole('link', { name: 'DOC1' })).toHaveAttribute('href', '/inventory/docs/DOC1')
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(exportProps.value).toMatchObject({ disabled: false, exportRequest: { exportType: 'inventory-pending-receipts', payload: { kind: 'store', market: 'M1', store: 'S1', start: '2026-09-01', end: '' } } })
  })
  it('切视图和市场清空门店、页码；市场视图不带门店导出条件', () => {
    const mounted = render(<PendingReceiptsPage {...props} />)
    fireEvent.change(screen.getByLabelText('收货视图'), { target: { value: 'market' } })
    expect(setMany).toHaveBeenCalledWith({ kind: 'market', market: '', store: '', page: '' })
    fireEvent.change(screen.getByLabelText('市场'), { target: { value: '' } })
    expect(setMany).toHaveBeenCalledWith({ market: '', store: '', page: '' })
    mounted.rerender(<PendingReceiptsPage {...props} kind="market" />)
    expect(screen.queryByLabelText('门店')).not.toBeInTheDocument()
    expect(exportProps.value).toMatchObject({ exportRequest: { payload: { kind: 'market', store: '' } } })
  })
  it('无导出权限隐藏入口，非法条件禁止导出并显示提示', () => {
    const mounted = render(<PendingReceiptsPage {...props} canExport={false} />)
    expect(screen.queryByText('导出')).not.toBeInTheDocument()
    mounted.rerender(<PendingReceiptsPage {...props} error="日期不合法" />)
    expect(screen.getByRole('alert')).toHaveTextContent('日期不合法')
    expect(screen.getByText('导出')).toBeDisabled()
  })
})
