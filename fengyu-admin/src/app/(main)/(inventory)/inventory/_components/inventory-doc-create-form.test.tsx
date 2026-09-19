/**
 * 共享建单表单的**行为**测试（#191）。
 *
 * 同目录另外两个测试文件走「读源码正则」的守护风格（那两个组件一个 2800 行、一个 600 行，
 * 渲染 mock 成本远高于收益）。但清场这件事不一样：它防的是「用户再点一次就多建一张
 * 实扣库存的单」，而正则只能证明 `setItems([defaultItem()])` 这行字还在源码里 ——
 * 证明不了它真的在提交成功后跑到了、更证明不了跑的顺序对。
 * 这个组件依赖少（两个 action + 几个 UI 组件），值得用真渲染钉住。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreateDoc, mockListLots } = vi.hoisted(() => ({
  mockCreateDoc: vi.fn(),
  mockListLots: vi.fn(),
}))

vi.mock('@/actions/inventory/docs', () => ({ createInventoryCoreDoc: mockCreateDoc }))
vi.mock('@/actions/inventory/stocks', () => ({ listInventoryLotOptions: mockListLots }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { InventoryDocCreateForm } from './inventory-doc-create-form'

const LOCATIONS = [
  { locationId: 'LOC-M1', orgNodeId: 'NODE-M1', name: '市场一部', locationType: '市场', isActive: true },
  { locationId: 'LOC-M2', orgNodeId: 'NODE-M2', name: '市场二部', locationType: '市场', isActive: true },
] as never

const SKUS = [
  { skuId: 'SKU-1', productCode: 'P001', productName: '测试商品' },
] as never

function renderForm(overrides: Record<string, unknown> = {}) {
  const onSuccess = vi.fn()
  const onStale = vi.fn()
  render(
    <InventoryDocCreateForm
      visible
      locations={LOCATIONS}
      skuOptions={SKUS}
      initialDocType={'市场产品盘溢' as never}
      allowedDocTypes={['市场产品盘溢'] as never}
      onSuccess={onSuccess}
      onStale={onStale}
      onBusyChange={() => {}}
      renderActions={({ submit, submitting }) => (
        <button type="button" onClick={submit} disabled={submitting}>提交</button>
      )}
      {...overrides}
    />,
  )
  return { onSuccess, onStale }
}

/** 填一行明细并选好主体，返回填好的数量输入框。 */
function fillOneLine() {
  // [0]=单据类型(锁定) [1]=出库/发起主体 [2]=入库/接收主体 [3]=明细 SKU
  // 盘溢不属于 SOURCE_LOT_DOC_TYPES，明细行没有批次下拉，所以 SKU 稳定在 index 3
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'NODE-M1' } })
  fireEvent.change(screen.getAllByRole('combobox')[2], { target: { value: 'NODE-M2' } })
  fireEvent.change(screen.getAllByRole('combobox')[3], { target: { value: 'SKU-1' } })
  const quantity = screen.getByPlaceholderText('数量')
  fireEvent.change(quantity, { target: { value: '7' } })
  fireEvent.change(screen.getByPlaceholderText('备注'), { target: { value: '本次备注' } })
  return quantity
}

