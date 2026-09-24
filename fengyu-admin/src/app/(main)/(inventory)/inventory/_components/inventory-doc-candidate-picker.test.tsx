import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('@/actions/inventory/docs', () => ({
  listInventoryDocCandidates: vi.fn(),
  listInventoryDocCandidateIds: vi.fn(),
}))

import { listInventoryDocCandidateIds, listInventoryDocCandidates } from '@/actions/inventory/docs'
import { toast } from 'sonner'
import type { InventoryDocCandidateRow } from '@/lib/inventory/doc-candidates'
import { DocCandidateReloadContext, InventoryDocCandidatePicker } from './inventory-doc-candidate-picker'

function row(id: string, done: number | null, total: number, overrides: Partial<InventoryDocCandidateRow> = {}): InventoryDocCandidateRow {
  return {
    id, docType: '门店报货', status: '已完成', sourceOrgNodeId: 'S1', sourceOrgNodeName: '一店', sourceOrgNodeType: '门店',
    targetOrgNodeId: 'M1', targetOrgNodeName: '市场一部', targetOrgNodeType: '市场', marketId: 'M1', supplierId: null,
    docDate: '2026-08-01', relatedSaleOrderId: null, customerName: null, employeeName: null, supplierName: null,
    externalPartyName: null, logisticsCompany: null, trackingNo: null, receiptAttachmentUrl: null, totalQuantity: total,
    remark: null, auditRemark: null, createdBy: 'E1', confirmedAt: null, approvedAt: null, rejectedAt: null,
    cancellationRequestReason: null, cancellationRequestedBy: null, cancellationRequestedAt: null, cancellationReason: null,
    cancelledAt: null, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    progress: { done, total },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(listInventoryDocCandidates).mockReset()
  vi.mocked(listInventoryDocCandidateIds).mockReset()
  vi.mocked(toast.success).mockReset()
})

