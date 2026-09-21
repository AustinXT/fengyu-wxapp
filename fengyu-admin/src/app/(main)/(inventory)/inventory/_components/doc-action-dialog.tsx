'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { docActionErrorMessage, isStaleStateError } from '@/lib/inventory/doc-action-error'

/*
 * 库存单据的「备注 + 确认」弹窗，单据中心与办理台单据 Tab 共用同一份（#192 从
 * inventory-docs-page.tsx 原样抽出，行为是 #134 十轮评审收敛的结果，别顺手简化）。
 *
 * 两个调用方的差异全部走 `config`：动作集合、文案、是否必填备注、跑哪个 Server Action
 * 由调用方给；「动作跑完之后做什么」（刷新列表 / 重取待办）由 `onDone` 决定。
 *
 * 调用方必须守住的两条前提（组件自己保证不了）：
 * 1. **无条件渲染**，不要写成 `{canAct && <DocActionDialog/>}` —— 权限翻转时条件渲染会把
 *    正开着的弹窗整个卸载：用户填的备注没了，而父组件的 pending 仍非空 → 开窗入口被点击闸
 *    永久锁死，只能整页重载（#134 评审 R9 抓到的真死锁）。
 * 2. 开窗入口走**点击闸**（`onClick` 里 `if (busy) return`）而不是 `disabled`：点下去就
 *    disable 会让 `showModal()` 记不到「打开前的焦点」，关闭后焦点回不到触发按钮上。
 */

export const DOC_ACTION_REMARK_MAX = 300

/**
 * Unicode 格式字符（`Cf` 类）：零宽空格、LRM/RLM 方向标记、方向隔离符等。
 * 肉眼看不见，`trim()` 也吃不掉。从聊天软件/表格/富文本复制过来的文本常带，
 * 不清掉就能拿「看起来是空的」的输入绕过必填。
 */
const INVISIBLE_FORMAT_RE = /\p{Cf}/gu

/** 一个动作的全部可变部分：文案、校验口径、以及真正要跑的那个 Server Action。 */
export interface DocActionSpec {
  /** 弹窗标题，同时作为弹窗的可及名称 */
  title: string
  /** 备注框的 label，也是校验提示里的那个词（「请填写{label}」） */
  label: string
  placeholder: string
  /** 备注是否必填。必填口径要与服务端一致：服务端 required 的一律填 true */
  remarkRequired: boolean
  /** 提交后不可撤销的后果，渲染在标题下方。没有后果的动作留空。 */
  consequence?: string
  confirmText: string
  confirmVariant?: 'destructive'
  successMessage: (result: unknown) => string
  errorFallback: string
  run: (docId: string, remark: string) => Promise<unknown>
}

/** 当前挂在弹窗上的那一项：哪个动作、哪张单。 */
export interface DocActionPending<K extends string> {
  kind: K
  docId: string
}

