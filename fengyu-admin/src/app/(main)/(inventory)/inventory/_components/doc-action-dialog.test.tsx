import { StrictMode, useCallback, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from 'sonner'
import {
  DocActionDialog,
  DOC_ACTION_REMARK_MAX,
  type DocActionPending,
  type DocActionSpec,
} from './doc-action-dialog'

/*
 * 这个弹窗原本内嵌在 inventory-docs-page.tsx，#192 抽出来给办理台单据 Tab 共用。
 * inventory-docs-page.test.tsx 那 40+ 条用例仍是它在**单据中心场景**下的守护（零改动继续跑）；
 * 本文件守的是抽取本身带来的新面：配置驱动（另一套 kind / 文案 / 必填口径）、
 * 以及那几条父组件够不着的内部性质（提交凭证、常驻挂载、StrictMode、重渲染不丢输入）。
 */

beforeEach(() => {
  vi.resetAllMocks()
})

// 办理台单据 Tab 的动作集合：kind 与单据中心（approve/reject/receive）完全不同，
// 这正是「泛型化 kind」要服务的第二个场景。
type InboxKind = 'return-approve' | 'return-reject'

const DOC_ID = 'YTH-260901-0001'

function makeConfig(
  overrides: Partial<Record<InboxKind, Partial<DocActionSpec>>> = {},
): Record<InboxKind, DocActionSpec> {
  const base: Record<InboxKind, DocActionSpec> = {
    'return-approve': {
      title: '确认通过退货？',
      label: '审批备注',
      placeholder: '选填，将记录在单据的审批信息中',
      remarkRequired: false,
      consequence: '通过后将从退货主体出库并回库到上级主体，单据变为已完成，不可撤销。',
      confirmText: '确认通过',
      successMessage: (result) => {
        const inboundDocId = (result as { inboundDocId?: unknown } | null)?.inboundDocId
        return typeof inboundDocId === 'string' && inboundDocId
          ? `退货已通过，已生成入库单 ${inboundDocId}`
          : '退货已通过'
      },
      errorFallback: '审批失败',
      run: vi.fn(async () => undefined),
    },
    'return-reject': {
      title: '驳回退货申请',
      label: '驳回原因',
      placeholder: '请说明驳回原因，制单人可查看此说明',
      // 服务端 rejectReturnForRestock 是 required('驳回原因')，前端口径必须一致
      remarkRequired: true,
      confirmText: '确认驳回',
      confirmVariant: 'destructive',
      successMessage: () => '退货申请已驳回',
      errorFallback: '驳回失败',
      run: vi.fn(async () => undefined),
    },
  }
  for (const [kind, patch] of Object.entries(overrides) as [InboxKind, Partial<DocActionSpec>][]) {
    base[kind] = { ...base[kind], ...patch }
  }
  return base
}

/**
 * 最小调用方：复刻 inventory-docs-page / OperationDocsTab 共同的接线方式 ——
 * 开窗入口走**点击闸**（不是 disabled，否则 showModal() 记不到可聚焦的触发元素），
 * 弹窗**无条件渲染**（条件渲染会在权限翻转时把正开着的弹窗卸载 → 输入丢失 + 入口锁死）。
 */
function Harness({
  config,
  onDone,
  docId = DOC_ID,
  canAct = true,
}: {
  config: Record<InboxKind, DocActionSpec>
  onDone?: (finished: DocActionPending<InboxKind>) => void
  docId?: string
  /** 只影响行按钮，绝不参与弹窗的渲染条件 —— 这就是本组件的使用约束 */
  canAct?: boolean
}) {
  const [pending, setPending] = useState<DocActionPending<InboxKind> | null>(null)
  const [busy, setBusy] = useState(false)
  const open = (kind: InboxKind) => {
    if (pending || busy) return
    setPending({ kind, docId })
  }
  const handleDone = useCallback(
    (finished: DocActionPending<InboxKind>) => {
      onDone?.(finished)
      setPending(null)
    },
    [onDone],
  )
  return (
    <div>
      {canAct && (
        <>
          <button onClick={() => open('return-approve')}>通过</button>
          <button onClick={() => open('return-reject')}>驳回</button>
        </>
      )}
      <button onClick={() => undefined}>别处的按钮</button>
      <DocActionDialog
        config={config}
        pending={pending}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
        onDone={handleDone}
        onBusyChange={setBusy}
      />
    </div>
  )
}

/** pending 由外部控制：用来构造父组件在途切单这种正常接线下到不了的时序 */
function ControlledHarness({
  config,
  pending,
  onDone = () => undefined,
  onBusyChange = () => undefined,
}: {
  config: Record<InboxKind, DocActionSpec>
  pending: DocActionPending<InboxKind> | null
  onDone?: (finished: DocActionPending<InboxKind>) => void
  onBusyChange?: (busy: boolean) => void
}) {
  return (
    <DocActionDialog
      config={config}
      pending={pending}
      onOpenChange={() => undefined}
      onDone={onDone}
      onBusyChange={onBusyChange}
    />
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const actionDialog = () => screen.getByRole('dialog')
/** 走 `<label htmlFor>` ↔ `id` 的真实配对；必填项的可及名带着 `*`，故用正则 */
const remarkBox = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label}`)) as HTMLTextAreaElement

describe('DocActionDialog 由调用方的 config 驱动（#192 抽取）', () => {
  it('动作集合与文案完全来自 config，组件自己不认识任何具体动作', () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))

    const dialog = actionDialog()
    expect(within(dialog).getByText('驳回退货申请')).toBeInTheDocument()
    expect(within(dialog).getByText(`单据号 ${DOC_ID}`)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '确认驳回' })).toBeInTheDocument()
    expect(remarkBox('驳回原因')).toHaveAttribute(
      'placeholder',
      '请说明驳回原因，制单人可查看此说明',
    )
  })

  it('consequence 有就渲染、没有就不渲染（两个动作各走一边）', () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    expect(within(actionDialog()).getByText(/不可撤销/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(within(actionDialog()).queryByText(/不可撤销/)).not.toBeInTheDocument()
  })

  it('必填口径来自 config：必填项空着被拦，选填项留空照样提交', async () => {
    const config = makeConfig()
    render(<Harness config={config} />)

    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() =>
      expect(within(actionDialog()).getByText('请填写驳回原因')).toBeInTheDocument(),
    )
    expect(toast.error).toHaveBeenCalledWith('请填写驳回原因')
    expect(remarkBox('驳回原因')).toHaveAttribute('aria-invalid', 'true')
    expect(config['return-reject'].run).not.toHaveBeenCalled()
    // 行内红字不挂 role="alert"：同文案的 toast 已经在 live region 里播报过一次
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))
    await waitFor(() => expect(config['return-approve'].run).toHaveBeenCalledWith(DOC_ID, ''))
  })

  it.each([
    ['纯空白', '   \n  '],
    ['零宽空格', '\u200B\uFEFF'],
    ['方向标记', '\u200E\u200F'],
  ])('只填不可见内容同样算空（%s）', async (_label, value) => {
    const config = makeConfig()
    render(<Harness config={config} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('请填写驳回原因'))
    expect(config['return-reject'].run).not.toHaveBeenCalled()
  })

  it('提交的是 trim 后的原样输入，不因必填校验顺手改写正文', async () => {
    const config = makeConfig()
    render(<Harness config={config} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    // ZWJ 组合 emoji：清 Cf 只能用于「看起来是不是空的」，不能拿去落库
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '  已联系 👩\u200D⚕️ 复核  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() =>
      expect(config['return-reject'].run).toHaveBeenCalledWith(DOC_ID, '已联系 👩\u200D⚕️ 复核'),
    )
  })

  it('成功：把 action 的返回值交给 successMessage，并用 (kind, docId) 回调 onDone', async () => {
    const config = makeConfig({
      'return-approve': { run: vi.fn(async () => ({ inboundDocId: 'SCRK-260901-0007' })) },
    })
    const onDone = vi.fn()
    render(<Harness config={config} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('退货已通过，已生成入库单 SCRK-260901-0007'),
    )
    expect(onDone).toHaveBeenCalledWith({ kind: 'return-approve', docId: DOC_ID })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('字数上限与计数由组件统一提供（两个调用方口径一致）', () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(remarkBox('驳回原因')).toHaveAttribute('maxLength', String(DOC_ACTION_REMARK_MAX))
    expect(within(actionDialog()).getByText(`0/${DOC_ACTION_REMARK_MAX}`)).toBeInTheDocument()
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    expect(within(actionDialog()).getByText(`4/${DOC_ACTION_REMARK_MAX}`)).toBeInTheDocument()
  })
})

describe('DocActionDialog 的异常出路（抽取后仍按 9 项白名单判 stale）', () => {
  it.each([
    ['CONFLICT: 单据状态已被其他操作修改', '单据状态已被其他操作修改'],
    ['INVALID_STATE: 该退货单不是待审批状态', '该退货单不是待审批状态'],
    ['NOT_FOUND: 单据不存在或无权查看', '单据不存在或无权查看'],
    // HOF 层 requireAnyPermission 抛的 PermissionError：digest 是**裸前缀**，无冒号无文案。
    // 交给 actionErrorMessage 会把英文 token 原样甩给用户，所以要给统一说法。
    ['PERMISSION_DENIED', '单据状态或权限已变化，已为你刷新列表'],
  ])('状态型错误（%s）→ 提示 + 关窗交给 onDone', async (digest, expectedToast) => {
    const config = makeConfig({
      'return-approve': {
        run: vi.fn(async () => {
          throw Object.assign(new Error('sanitized'), { digest })
        }),
      },
    })
    const onDone = vi.fn()
    render(<Harness config={config} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expectedToast))
    // onDone 就是调用方「关弹窗 + 刷新列表 / 重取待办」的那个钩子：留着弹窗只会让人
    // 反复点同一个必失败的按钮
    expect(onDone).toHaveBeenCalledWith({ kind: 'return-approve', docId: DOC_ID })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('非状态型错误（网络抖动）→ 弹窗留着让人重试，不调 onDone', async () => {
    const config = makeConfig({
      'return-approve': {
        run: vi.fn(async () => {
          throw new Error('Failed to fetch')
        }),
      },
    })
    const onDone = vi.fn()
    render(<Harness config={config} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('审批失败'))
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // 失败后锁要解开，否则这张单再也提交不了
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '确认通过' })).toBeEnabled(),
    )
  })
})

describe('DocActionDialog 的提交锁', () => {
  it('在途时确认按钮 disabled，连点两次只调一次 action', async () => {
    const gate = deferred<void>()
    const config = makeConfig({ 'return-reject': { run: vi.fn(() => gate.promise) } })
    render(<Harness config={config} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '处理中…' }))
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(config['return-reject'].run).toHaveBeenCalledTimes(1)
  })

  it('旧请求的 finally 不解新请求的锁（submitTokenRef 凭证）', async () => {
    // 正常接线下父组件禁止「在途切单」，这条只有直接控制 pending 才到得了 ——
    // 也正因为够不着，拆掉凭证机制时没有任何上层用例会红。
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const run = vi
      .fn<(docId: string, remark: string) => Promise<unknown>>()
      .mockReturnValueOnce(gateA.promise)
      .mockReturnValueOnce(gateB.promise)
    const config = makeConfig({ 'return-reject': { run } })
    const onBusyChange = vi.fn()
    const pendingA: DocActionPending<InboxKind> = { kind: 'return-reject', docId: 'A' }
    const pendingB: DocActionPending<InboxKind> = { kind: 'return-reject', docId: 'B' }

    const { rerender } = render(
      <ControlledHarness config={config} pending={pendingA} onBusyChange={onBusyChange} />,
    )
    fireEvent.change(remarkBox('驳回原因'), { target: { value: 'A 的原因' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    // 切到 B：换一次提交周期，A 的凭证作废
    rerender(<ControlledHarness config={config} pending={pendingB} onBusyChange={onBusyChange} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '确认驳回' })).toBeEnabled())
    fireEvent.change(remarkBox('驳回原因'), { target: { value: 'B 的原因' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled())

    // A 先回来：它的 finally 无权解 B 的锁
    await act(async () => {
      gateA.resolve()
      await gateA.promise
    })
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    expect(onBusyChange).toHaveBeenLastCalledWith(true)

    await act(async () => {
      gateB.resolve()
      await gateB.promise
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '确认驳回' })).toBeEnabled())
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(2, 'B', 'B 的原因')
  })

  it('在途态上报父组件：开始 true、结束 false；整页卸载时归还 false', async () => {
    const gate = deferred<void>()
    const config = makeConfig({ 'return-reject': { run: vi.fn(() => gate.promise) } })
    const onBusyChange = vi.fn()
    const { unmount } = render(
      <ControlledHarness
        config={config}
        pending={{ kind: 'return-reject', docId: DOC_ID }}
        onBusyChange={onBusyChange}
      />,
    )
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true))

    unmount()
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })
})

describe('DocActionDialog 的无障碍与挂载性质', () => {
  it('label↔id 真实配对 + 弹窗有可及名称与可及描述', () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '通过' }))

    // getByLabelText 走的是 htmlFor ↔ id（组件上刻意不写 aria-label —— 它优先级更高，
    // 留着的话把 htmlFor 或 id 写错都测不出来）
    const box = remarkBox('审批备注')
    expect(box.tagName).toBe('TEXTAREA')
    const dialog = screen.getByRole('dialog', { name: '确认通过退货？' })
    expect(dialog).toHaveAccessibleDescription(new RegExp(DOC_ID))
    expect(dialog).toHaveAccessibleDescription(/不可撤销/)
  })

  it('校验提示与输入框用 aria-describedby 关联，且提示消失后关联也撤掉', async () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

    const errorText = await waitFor(() => within(actionDialog()).getByText('请填写驳回原因'))
    expect(errorText.id).toBeTruthy()
    expect(remarkBox('驳回原因')).toHaveAttribute('aria-describedby', errorText.id)

    fireEvent.change(remarkBox('驳回原因'), { target: { value: '数量不符' } })
    expect(remarkBox('驳回原因')).not.toHaveAttribute('aria-describedby')
    expect(remarkBox('驳回原因')).toHaveAttribute('aria-invalid', 'false')
  })

  it('打开即聚焦备注框；关掉换个动作重开仍然聚焦', async () => {
    render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    await waitFor(() => expect(remarkBox('驳回原因')).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    // 把焦点挪走，确保下面断言的是「重新聚焦」而不是「焦点恰好还在原处」
    screen.getByRole('button', { name: '别处的按钮' }).focus()
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    await waitFor(() => expect(remarkBox('审批备注')).toHaveFocus())
  })

  it('关闭不卸载：<dialog> 仍在 DOM（焦点才还得回触发按钮），重开时输入已清空', () => {
    const { container } = render(<Harness config={makeConfig()} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '写了一半又反悔' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    const dialogEl = container.querySelector('dialog')
    expect(dialogEl).not.toBeNull()
    expect(dialogEl!.open).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(remarkBox('驳回原因')).toHaveValue('')
  })

  it('StrictMode 下照常打开 —— cleanup 里补的 close() 不会反向关掉刚开的弹窗', async () => {
    render(
      <StrictMode>
        <Harness config={makeConfig()} />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(remarkBox('驳回原因')).toHaveFocus())
  })

  it('权限翻转（父组件重渲染）不卸载弹窗：输入还在，关掉后自行解锁', () => {
    // #134 评审 R9 的真死锁：`{canAct && <DocActionDialog/>}` 在权限收回时把正开着的弹窗
    // 整个卸载 —— 用户填的备注没了，而父组件的 pending 仍非空 → 开窗入口被点击闸锁死。
    // 组件侧能守的是「只要调用方不卸载它，state 就不丢」。
    const config = makeConfig()
    const { rerender } = render(<Harness config={config} />)
    fireEvent.click(screen.getByRole('button', { name: '驳回' }))
    fireEvent.change(remarkBox('驳回原因'), { target: { value: '填了一半' } })

    rerender(<Harness config={config} canAct={false} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(remarkBox('驳回原因')).toHaveValue('填了一半')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('config 换成不含当前 kind 的那一套（切业务）时不白屏', () => {
    const config = makeConfig()
    const { rerender, container } = render(
      <ControlledHarness config={config} pending={{ kind: 'return-reject', docId: DOC_ID }} />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // 关窗后切到另一套动作表：快照里还存着 return-reject，而新表里没有它
    rerender(<ControlledHarness config={config} pending={null} />)
    const shrunk = { 'return-approve': config['return-approve'] } as Record<InboxKind, DocActionSpec>
    expect(() =>
      rerender(<ControlledHarness config={shrunk} pending={null} />),
    ).not.toThrow()
    expect(container.querySelector('dialog')).toBeNull()
  })
})