describe('InventoryDocCandidatePicker（#338）', () => {
  it('重取后总数缩小、当前页越界时夹回最后一页，而不是困在空页', async () => {
    const pageOf = (page: number, total: number) => ({
      data: page === 1 ? Array.from({ length: 20 }, (_, index) => row(`DBH-${index}`, 0, 1)) : (total > 20 ? [row('DBH-20', 0, 1)] : []),
      total,
      pageSize: 20,
    })
    let total = 21
    vi.mocked(listInventoryDocCandidates).mockImplementation(async (input) => pageOf(input.page ?? 1, total))
    function Harness() {
      const [version, setVersion] = useState(0)
      return (
        <DocCandidateReloadContext.Provider value={{ version, bump: () => setVersion((v) => v + 1) }}>
          <button type="button" onClick={() => setVersion((v) => v + 1)}>bump</button>
          <InventoryDocCandidatePicker label="门店报货单" purpose="store-allocation-source" selection={{ mode: 'single', value: '', onChange: () => {} }} />
        </DocCandidateReloadContext.Provider>
      )
    }
    render(<Harness />)
    await screen.findByRole('radio', { name: '选择 DBH-0' })
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    await screen.findByRole('radio', { name: '选择 DBH-20' })
    total = 20
    fireEvent.click(screen.getByRole('button', { name: 'bump' }))
    await screen.findByRole('radio', { name: '选择 DBH-0' })
    expect(listInventoryDocCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }))
  })

  it('一键带出在途时改了检索条件，旧结果作废、不替换已选', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [], total: 0, pageSize: 20 })
    let resolveIds: (value: { ids: string[] }) => void = () => {}
    vi.mocked(listInventoryDocCandidateIds).mockImplementationOnce(() => new Promise((resolve) => { resolveIds = resolve }))
    const onChange = vi.fn()
    render(
      <InventoryDocCandidatePicker
        label="来源报货单"
        purpose="purchase-order-source"
        selection={{ mode: 'multi', values: [], onChange, bulkLabel: '带出' }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '带出' }))
    fireEvent.change(screen.getByLabelText('来源报货单 检索'), { target: { value: 'MHZ' } })
    await waitFor(() => expect(listInventoryDocCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: 'MHZ' })), { timeout: 2000 })
    await act(async () => { resolveIds({ ids: ['MHZ-OLD'] }) })
    expect(onChange).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('带出 0 张时同样替换已选（清空），不留上一个区间的单', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [], total: 0, pageSize: 20 })
    vi.mocked(listInventoryDocCandidateIds).mockResolvedValue({ ids: [] })
    const onChange = vi.fn()
    render(<InventoryDocCandidatePicker label="来源报货单" purpose="purchase-order-source" selection={{ mode: 'multi', values: ['MHZ-A', 'MHZ-B'], onChange, bulkLabel: '带出' }} />)
    fireEvent.click(await screen.findByRole('button', { name: '带出' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
  })

  it('带出用输入框的当前关键字（不等防抖）', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [], total: 0, pageSize: 20 })
    vi.mocked(listInventoryDocCandidateIds).mockResolvedValue({ ids: ['MHZ-7'] })
    const onChange = vi.fn()
    render(<InventoryDocCandidatePicker label="来源报货单" purpose="purchase-order-source" selection={{ mode: 'multi', values: [], onChange, bulkLabel: '带出' }} />)
    fireEvent.change(screen.getByLabelText('来源报货单 检索'), { target: { value: ' MHZ-7 ' } })
    fireEvent.click(screen.getByRole('button', { name: '带出' }))
    await waitFor(() => expect(listInventoryDocCandidateIds).toHaveBeenCalledWith(expect.objectContaining({ keyword: 'MHZ-7' })))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['MHZ-7']))
  })

  it('带出在途时已选被改（清除 / 改勾选），旧结果作废', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [], total: 0, pageSize: 20 })
    let resolveIds: (value: { ids: string[] }) => void = () => {}
    vi.mocked(listInventoryDocCandidateIds).mockImplementationOnce(() => new Promise((resolve) => { resolveIds = resolve }))
    const onChange = vi.fn()
    const { rerender } = render(
      <InventoryDocCandidatePicker label="来源报货单" purpose="purchase-order-source" selection={{ mode: 'multi', values: ['MHZ-A'], onChange, bulkLabel: '带出' }} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '带出' }))
    rerender(<InventoryDocCandidatePicker label="来源报货单" purpose="purchase-order-source" selection={{ mode: 'multi', values: [], onChange, bulkLabel: '带出' }} />)
    await act(async () => { resolveIds({ ids: ['MHZ-OLD'] }) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('带出禁用原因：按钮禁用并显示原因，不发请求', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [], total: 0, pageSize: 20 })
    render(
      <InventoryDocCandidatePicker
        label="来源报货单"
        purpose="purchase-order-source"
        selection={{ mode: 'multi', values: [], onChange: () => {}, bulkLabel: '带出', bulkDisabledReason: '请先选择供应链库存主体' }}
      />,
    )
    expect(await screen.findByRole('button', { name: '带出' })).toBeDisabled()
    expect(screen.getByText('请先选择供应链库存主体')).toBeInTheDocument()
    expect(listInventoryDocCandidateIds).not.toHaveBeenCalled()
  })

  it('「已无剩余」只标在建单类来源上；状态类候选只显示进度', async () => {
    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [row('CGD-1', 3, 3, { docType: '采购订单', status: '待收货' })], total: 1, pageSize: 20 })
    const { unmount } = render(
      <InventoryDocCandidatePicker label="采购订单" purpose="supply-chain-purchase-cancel" selection={{ mode: 'single', value: '', onChange: () => {} }} />,
    )
    const cancelRow = (await screen.findByRole('radio', { name: '选择 CGD-1' })).closest('tr')!
    expect(cancelRow).toHaveTextContent('已收 3 / 3')
    expect(cancelRow).not.toHaveTextContent('已无剩余')
    unmount()

    vi.mocked(listInventoryDocCandidates).mockResolvedValue({ data: [row('DBH-1', 2, 2)], total: 1, pageSize: 20 })
    render(
      <InventoryDocCandidatePicker label="门店报货单" purpose="store-allocation-source" selection={{ mode: 'single', value: '', onChange: () => {} }} />,
    )
    const allocRow = (await screen.findByRole('radio', { name: '选择 DBH-1' })).closest('tr')!
    expect(allocRow).toHaveTextContent('已配 2 / 2（已无剩余）')
    // 只有建单类来源才有「显示已无剩余」开关
    expect(screen.getByLabelText('显示已无剩余的单')).toBeInTheDocument()
  })

  it('过时的列表响应被丢弃（后发先至）', async () => {
    let resolveFirst: (value: { data: InventoryDocCandidateRow[]; total: number; pageSize: number }) => void = () => {}
    vi.mocked(listInventoryDocCandidates)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue({ data: [row('DBH-NEW', 0, 1)], total: 1, pageSize: 20 })
    render(<InventoryDocCandidatePicker label="门店报货单" purpose="store-allocation-source" selection={{ mode: 'single', value: '', onChange: () => {} }} />)
    fireEvent.change(screen.getByLabelText('门店报货单 检索'), { target: { value: 'NEW' } })
    await screen.findByRole('radio', { name: '选择 DBH-NEW' }, { timeout: 2000 })
    await act(async () => { resolveFirst({ data: [row('DBH-STALE', 0, 1)], total: 1, pageSize: 20 }) })
    expect(screen.queryByRole('radio', { name: '选择 DBH-STALE' })).not.toBeInTheDocument()
  })
})