export function DocActionDialog<K extends string>({
  config,
  pending,
  onOpenChange,
  onDone,
  onBusyChange,
}: {
  /**
   * 动作配置表。**必须覆盖 `pending.kind` 可能出现的每一个 kind** ——
   * 不走弹窗的动作（例如办理台的「去收货」只做表单跳转）别放进 pending 的类型里。
   */
  config: Readonly<Record<K, DocActionSpec>>
  pending: DocActionPending<K> | null
  onOpenChange: (open: boolean) => void
  /** 动作已经有结论（成功、或状态型失败已关窗）：调用方在这里关弹窗 + 刷新数据 */
  onDone: (finished: DocActionPending<K>) => void
  /**
   * 把「有动作在途」上报给父组件，用来把行操作按钮一起锁住。
   * **必须传稳定引用**（`setState` 或 `useCallback`）：下面那个 effect 的 cleanup 会在引用
   * 变化时补一次 `onBusyChange(false)`，内联箭头等于每次重渲都把在途态闪断一下。
   */
  onBusyChange: (busy: boolean) => void
}) {
  const remarkId = useId()
  const errorId = `${remarkId}-error`
  const descriptionId = `${remarkId}-desc`
  const remarkRef = useRef<HTMLTextAreaElement>(null)
  // 每个提交自己持有一张「凭证」，只有凭证还是自己的那次才有资格解锁 ——
  // 防的是「A 在途 → 换到 B → B 提交 → A 先回来，A 的 finally 把 B 的锁解了」。
  // 第一道闸在父组件（弹窗开着 / 在途时，开窗入口走点击闸拦住，见 anyDialogOpen），这里是第二道：
  // 万一将来有人拆了那道闸，至少锁的归属还是对的。
  const submitTokenRef = useRef(0)
  const [remark, setRemark] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 关闭时**不卸载**，走 open=false 让原生 dialog.close() 正常执行 —— 焦点才会还给
  // 触发它的那个按钮（前提是那个按钮在 showModal() 时仍可聚焦，所以开窗入口用点击闸
  // 而不是 disabled，见 anyDialogOpen 的注释）
  //（历史：曾在 dialog.tsx 的卸载 cleanup 里补一次 close() 来救焦点，后因 StrictMode 下
  //  排队的 close 事件会在监听重挂后到达、反向关掉刚开的弹窗而撤销，改成现在这套。），也才不会踩「卸载期补 close()、排队的
  // close 事件在 StrictMode 重挂监听后才到达」那个坑。代价是关闭后还要拿着上一次的配置
  // 渲染（隐藏态），故留一份快照。同目录的 CreateDocDialog 用的也是常驻挂载。
  const [snapshot, setSnapshot] = useState(pending)
  useEffect(() => {
    if (pending) setSnapshot(pending)
  }, [pending])
  // 关闭（以及理论上的换单据）都把输入与在途态清干净 —— 弹窗常驻挂载，state 不会随卸载消失。
  // 注：现在父组件保证「同时只开一个弹窗」，A→B 直切已不可达，这里主要覆盖的是关闭路径。
  const resetKey = pending ? `${pending.kind}:${pending.docId}` : ''
  useEffect(() => {
    setRemark('')
    setTouched(false)
    // 换单据/换动作 = 换一次提交周期：作废上一张凭证，上一次的 finally 就管不到这一次了
    submitTokenRef.current += 1
    setSubmitting(false)
  }, [resetKey])

  // showModal() 在 layout effect 里跑，那之前 <dialog> 还是 display:none，React 的
  // autoFocus 会静默失败；而常驻挂载后 textarea 从第二次打开起也不会再重挂。
  // 所以焦点得在 passive effect 里自己给 —— 否则焦点停在右上角的 X 上，
  // 键盘用户一个 Enter 就把弹窗关了。
  useEffect(() => {
    if (pending) remarkRef.current?.focus()
  }, [resetKey, pending])

  useEffect(() => {
    onBusyChange(submitting)
  }, [submitting, onBusyChange])
  // 卸载时把在途态归还给父组件。DocActionDialog 在调用方里是无条件渲染的（见文件头第 1 条），
  // 这条只在整页卸载时触发，属纯防御。
  useEffect(() => () => onBusyChange(false), [onBusyChange])

  const active = pending ?? snapshot
  if (!active) return null
  const spec = config[active.kind]
  // 泛型化带来的新风险：快照里的 kind 可能不在**换过一茬**的 config 里（调用方按业务现算
  // config 时）。此时没有任何可渲染的文案，直接收摊而不是抛 TypeError 白屏。
  // 正常路径（config 覆盖全部 kind）永远走不到这里。
  if (!spec) return null
  // 提交的是用户原样输入（只 trim 首尾空白）；清 Cf 字符只用来判「看起来是不是空的」——
  // 否则 ZWJ 组合 emoji、阿拉伯语方向控制符会在落库时被悄悄改写。
  const submittedRemark = remark.trim()
  const missing = spec.remarkRequired && !remark.replace(INVISIBLE_FORMAT_RE, '').trim()

  async function submit() {
    if (!pending || submitting) return
    setTouched(true)
    if (missing) {
      toast.error(`请填写${spec.label}`)
      return
    }
    setSubmitting(true)
    const token = ++submitTokenRef.current
    try {
      const result = await spec.run(pending.docId, submittedRemark)
      toast.success(spec.successMessage(result))
      onDone(pending)
    } catch (err) {
      toast.error(docActionErrorMessage(err, spec.errorFallback))
      // 单据已被别人改过时，留着弹窗只会让人反复点同一个必失败的按钮：
      // 列表也还是旧状态，按钮照样在。关掉 + 刷新，才是有出路的处理。
      if (isStaleStateError(err)) onDone(pending)
    } finally {
      // 凭证被换单据/换动作作废过的话，这次的 finally 无权解锁
      if (submitTokenRef.current === token) setSubmitting(false)
    }
  }

  return (
    // 提交在途时禁止遮罩/ESC 关闭：Server Action 无法中止，「关掉了」≠「取消了」，
    // 而审批通过是实扣库存且不可撤销的。三条关闭路径必须同一口径。
    <Dialog
      open={pending !== null}
      onOpenChange={onOpenChange}
      dismissible={!submitting}
      ariaLabel={spec.title}
      ariaDescribedBy={descriptionId}
    >
      {!submitting && <DialogClose onOpenChange={onOpenChange} />}
      <DialogHeader>
        <DialogTitle>{spec.title}</DialogTitle>
        <DialogDescription id={descriptionId}>
          单据号 {active.docId}
          {spec.consequence && (
            <>
              <br />
              {spec.consequence}
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium" htmlFor={remarkId}>
          {spec.label}
          {spec.remarkRequired && <span className="text-[var(--primary)]"> *</span>}
        </label>
        <Textarea
          // key 用 resetKey：换单据时把 textarea 整个重挂，丢掉滚动位置、选区这些 DOM 内部状态
          // （value 本身是受控的，靠 state 复位，不靠 key）
          key={resetKey}
          id={remarkId}
          ref={remarkRef}
          aria-required={spec.remarkRequired}
          aria-invalid={touched && missing}
          aria-describedby={touched && missing ? errorId : undefined}
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          rows={4}
          maxLength={DOC_ACTION_REMARK_MAX}
          placeholder={spec.placeholder}
        />
        <div className="mt-1 flex items-start justify-between gap-2">
          {touched && missing ? (
            // 不加 role="alert"：同文案的 toast 已经在 live region 里播报过一次，
            // 这里再挂一个 alert 会让读屏把同一句念两遍。视觉红字 + aria-invalid +
            // aria-describedby 已经把「哪里错了」说清楚。
            <p id={errorId} className="text-xs text-[var(--destructive)]">
              请填写{spec.label}
            </p>
          ) : (
            <span />
          )}
          <span className="shrink-0 text-xs text-[#999999]">
            {remark.length}/{DOC_ACTION_REMARK_MAX}
          </span>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting} variant={spec.confirmVariant}>
          {submitting ? '处理中…' : spec.confirmText}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
