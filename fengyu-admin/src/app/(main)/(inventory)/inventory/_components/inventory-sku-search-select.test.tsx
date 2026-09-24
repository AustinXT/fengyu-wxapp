import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySkuRow } from '@/lib/inventory/types'

const { mockListSkus } = vi.hoisted(() => ({ mockListSkus: vi.fn() }))
vi.mock('@/actions/inventory/skus', () => ({ listInventorySkus: mockListSkus }))

import { InventorySkuSearchSelect, SKU_SEARCH_DEBOUNCE_MS, SKU_SEARCH_PAGE_SIZE } from './inventory-sku-search-select'

function sku(skuId: string, productName: string, productCode = skuId): InventorySkuRow {
  return { skuId, productCode, productName, specName: null } as InventorySkuRow
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** 让 then 回调与随后的 setState 落地 */
async function flush() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

function Harness(props: { initial?: string; selectedLabel?: string; filters?: Record<string, unknown>; onChange?: (id: string) => void }) {
  const [value, setValue] = useState(props.initial ?? '')
  return (
    <form onSubmit={(event) => { event.preventDefault(); submitSpy() }}>
      <InventorySkuSearchSelect
        value={value}
        onChange={(id) => { setValue(id); props.onChange?.(id) }}
        filters={props.filters}
        selectedLabel={props.selectedLabel}
      />
    </form>
  )
}
const submitSpy = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  mockListSkus.mockReset()
  submitSpy.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('InventorySkuSearchSelect（#339）', () => {
  it('收起时不取数；展开后带着业务过滤查第 1 页', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液')], total: 1 })
    render(<Harness filters={{ reportable: true, availableToMarketId: 'M1' }} />)
    expect(mockListSkus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    expect(mockListSkus).toHaveBeenCalledWith({
      reportable: true, availableToMarketId: 'M1', keyword: undefined, onlyActive: true, page: 1, pageSize: SKU_SEARCH_PAGE_SIZE,
    })
    expect(screen.getByRole('option', { name: /精华液/ })).toBeInTheDocument()
  })

  it('关键词防抖：连续输入只在停顿后发一次请求', async () => {
    mockListSkus.mockResolvedValue({ data: [], total: 0 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    mockListSkus.mockClear()
    const input = screen.getByLabelText('搜索库存商品')
    fireEvent.change(input, { target: { value: 'I' } })
    fireEvent.change(input, { target: { value: 'IN' } })
    fireEvent.change(input, { target: { value: 'INV-SKU' } })
    await act(async () => { vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS - 1) })
    expect(mockListSkus).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect(mockListSkus).toHaveBeenCalledTimes(1)
    expect(mockListSkus.mock.calls[0][0]).toMatchObject({ keyword: 'INV-SKU', page: 1 })
  })

  it('加载更多：取第 2 页并追加，到总数后不再显示按钮', async () => {
    const firstPage = Array.from({ length: SKU_SEARCH_PAGE_SIZE }, (_, index) => sku(`S${index}`, `商品${index}`))
    mockListSkus
      .mockResolvedValueOnce({ data: firstPage, total: SKU_SEARCH_PAGE_SIZE + 1 })
      .mockResolvedValueOnce({ data: [sku('LAST', '排在最后的自采商品', 'INV-SKU-260924-0001')], total: SKU_SEARCH_PAGE_SIZE + 1 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await flush()
    expect(mockListSkus.mock.calls[1][0]).toMatchObject({ page: 2 })
    expect(screen.getAllByRole('option')).toHaveLength(SKU_SEARCH_PAGE_SIZE + 1)
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('先发后到的旧关键词结果被丢弃', async () => {
    const slow = deferred<{ data: InventorySkuRow[]; total: number }>()
    mockListSkus
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ data: [sku('NEW', '新结果')], total: 1 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('搜索库存商品'), { target: { value: '新' } })
    await act(async () => { vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS) })
    await flush()
    await act(async () => { slow.resolve({ data: [sku('OLD', '旧结果')], total: 1 }) })
    await flush()
    expect(screen.getByRole('option', { name: /新结果/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /旧结果/ })).not.toBeInTheDocument()
  })

  it('选中后收起并显示名称；之后换关键词、结果里没有它，名称仍在', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液', 'P001')], total: 1 })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    fireEvent.click(screen.getByRole('option', { name: /精华液/ }))
    expect(onChange).toHaveBeenCalledWith('A')
    expect(screen.getByRole('combobox')).toHaveTextContent('精华液 · P001')
    mockListSkus.mockResolvedValue({ data: [], total: 0 })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('搜索库存商品'), { target: { value: '不相干' } })
    await act(async () => { vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS) })
    await flush()
    expect(screen.getByRole('combobox')).toHaveTextContent('精华液 · P001')
  })

  it('外部带入的值：按 skuIds 精确查名称（含已停用），不会显示成空白', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('Z9', '早已停用的商品', 'P999')], total: 1 })
    render(<Harness initial="Z9" />)
    expect(screen.getByRole('combobox')).toHaveTextContent('加载中')
    await flush()
    expect(mockListSkus).toHaveBeenCalledWith(expect.objectContaining({ skuIds: ['Z9'], onlyActive: false }))
    expect(screen.getByRole('combobox')).toHaveTextContent('早已停用的商品 · P999')
  })

  it('调用方给了 selectedLabel 就直接用，不再查询', async () => {
    render(<Harness initial="Z9" selectedLabel="方案里的商品名" />)
    await flush()
    expect(screen.getByRole('combobox')).toHaveTextContent('方案里的商品名')
    expect(mockListSkus).not.toHaveBeenCalled()
  })

  it('搜索框里回车只选中高亮项，不会提交外层表单', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液')], total: 1 })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    const input = screen.getByLabelText('搜索库存商品')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(submitSpy).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('A')
    expect(submitSpy).not.toHaveBeenCalled()
  })
})
