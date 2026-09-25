/**
 * 共享建单表单的**行为**测试（#191）。
 *
 * 同目录另外两个测试文件走「读源码正则」的守护风格（那两个组件一个 2800 行、一个 600 行，
 * 渲染 mock 成本远高于收益）。但清场这件事不一样：它防的是「用户再点一次就多建一张
 * 实扣库存的单」，而正则只能证明 `setItems([defaultItem(docType)])` 这行字还在源码里 ——
 * 证明不了它真的在提交成功后跑到了、更证明不了跑的顺序对。
 * 这个组件依赖少（两个 action + 几个 UI 组件），值得用真渲染钉住。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreateDoc, mockListLots } = vi.hoisted(() => ({
  mockCreateDoc: vi.fn(),
  mockListLots: vi.fn(),
}))

vi.mock('@/actions/inventory/docs', () => ({ createInventoryCoreDoc: mockCreateDoc }))
vi.mock('@/actions/inventory/stocks', () => ({ listInventoryLotOptions: mockListLots }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./inventory-sku-search-select', () => import('./__stubs__/inventory-sku-search-select.stub'))

import { InventoryDocCreateForm } from './inventory-doc-create-form'

const LOCATIONS = [
  { locationId: 'LOC-M1', orgNodeId: 'NODE-M1', name: '市场一部', locationType: '市场', isActive: true },
  { locationId: 'LOC-M2', orgNodeId: 'NODE-M2', name: '市场二部', locationType: '市场', isActive: true },
] as never

function renderForm(overrides: Record<string, unknown> = {}) {
  const onSuccess = vi.fn()
  const onStale = vi.fn()
  render(
    <InventoryDocCreateForm
      visible
      locations={LOCATIONS}
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

/**
 * 按「占位 option 的文案」拿到对应的 select。
 *
 * 比数 `getAllByRole('combobox')` 的下标稳：主体字段走 InventorySubjectSelect，
 * 候选唯一时会降级成只读 `<output>`（根本不是 combobox），批次列还会随 docType
 * 出现或消失 —— 下标一错，断言就悄悄落到别的字段上。
 */
function selectByPlaceholder(placeholder: string): HTMLSelectElement {
  const option = screen.getByRole('option', { name: placeholder })
  const select = option.closest('select')
  expect(select, `找不到占位为「${placeholder}」的下拉`).not.toBeNull()
  return select as HTMLSelectElement
}

