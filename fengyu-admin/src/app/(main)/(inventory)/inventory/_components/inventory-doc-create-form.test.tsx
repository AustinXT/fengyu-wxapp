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
