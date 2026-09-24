import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventorySkuRow } from '@/lib/inventory/types'

const { mockListSkus } = vi.hoisted(() => ({ mockListSkus: vi.fn() }))
vi.mock('@/actions/inventory/skus', () => ({ listInventorySkus: mockListSkus }))

import { InventorySkuSearchSelect, resetSkuLabelCacheForTest, SKU_SEARCH_DEBOUNCE_MS, SKU_SEARCH_PAGE_SIZE } from './inventory-sku-search-select'

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

function Harness(props: { inLabel?: boolean; initial?: string; selectedLabel?: string; filters?: Record<string, unknown>; onChange?: (id: string) => void }) {
  const [value, setValue] = useState(props.initial ?? '')
  const select = (
    <InventorySkuSearchSelect
      value={value}
      onChange={(id) => { setValue(id); props.onChange?.(id) }}
      filters={props.filters}
      selectedLabel={props.selectedLabel}
    />
  )
  return (
    <form onSubmit={(event) => { event.preventDefault(); submitSpy() }}>
      {props.inLabel ? <label><span>商品</span>{select}</label> : select}
    </form>
  )
}
const submitSpy = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  mockListSkus.mockReset()
  submitSpy.mockReset()
  resetSkuLabelCacheForTest()
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
    // 焦点不在搜索框（比如刚点过「加载更多」）时 Esc 也能收起；且取消默认动作 ——
    // 单据中心的表单在原生 <dialog> 里，Esc 的默认动作是关掉整个建单弹窗
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(false)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
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
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
    mockListSkus.mockResolvedValue({ data: [], total: 0 })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('搜索库存商品'), { target: { value: '不相干' } })
    await act(async () => { vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS) })
    await flush()
    expect(screen.getByRole('combobox')).toHaveTextContent('精华液 · P001')
  })

  it('放在 FormField 的 <label> 里：触发按钮与面板内的点击都取消默认动作，挡住 label 激活转发', async () => {
    // 办理台的 FormField 是 <label>。真浏览器里，label 内的点击若未被取消，默认动作会被转发成
    // 「点 label 的第一个可标注控件」= 触发按钮：选中收起 → 转发 → 面板又被打开（2026-09-24 真机复现）。
    // happy-dom 只在直接对 label dispatchEvent 时转发、不模拟冒泡上来的激活，所以这里锁的是
    // 规范里挡住激活的那个机制本身：点击事件被 preventDefault（fireEvent 返回 false）。
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液', 'P001')], total: 1 })
    const onChange = vi.fn()
    render(<Harness inLabel onChange={onChange} />)
    const trigger = document.querySelector('[role=combobox]') as HTMLElement
    expect(fireEvent.click(trigger)).toBe(false)
    await flush()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // 不在这里点搜索框：happy-dom 的 input 会自己再往 label 派发一次新 click（非规范行为），
    // 真 Chrome 下点搜索框面板保持展开，已在 3012 实机走查验证（_tmp/issue-339/verify/）。
    expect(fireEvent.click(screen.getByText('精华液 · P001'))).toBe(false)
    expect(onChange).toHaveBeenCalledWith('A')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
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

  it('多个明细行回显同一个 SKU（删行后 value 平移也一样）只发一次查询', async () => {
    const gate = deferred<{ data: InventorySkuRow[]; total: number }>()
    mockListSkus.mockReturnValue(gate.promise)
    render(<><Harness initial="Z9" /><Harness initial="Z9" /><Harness initial="Z9" /></>)
    await act(async () => { gate.resolve({ data: [sku('Z9', '同一个商品', 'P009')], total: 1 }) })
    await flush()
    expect(mockListSkus).toHaveBeenCalledTimes(1)
    for (const trigger of screen.getAllByRole('combobox')) expect(trigger).toHaveTextContent('同一个商品 · P009')
  })

  it('第一页加载失败：显示错误与重试，重试成功后错误消失、候选出现', async () => {
    mockListSkus
      .mockRejectedValueOnce(new Error('NETWORK: boom'))
      .mockResolvedValueOnce({ data: [sku('A', '精华液')], total: 1 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await flush()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /精华液/ })).toBeInTheDocument()
  })

  it('不满一页即视为到底：即便 total 更大（翻页期间数据错位被去重）也不再显示加载更多', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液')], total: 5 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })

  it('键盘选中 / Esc 收起后焦点回到触发按钮（面板控件卸载后不能掉到 body）', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液')], total: 1 })
    render(<Harness />)
    const trigger = screen.getByRole('combobox')
    fireEvent.click(trigger)
    await flush()
    const input = screen.getByLabelText('搜索库存商品')
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    await flush()
    screen.getByLabelText('搜索库存商品').focus()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('选中后立即再展开：按空关键词查，不会先用旧关键词查一轮', async () => {
    mockListSkus.mockResolvedValue({ data: [sku('A', '精华液')], total: 1 })
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.change(screen.getByLabelText('搜索库存商品'), { target: { value: '精华' } })
    await act(async () => { vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS) })
    await flush()
    fireEvent.click(screen.getByRole('option', { name: /精华液/ }))
    mockListSkus.mockClear()
    fireEvent.click(screen.getByRole('combobox'))
    await flush()
    expect(mockListSkus).toHaveBeenCalledTimes(1)
    expect(mockListSkus.mock.calls[0][0]).toMatchObject({ keyword: undefined, page: 1 })
  })

  it('回显查询失败：先按 id 显示；换走再换回来时会重新查（失败不被永久缓存）', async () => {
    mockListSkus.mockRejectedValueOnce(new Error('NETWORK'))
    function Switcher() {
      const [value, setValue] = useState('Z9')
      return (
        <>
          <InventorySkuSearchSelect value={value} onChange={() => {}} />
          <button type="button" onClick={() => setValue((v) => (v === 'Z9' ? '' : 'Z9'))}>切换</button>
        </>
      )
    }
    render(<Switcher />)
    await flush()
    expect(screen.getByRole('combobox')).toHaveTextContent('Z9')
    mockListSkus.mockResolvedValueOnce({ data: [sku('Z9', '终于查到了', 'P009')], total: 1 })
    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    await flush()
    expect(mockListSkus).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('combobox')).toHaveTextContent('终于查到了 · P009')
  })
})