/** 填一行明细并选好主体，返回填好的数量输入框。 */
function fillOneLine() {
  fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
  fireEvent.change(selectByPlaceholder('入库/接收主体'), { target: { value: 'NODE-M2' } })
  fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
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
    expect(selectByPlaceholder('出库/发起主体').value).toBe('')
    expect(selectByPlaceholder('入库/接收主体').value).toBe('')
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
    const docTypeSelect = screen.getByRole('option', { name: '市场产品盘溢' }).closest('select') as HTMLSelectElement
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
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    await act(async () => {
      fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
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

/**
 * 主体字段走 InventorySubjectSelect（#189 的改造覆盖到共享建单表单）。
 *
 * #189 把办理台 17 处主体字段统一换成了这个组件（候选唯一时自动选中 + 只读展示），
 * 但它的守护只数**办理台那一个文件**里的出现次数 —— 数不到这里。
 * #191 把建单表单抽成共享组件后，办理台里会同时出现两种主体选择器：
 * 内置表单的（智能）和通用业务的（裸 Select，要手点一次），而任何测试都不会红。
 */
describe('共享建单表单的主体字段（#189 × #191）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListLots.mockResolvedValue([])
    mockCreateDoc.mockResolvedValue({ success: true, id: 'FY-CK-260921-0001' })
  })

  it('候选唯一时自动选中并降级成只读展示，不必手点一次', async () => {
    // 只有一个市场主体的环境（市场角色只管一个市场、门店角色只管一家店都会这样）
    const soleLocation = [
      { locationId: 'LOC-M1', orgNodeId: 'NODE-M1', name: '市场一部', locationType: '市场', isActive: true },
    ] as never

    render(
      <InventoryDocCreateForm
        visible
        locations={soleLocation}
        initialDocType={'市场产品盘溢' as never}
        allowedDocTypes={['市场产品盘溢'] as never}
        onSuccess={vi.fn()}
        onStale={vi.fn()}
        onBusyChange={() => {}}
        renderActions={({ submit }) => <button type="button" onClick={submit}>提交</button>}
      />,
    )

    // 值落定后才挂 data-fixed-subject —— 它是「已自动选中」的唯一证据
    await waitFor(() => {
      expect(document.querySelectorAll('[data-fixed-subject="NODE-M1"]').length).toBe(2)
    })
    // 降级成只读后就不再是 combobox（出库/入库两个都应如此）
    expect(screen.queryByRole('option', { name: '出库/发起主体' })).toBeNull()
    expect(screen.queryByRole('option', { name: '入库/接收主体' })).toBeNull()
    /*
     * 只读降级会把占位文案一起带走，两个字段都变成「市场 · 市场一部」。
     * 没有可见 label 的话，用户和读屏都分不清哪个是出库、哪个是入库 ——
     * 这是换成 InventorySubjectSelect 才会有的退化，必须由 label 兜住。
     */
    for (const fieldName of ['出库/发起主体', '入库/接收主体']) {
      const label = screen.getByText(fieldName)
      expect(label.parentElement?.textContent, fieldName).toContain('市场一部')
    }

    // 自动选中的值必须真的进了表单 state：提交时带出去的就是它
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '3' } })
    fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(mockCreateDoc).toHaveBeenCalled())
    const payload = mockCreateDoc.mock.calls[0][0]
    /*
     * ⚠️ 必须是 orgNodeId 不是 locationId。InventorySubjectSelect 的两种 id 空间
     * 由调用方决定：总部与市场两者同值，**门店不同** —— 传错只有门店会炸，
     * 在只有总部/市场的环境里怎么点都测不出来。
     */
    expect(payload.sourceOrgNodeId).toBe('NODE-M1')
    expect(payload.targetOrgNodeId).toBe('NODE-M1')
  })

  it('候选多于一个时仍是普通下拉，不会替用户做选择', async () => {
    renderForm()
    expect(selectByPlaceholder('出库/发起主体').value).toBe('')
    expect(selectByPlaceholder('入库/接收主体').value).toBe('')
    expect(document.querySelector('[data-fixed-subject]')).toBeNull()
  })

  it('源码守护：主体 state 不得退回裸 Select', () => {
    // 与办理台那条守护同构（#189）：换回 <Select> 不会让任何行为测试变红 ——
    // 多候选环境下两者看起来一模一样，回退的后果只有在单候选环境才显形。
    const source = readFileSync(resolve(__dirname, 'inventory-doc-create-form.tsx'), 'utf8')
    expect(source.match(/<InventorySubjectSelect/g) ?? []).toHaveLength(2)
    for (const state of ['sourceOrgNodeId', 'targetOrgNodeId']) {
      expect(source).not.toMatch(new RegExp(`<Select value=\\{${state}\\}`))
    }
  })
})

/**
 * 批次取数用的是 **locationId**，不是主体字段的 orgNodeId（#191 增量评审 codex P3-2）。
 *
 * 表单里两种 id 同时存在：主体 state 存 `orgNodeId`（提交要它），批次接口要 `locationId`，
 * 中间靠 `locations.find(l => l.orgNodeId === sourceOrgNodeId)?.locationId` 反查。
 * **总部与市场两者同值，只有门店不同** —— 把反查去掉、直接拿 orgNodeId 去查批次，
 * 在只有总部/市场的环境里怎么点都正常，一上门店就查不到任何批次。
 * 所以这条用例刻意用 `locationId !== orgNodeId` 的门店主体。
 */
describe('批次取数的 id 空间（#191）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateDoc.mockResolvedValue({ success: true, id: 'FY-CK-260921-0002' })
  })

  it('门店主体下，批次接口收到的是 store 的 locationId 而不是 orgNodeId', async () => {
    mockListLots.mockResolvedValue([{ id: 9, batchNo: 'B009', availableQuantity: 12, expiryDate: null }])
    // 门店：locationId(STORE-S1) 与 orgNodeId(NODE-S1) 是两个不同的值
    const storeLocation = [
      { locationId: 'STORE-S1', orgNodeId: 'NODE-S1', name: '象湖店', locationType: '门店', isActive: true },
    ] as never

    render(
      <InventoryDocCreateForm
        visible
        locations={storeLocation}
        initialDocType={'院产品报损' as never}
        allowedDocTypes={['院产品报损'] as never}
        onSuccess={vi.fn()}
        onStale={vi.fn()}
        onBusyChange={() => {}}
        renderActions={({ submit }) => <button type="button" onClick={submit}>提交</button>}
      />,
    )

    // 唯一候选会自动选中；选 SKU 后触发批次取数
    await waitFor(() => expect(document.querySelectorAll('[data-fixed-subject="NODE-S1"]').length).toBe(2))
    await act(async () => {
      fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
    })

    await waitFor(() => expect(mockListLots).toHaveBeenCalled())
    expect(mockListLots).toHaveBeenCalledWith('STORE-S1', 'SKU-1')
    // 反向：绝不能拿 orgNodeId 去查
    expect(mockListLots).not.toHaveBeenCalledWith('NODE-S1', 'SKU-1')

    // 而提交带出去的仍是 orgNodeId
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '2' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(mockCreateDoc).toHaveBeenCalled())
    expect(mockCreateDoc.mock.calls[0][0].sourceOrgNodeId).toBe('NODE-S1')
  })
})