describe('共享建单表单的清场行为（#191）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListLots.mockResolvedValue([])
    mockCreateDoc.mockResolvedValue({ success: true, id: 'FY-CK-260919-0001' })
  })

  it('提交成功后明细、备注、主体、日期全部回到初始草稿', async () => {
    const { onSuccess } = renderForm()
    const quantity = fillOneLine()
    expect((quantity as HTMLInputElement).value).toBe('7')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('FY-CK-260919-0001'))

    // 明细数量回到默认 '1'、备注清空
    expect((screen.getByPlaceholderText('数量') as HTMLInputElement).value).toBe('1')
    expect((screen.getByPlaceholderText('备注') as HTMLTextAreaElement).value).toBe('')
    /*
     * 主体必须一起清：盘点 / 报损 / 盘溢这些同主体类型在服务端走 `source ?? target`，
     * 残留的 source 会静默吃掉用户下一张单选的 target —— 界面返回成功单号，
     * 货却记在上一张单的主体上。
     */
    const selects = screen.getAllByRole('combobox')
    expect((selects[1] as HTMLSelectElement).value).toBe('')
    expect((selects[2] as HTMLSelectElement).value).toBe('')
  })

  it('提交成功后日期回到当天，不沿用建上一张单时的日期', async () => {
    /*
     * DatePicker 的值载体是 hidden input（改值要走日历面板），fireEvent 驱动不了它，
     * 所以用假时钟造一个「表单开着跨了天」的场景：挂载时是 1 月 5 日，提交时已是 9 月 19 日。
     * 不重置的话下一张单会静默沿用 1 月 5 日 —— 跨天挂着的工作区、或补录历史单之后
     * 接着建当天单，都会踩到。
     */
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-05T02:00:00Z'))
      renderForm()
      const dateInput = () => document.querySelector('[data-date-picker-value="date"]') as HTMLInputElement
      expect(dateInput().value).toBe('2026-01-05')

      vi.setSystemTime(new Date('2026-09-19T02:00:00Z'))
      fillOneLine()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '提交' }))
      })
      await waitFor(() => expect(mockCreateDoc).toHaveBeenCalled())
      // 这一张提交的仍是当时的 1 月 5 日
      expect(mockCreateDoc.mock.calls[0][0].docDate).toBe('2026-01-05')
      // 清场后回到「今天」
      await waitFor(() => expect(dateInput().value).toBe('2026-09-19'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('提交成功只调一次 action —— 清场后再点一次不会用旧内容重复建单', async () => {
    renderForm()
    fillOneLine()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(mockCreateDoc).toHaveBeenCalledTimes(1))

    // 清场后再点：明细已是空 SKU 的默认行，提交的内容不可能与上一张相同
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(mockCreateDoc).toHaveBeenCalledTimes(2))
    const secondPayload = mockCreateDoc.mock.calls[1][0]
    expect(secondPayload.items[0].skuId).toBeNull()
    expect(secondPayload.sourceOrgNodeId).toBeNull()
    expect(secondPayload.remark).toBe('')
  })

  it('提交失败时保留用户填的内容，不清场', async () => {
    // 失败后清场等于把用户敲的东西吞掉；动作弹窗只有一个备注框可以关掉重来，
    // 建单表单不行，两者取舍不同。
    mockCreateDoc.mockRejectedValue(new Error('INVALID_STATE: 库存不足'))
    const { onStale } = renderForm()
    fillOneLine()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    await waitFor(() => expect(onStale).toHaveBeenCalled())
    expect((screen.getByPlaceholderText('数量') as HTMLInputElement).value).toBe('7')
    expect((screen.getByPlaceholderText('备注') as HTMLTextAreaElement).value).toBe('本次备注')
  })

  it('提交在途时按钮被禁用，双击只发一次', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    mockCreateDoc.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }))
    renderForm()
    fillOneLine()

    const button = screen.getByRole('button', { name: '提交' })
    await act(async () => { fireEvent.click(button) })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(button) })
    expect(mockCreateDoc).toHaveBeenCalledTimes(1)

    await act(async () => { resolveCreate({ success: true, id: 'FY-CK-260919-0002' }) })
  })

  it('单一候选类型时单据类型下拉被锁住', async () => {
    // 不锁的话，用户能在「市场产品盘溢」的工作区里改选成别的类型，
    // 而卡片标题、单据 Tab 还都按盘溢显示。
    renderForm()
    const docTypeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(docTypeSelect.disabled).toBe(true)
    expect(docTypeSelect.value).toBe('市场产品盘溢')
  })
})

/**
 * 失败后批次自愈（#191 round-2 codex 点名：原先那条失败用例用的是不需要批次的
 * 「市场产品盘溢」，删掉 catch 里的缓存清理与推代次照样全绿）。
 *
 * 最常见的失败就是「别人并发扣了库存」：服务端回「可用 5」，而批次下拉还写着「可用 30」。
 * 办理台的 visible 恒真，不在失败路径刷新的话它**没有任何**重取入口，
 * 用户只能对着自相矛盾的数字反复盲试。
 */
describe('提交失败后批次重新取数（#191）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('失败后无需关闭工作区，批次下拉会重新取数并显示新的可用量', async () => {
    // 「市场产品报损」属于 SOURCE_LOT_DOC_TYPES，明细行带批次下拉
    mockListLots
      .mockResolvedValueOnce([{ id: 1, batchNo: 'B001', availableQuantity: 30, expiryDate: null }])
      .mockResolvedValue([{ id: 1, batchNo: 'B001', availableQuantity: 5, expiryDate: null }])
    mockCreateDoc.mockRejectedValue(new Error('INVALID_STATE: 库存不足：B001 可用 5'))

    render(
      <InventoryDocCreateForm
        visible
        locations={LOCATIONS}
        skuOptions={SKUS}
        initialDocType={'市场产品报损' as never}
        allowedDocTypes={['市场产品报损'] as never}
        onSuccess={vi.fn()}
        onStale={vi.fn()}
        onBusyChange={() => {}}
        renderActions={({ submit }) => (
          <button type="button" onClick={submit}>提交</button>
        )}
      />,
    )

    // 选主体 + SKU，触发第一次批次取数
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'NODE-M1' } })
    await act(async () => {
      // 报损有批次列，SKU 下拉在 index 4（[3] 是批次）
      fireEvent.change(screen.getAllByRole('combobox')[4], { target: { value: 'SKU-1' } })
    })
    await waitFor(() => expect(screen.getByText(/可用 30/)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '10' } })

    const callsBefore = mockListLots.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    // 失败后代次推进 → 同一个 (库位,SKU) 重新取数 → 下拉显示新的可用量
    await waitFor(() => expect(mockListLots.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() => expect(screen.getByText(/可用 5/)).toBeTruthy())
  })
})