describe('市场间调货出库的接收主体候选（#340）', () => {
  /** 单市场账号：scope 内只有自己的市场与下属门店 */
  const SCOPED_LOCATIONS = [
    { locationId: 'LOC-M1', orgNodeId: 'NODE-M1', name: '市场一部', locationType: '市场', isActive: true },
    { locationId: 'S1', orgNodeId: 'NODE-S1', name: '一部门店', locationType: '门店', isActive: true },
  ] as never
  /** 不按 scope 的全部启用市场（含调出市场自己） */
  const TARGETS = [
    { orgNodeId: 'NODE-M1', name: '市场一部' },
    { orgNodeId: 'NODE-M2', name: '市场二部' },
    { orgNodeId: 'NODE-M3', name: '市场三部' },
  ]

  function optionValues(select: HTMLSelectElement) {
    return [...select.options].map((option) => option.value).filter(Boolean)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockListLots.mockResolvedValue([])
    mockCreateDoc.mockResolvedValue({ success: true, id: 'MTO-260924-0001' })
  })

  it('单市场账号：发起端自动带出本市场，接收端列出其他市场、不含自己', () => {
    renderForm({
      locations: SCOPED_LOCATIONS,
      marketTransferTargets: TARGETS,
      initialDocType: '市场间调货出库',
      allowedDocTypes: ['市场间调货出库'],
    })
    // 发起端只留市场 → 唯一候选 → 只读并已落定（门店不在市场间调货的发起候选里）
    expect(document.querySelector('output[data-fixed-subject="NODE-M1"]')).not.toBeNull()
    const target = selectByPlaceholder('入库/接收主体')
    expect(optionValues(target)).toEqual(['NODE-M2', 'NODE-M3'])
  })

  it('能以 scope 外的市场为接收主体提交', async () => {
    const { onSuccess } = renderForm({
      locations: SCOPED_LOCATIONS,
      marketTransferTargets: TARGETS,
      initialDocType: '市场间调货出库',
      allowedDocTypes: ['市场间调货出库'],
    })
    fireEvent.change(selectByPlaceholder('入库/接收主体'), { target: { value: 'NODE-M3' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('MTO-260924-0001'))
    expect(mockCreateDoc).toHaveBeenCalledWith(expect.objectContaining({
      docType: '市场间调货出库',
      sourceOrgNodeId: 'NODE-M1',
      targetOrgNodeId: 'NODE-M3',
    }))
  })

  it('多市场账号把发起市场改成已选的接收市场时，接收端被清空', () => {
    renderForm({
      locations: LOCATIONS,
      marketTransferTargets: TARGETS,
      initialDocType: '市场间调货出库',
      allowedDocTypes: ['市场间调货出库'],
    })
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    fireEvent.change(selectByPlaceholder('入库/接收主体'), { target: { value: 'NODE-M2' } })
    expect(selectByPlaceholder('入库/接收主体').value).toBe('NODE-M2')
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M2' } })
    const target = selectByPlaceholder('入库/接收主体')
    expect(target.value).toBe('')
    expect(optionValues(target)).toEqual(['NODE-M1', 'NODE-M3'])
  })

  it('全局只有一个启用市场：接收端不会被自动填成发起市场自己', () => {
    renderForm({
      locations: SCOPED_LOCATIONS,
      marketTransferTargets: [{ orgNodeId: 'NODE-M1', name: '市场一部' }],
      initialDocType: '市场间调货出库',
      allowedDocTypes: ['市场间调货出库'],
    })
    expect(document.querySelector('output[data-fixed-subject="NODE-M1"]')).not.toBeNull()
    const target = selectByPlaceholder('暂无可用主体')
    expect(target.value).toBe('')
    expect(target.disabled).toBe(true)
  })

  it('其他单据类型（分院调货出库）的接收主体候选与改前一致：仍取 scope 内 locations', () => {
    renderForm({
      locations: SCOPED_LOCATIONS,
      marketTransferTargets: TARGETS,
      initialDocType: '分院调货出库',
      allowedDocTypes: ['分院调货出库'],
    })
    expect(optionValues(selectByPlaceholder('入库/接收主体'))).toEqual(['NODE-M1', 'NODE-S1'])
    expect(optionValues(selectByPlaceholder('出库/发起主体'))).toEqual(['NODE-M1', 'NODE-S1'])
  })
})

describe('盘点单实盘数：0 可提交、留空拦下（#351）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListLots.mockResolvedValue([])
    mockCreateDoc.mockResolvedValue({ success: true, id: 'FY-MPD-260925-0001' })
  })

  function renderStocktake() {
    return renderForm({ initialDocType: '市场库存盘点', allowedDocTypes: ['市场库存盘点'] })
  }

  function fillStocktakeLine(quantity: string) {
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: quantity } })
  }

  it('实盘填 0 照常提交，payload 里的数量就是 0', async () => {
    const { onSuccess } = renderStocktake()
    fillStocktakeLine('0')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('FY-MPD-260925-0001'))
    expect(mockCreateDoc).toHaveBeenCalledWith(expect.objectContaining({
      docType: '市场库存盘点',
      items: [expect.objectContaining({ skuId: 'SKU-1', quantity: 0 })],
    }))
  })

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
  ])('实盘数留空（%s）不提交，提示第几行要填', async (_label, value) => {
    const { toast } = await import('sonner')
    renderStocktake()
    fillStocktakeLine(value)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    // 不拦的话 `Number('' || 0)` 会把这行当成「实盘 0」送出去，凭空多一笔盘亏
    expect(mockCreateDoc).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('明细 1 请填写实盘数（货架上没有就填 0）')
  })

  it('盘点新行数量默认留空：不填直接提交被拦（默认 1 会被当成「实盘 1」）', async () => {
    const { toast } = await import('sonner')
    renderStocktake()
    expect((screen.getByPlaceholderText('数量') as HTMLInputElement).value).toBe('')
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    expect(mockCreateDoc).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('明细 1 请填写实盘数（货架上没有就填 0）')
    // 「添加明细」加出来的行同样留空
    fireEvent.click(screen.getByRole('button', { name: '添加明细' }))
    expect(screen.getAllByPlaceholderText('数量').map((el) => (el as HTMLInputElement).value)).toEqual(['', ''])
  })

  it('在盘点与非盘点之间切类型时，数量回到新类型的默认值', () => {
    renderForm({ initialDocType: undefined, allowedDocTypes: ['市场产品盘溢', '市场库存盘点'] })
    const docTypeSelect = screen.getByRole('option', { name: '市场库存盘点' }).closest('select') as HTMLSelectElement
    const quantity = () => (screen.getByPlaceholderText('数量') as HTMLInputElement).value
    // 不传 initialDocType：类型下拉可切（传了会被 isDocTypeLocked 锁死，本用例就测不到真实交互）
    expect(docTypeSelect.disabled).toBe(false)
    expect(docTypeSelect.value).toBe('市场产品盘溢')
    expect(quantity()).toBe('1')

    fireEvent.change(docTypeSelect, { target: { value: '市场库存盘点' } })
    expect(quantity(), '盘溢的「1」不能带进盘点当实盘 1').toBe('')

    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '0' } })
    fireEvent.change(docTypeSelect, { target: { value: '市场产品盘溢' } })
    expect(quantity(), '盘点的 0 带回盘溢必被拒').toBe('1')
  })

  it('提交在途时单据类型锁住：否则成功清场会按旧类型把盘点行重置成「1」', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    mockCreateDoc.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    const { onSuccess } = renderForm({ initialDocType: undefined, allowedDocTypes: ['市场产品盘溢', '市场库存盘点'] })
    const docTypeSelect = screen.getByRole('option', { name: '市场库存盘点' }).closest('select') as HTMLSelectElement
    expect(docTypeSelect.disabled, '前提：空闲时类型可切').toBe(false)
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    expect(docTypeSelect.disabled, '在途时类型下拉必须禁用').toBe(true)
    // 即便绕过 disabled 直接派发 change，也不能换类型
    fireEvent.change(docTypeSelect, { target: { value: '市场库存盘点' } })

    await act(async () => {
      resolveCreate({ success: true, id: 'FY-PY-260925-0001' })
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('FY-PY-260925-0001'))
    expect(docTypeSelect.value).toBe('市场产品盘溢')
    expect((screen.getByPlaceholderText('数量') as HTMLInputElement).value).toBe('1')
    await waitFor(() => expect(docTypeSelect.disabled).toBe(false))
  })

  it('非盘点单不受留空拦截影响：仍交给服务端按「必须大于 0」判', async () => {
    renderForm()
    fireEvent.change(selectByPlaceholder('出库/发起主体'), { target: { value: 'NODE-M1' } })
    fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })

    expect(mockCreateDoc).toHaveBeenCalledWith(expect.objectContaining({
      docType: '市场产品盘溢',
      items: [expect.objectContaining({ quantity: 0 })],
    }))
  })
})

describe('市场间调货批次的赠送标记与参考进价（#359）', () => {
  const SCOPED_LOCATIONS = [
    { locationId: 'LOC-M1', orgNodeId: 'NODE-M1', name: '市场一部', locationType: '市场', isActive: true },
  ] as never
  const TARGETS = [{ orgNodeId: 'NODE-M1', name: '市场一部' }, { orgNodeId: 'NODE-M2', name: '市场二部' }]
  const LOTS = [
    { id: 1, batchNo: 'B001', isGift: false, availableQuantity: 8, expiryDate: null, marketActualUnitPrice: 27 },
    { id: 2, batchNo: 'G002', isGift: true, availableQuantity: 3, expiryDate: null, marketActualUnitPrice: 0 },
  ]
  const referenceNote = () => screen.queryByRole('note', { name: '明细 1 来源批次参考进价' })

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateDoc.mockResolvedValue({ success: true, id: 'MTO-260925-0001' })
  })

  async function openTransfer(docType = '市场间调货出库', lots: unknown[] = LOTS) {
    mockListLots.mockResolvedValue(lots)
    const result = renderForm({
      locations: SCOPED_LOCATIONS,
      marketTransferTargets: TARGETS,
      initialDocType: docType,
      allowedDocTypes: [docType],
    })
    await act(async () => {
      fireEvent.change(selectByPlaceholder('库存 SKU'), { target: { value: 'SKU-1' } })
    })
    await waitFor(() => expect(screen.getByRole('option', { name: /^B001 · 可用 8$/ })).toBeTruthy())
    return { ...result, lotSelect: screen.getByRole('combobox', { name: '明细 1 来源批次' }) as HTMLSelectElement }
  }

  it('选项带赠送标记；选中批次显示黄色参考进价并随切换更新；提交 payload 不含参考价', async () => {
    const { lotSelect } = await openTransfer()
    expect(screen.getByRole('option', { name: /^G002（赠送） · 可用 3$/ })).toBeTruthy()
    expect(referenceNote()).toBeNull()
    fireEvent.change(lotSelect, { target: { value: '1' } })
    expect(referenceNote()?.textContent).toBe('参考进价 27.00')
    fireEvent.change(lotSelect, { target: { value: '2' } })
    expect(referenceNote()?.textContent).toBe('参考进价 0.00（赠送批次）')
    // 改数量不影响参考值
    fireEvent.change(screen.getByPlaceholderText('数量'), { target: { value: '2' } })
    expect(referenceNote()?.textContent).toBe('参考进价 0.00（赠送批次）')

    // 接收端除自己外只剩市场二部：唯一候选自动落定
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
    })
    await waitFor(() => expect(mockCreateDoc).toHaveBeenCalledTimes(1))
    expect(mockCreateDoc.mock.calls[0][0]).toMatchObject({ docType: '市场间调货出库', targetOrgNodeId: 'NODE-M2' })
    expect(JSON.stringify(mockCreateDoc.mock.calls[0][0])).not.toMatch(/marketActualUnitPrice|参考/)
  })

  it('无价格档（接口不下发 marketActualUnitPrice）不渲染参考进价', async () => {
    const { lotSelect } = await openTransfer('市场间调货出库', LOTS.map(({ marketActualUnitPrice: _price, ...lot }) => lot))
    fireEvent.change(lotSelect, { target: { value: '1' } })
    expect(referenceNote()).toBeNull()
  })

  it('其他出库类型（市场产品报损）只加赠送标记，不显示参考进价', async () => {
    const { lotSelect } = await openTransfer('市场产品报损')
    expect(screen.getByRole('option', { name: /^G002（赠送） · 可用 3$/ })).toBeTruthy()
    fireEvent.change(lotSelect, { target: { value: '1' } })
    expect(referenceNote()).toBeNull()
  })
})
