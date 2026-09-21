'use client'

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardList, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  approveInventoryCoreDoc,
  confirmInventoryCoreReceive,
  createInventoryCoreDoc,
  rejectInventoryCoreDoc,
} from '@/actions/inventory/docs'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import {
  INVENTORY_DOC_STATUSES,
  INVENTORY_DOC_TYPES,
  INVENTORY_GENERIC_DOC_TYPES,
  type CreateInventoryDocInput,
  type InventoryDocItemInput,
  type InventoryDocRow,
  type InventoryLotRow,
  type InventoryLocationFilterOptions,
  type InventoryLocationRow,
  type InventorySkuRow,
  type InventoryDocType,
} from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import InventoryLocationFilter from '@/components/inventory-location-filter'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { docActionErrorMessage, isStaleStateError } from '@/lib/inventory/doc-action-error'
import { InventoryDocCreateForm } from './inventory-doc-create-form'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import { PreserveListContextLink } from '@/components/return-context'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const GENERIC_DOC_TYPE_SET = new Set<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES)

/*
 * 从共享建单表单 re-export：单据中心与办理台共用同一份表单（#191），
 * 这份清单跟着表单走。仍从本文件导出是为了不动既有测试的 import 路径 ——
 * 那批用例（与服务端 shouldCaptureSourceLot 的漂移守护）是这条链上最值钱的守护。
 */
export { SOURCE_LOT_DOC_TYPES } from './inventory-doc-create-form'

function formatDate(v: string | null | undefined) {
  return v ? v.slice(0, 10) : '—'
}


export default function InventoryDocsPage({
  rows,
  total,
  locations,
  skuOptions,
  canCreate,
  canApprove,
  canReceive,
  canViewPrice,
  initialDocType,
  allowedCreateDocTypes,
  locationFilterOptions,
  selectedOrgNodeId,
}: {
  rows: InventoryDocRow[]
  total: number
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  canCreate: boolean
  canApprove: boolean
  canReceive: boolean
  canViewPrice: boolean
  initialDocType?: InventoryDocType
  allowedCreateDocTypes?: readonly InventoryDocType[]
  locationFilterOptions?: InventoryLocationFilterOptions
  selectedOrgNodeId?: string | null
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()
  const [searchInput, setSearchInput] = useState(get('q'))
  const [open, setOpen] = useState(Boolean(initialDocType && GENERIC_DOC_TYPE_SET.has(initialDocType)))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const page = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size'))) ? Number(get('size')) : 20

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [debounceRef, setMany])

  // 审批 / 驳回 / 收货共用同一个备注弹窗，只有当前挂着的这一项决定标题、校验与调用哪个 action
  const [pendingAction, setPendingAction] = useState<{ kind: DocActionKind; docId: string } | null>(
    null,
  )
  // 提交在途时不接受任何行操作。真机上模态背景本就 inert 点不到，但 dialog.tsx 有降级到
  // .show() 的退路 —— 那条路下背景可点，A 的「处理中」界面会被 B 顶掉，用户以为 A 取消了。
  //
  // 真正兜住的是后两项（任一弹窗开着就锁住开另一个的入口）—— 从状态上禁止两个弹窗并存，
  // 提交在途自然也被包含在「弹窗开着」里。前两项是**第二道冗余闸**：两个弹窗各记各的
  // 在途态，免得将来有人拆掉「不许并存」这条约束时，退回到「共用一个布尔、先结束的那个
  // 把另一个仍在途的锁提前解开」。它们当前被后两项覆盖，删掉测试不会红 —— 这是有意保留。
  const [actionDialogBusy, setActionDialogBusy] = useState(false)
  const [createDialogBusy, setCreateDialogBusy] = useState(false)
  const actionBusy = actionDialogBusy || createDialogBusy
  /**
   * 「已经有弹窗开着」不能用 `disabled` 来拦 —— 点「驳回」的那一刻按钮就会变 disabled，
   * 而 `showModal()` 在随后的 layout effect 里才记录「打开前的焦点」，记到的已经不是一个
   * 可聚焦元素了，关闭后焦点就回不到触发按钮上（键盘/读屏用户直接丢上下文）。
   * 所以**开窗入口**（通过 / 驳回 / 收货 / 新建）一律走点击闸：按钮保持可聚焦、点了不响应。
   * 用 `disabled` 的只有两类：不开窗的「详情」（它是链接，必须整个换成禁用按钮才拦得住导航）、
   * 以及弹窗内部的按钮（那时 showModal 早已记录完焦点，且需要视觉反馈）。
   */
  const anyDialogOpen = pendingAction !== null || open
  const openAction = (next: { kind: DocActionKind; docId: string }) => {
    if (anyDialogOpen || actionBusy) return
    setPendingAction(next)
  }

  const columns: Column<InventoryDocRow>[] = [
    {
      key: 'id',
      header: '单据号',
      cell: (r) => <span className="font-mono text-xs">{r.id}</span>,
    },
    {
      key: 'docType',
      header: '类型',
      cell: (r) => (
        <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-xs text-[var(--primary)]">
          {r.docType}
        </span>
      ),
    },
    {
      key: 'sourceOrgNodeName',
      header: '出库/发起',
      cell: (r) => r.sourceOrgNodeName ?? '—',
    },
    {
      key: 'targetOrgNodeName',
      header: '入库/接收',
      cell: (r) => r.targetOrgNodeName ?? '—',
    },
    { key: 'docDate', header: '日期', cell: (r) => formatDate(r.docDate) },
    {
      key: 'totalQuantity',
      header: '数量',
      cell: (r) => <span className="font-medium">{r.totalQuantity}</span>,
    },
    ...(canViewPrice
      ? [{ key: 'totalAmount', header: '金额', cell: (r: InventoryDocRow) => r.totalAmount ?? '—' } as Column<InventoryDocRow>]
      : []),
    {
      key: 'status',
      header: '状态',
      cell: (r) => (
        <span className={r.status === '已完成' ? 'text-[#3D8A5A]' : r.status === '已驳回' ? 'text-[#888888]' : 'text-[#D4820A]'}>
          {r.status}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (r) => (
        <div className="flex gap-2">
          {anyDialogOpen || actionBusy ? (
            // 弹窗开着/在途时不能让人点走：详情是个链接，光给里面的按钮加 disabled 拦不住导航，
            // 直接换成一个禁用按钮（降级到 .show() 时背景可点才会走到这里）。
            // 这个按钮不是「打开弹窗」的入口，disable 它不影响焦点归还。
            <Button variant="ghost" size="sm" disabled>
              详情
            </Button>
          ) : (
            <PreserveListContextLink href={`/inventory/docs/${r.id}`}>
              <Button variant="ghost" size="sm">详情</Button>
            </PreserveListContextLink>
          )}
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canApprove && r.status === '待审批' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openAction({ kind: 'approve', docId: r.id })}
              >
                通过
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openAction({ kind: 'reject', docId: r.id })}
              >
                驳回
              </Button>
            </>
          )}
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canReceive && r.status === '待收货' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openAction({ kind: 'receive', docId: r.id })}
            >
              收货
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {locationFilterOptions && (
            <InventoryLocationFilter
              options={locationFilterOptions}
              value={selectedOrgNodeId ?? null}
              onChange={(orgNodeId) => setMany({ orgNodeId, page: '' })}
            />
          )}
          <Select
            value={get('docType')}
            onChange={(e) => setMany({ docType: e.target.value, page: '' })}
            className="w-40"
          >
            <option value="">全部单据</option>
            {INVENTORY_DOC_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </Select>
          <Select
            value={get('status')}
            onChange={(e) => setMany({ status: e.target.value, page: '' })}
            className="w-32"
          >
            <option value="">全部状态</option>
            {INVENTORY_DOC_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </Select>
          <Input
            className="w-64"
            placeholder="搜索单据 / 顾客 / 员工 / 备注"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={() => setMany({
              q: '',
              orgNodeId: locationFilterOptions?.defaultLocationId ?? '',
              docType: '',
              status: '',
              create: '',
              page: '',
            })}
          >
            重置
          </Button>
          {canCreate && (
            // 降级到 .show() 时背景可点，别让「新建」弹窗叠在另一个弹窗之上。
            // 同样走点击闸而不是 disabled，理由见 anyDialogOpen 的注释。
            <Button
              onClick={() => {
                if (anyDialogOpen || actionBusy) return
                setOpen(true)
              }}
            >
              <Plus className="mr-1 size-4" /> 新建
            </Button>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无库存单据" />
      <Pagination
        total={total}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setMany({ page: String(next) })}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      {/*
        条件里要带上 `open`：权限被收回时 `canCreate` 会翻 false，若此时弹窗正开着，
        组件直接卸载 → 用户填的表单没了，而父组件的 `open` 仍是 true →
        `anyDialogOpen` 永远为真 → 所有入口被点击闸锁死，只能整页重载。
        挂着它，用户还能正常关掉弹窗、页面自行解锁。
      */}
      {(canCreate || open) && (
        <CreateDocDialog
          open={open}
          onOpenChange={setOpen}
          locations={locations}
          skuOptions={skuOptions}
          onSuccess={() => startTransition(() => router.refresh())}
          onStale={() => startTransition(() => router.refresh())}
          onBusyChange={setCreateDialogBusy}
          initialDocType={initialDocType}
          allowedDocTypes={allowedCreateDocTypes}
        />
      )}

      <DocActionDialog
        pending={pendingAction}
        onBusyChange={setActionDialogBusy}
        onOpenChange={(next) => {
          if (!next) setPendingAction(null)
        }}
        onDone={(finished) => {
          // 只关「当初发起的那一张」。若期间已经切到别的单据，别把人家开着的弹窗和
          // 刚敲进去的备注一起抹掉（列表刷新则无条件做）。
          // 注：`actionBusy` 已经从状态上禁止「在途时切走」，这条身份校验是第二道防线，
          // 因此没有专门的用例覆盖 —— 拆掉那道闸门时记得把它一起想清楚。
          setPendingAction((current) =>
            current && current.docId === finished.docId && current.kind === finished.kind
              ? null
              : current,
          )
          startTransition(() => router.refresh())
        }}
      />
    </div>
  )
}

type DocActionKind = 'approve' | 'reject' | 'receive'

/**
 * 审批 / 驳回 / 收货的备注弹窗配置。
 *
 * `remarkRequired` 目前只有驳回为 true —— 驳回原因是制单人唯一能看到的解释，
 * 空着等于让人猜。服务端 `rejectInventoryCoreDoc` 暂未强制非空（改它是接口契约变更，
 * 见 PR 说明），故这里是**前端闸门**：拦住手滑，而不是拦住恶意调用。
 */
const DOC_ACTION_CONFIG: Readonly<
  Record<
    DocActionKind,
    {
      title: string
      label: string
      placeholder: string
      remarkRequired: boolean
      /** 提交后不可撤销的后果，渲染在标题下方。没有后果的动作留空。 */
      consequence?: string
      confirmText: string
      confirmVariant?: 'destructive'
      successMessage: (result: unknown) => string
      errorFallback: string
      run: (docId: string, remark: string) => Promise<unknown>
    }
  >
> = {
  approve: {
    title: '确认审批通过？',
    label: '审批备注',
    placeholder: '选填，将记录在单据的审批信息中',
    remarkRequired: false,
    // 三个动作里只有它真的动库存：逐条锁批次 + 出库流水，状态直接推到「已完成」
    consequence: '通过后将按明细批次实扣库存，单据状态变为「已完成」，不可撤销。',
    confirmText: '确认通过',
    successMessage: () => '单据已通过，库存已扣减',
    errorFallback: '审批失败',
    run: (docId, remark) => approveInventoryCoreDoc(docId, remark),
  },
  reject: {
    title: '驳回单据',
    label: '驳回原因',
    placeholder: '请说明驳回原因，制单人可查看此说明',
    remarkRequired: true,
    confirmText: '确认驳回',
    confirmVariant: 'destructive',
    successMessage: () => '单据已驳回',
    errorFallback: '驳回失败',
    run: (docId, remark) => rejectInventoryCoreDoc(docId, remark),
  },
  receive: {
    title: '确认收货',
    label: '收货备注',
    placeholder: '选填，如实收与单据有差异请在此说明',
    remarkRequired: false,
    consequence: '确认后将生成对应的入库单并增加在手库存。',
    confirmText: '确认收货',
    // 收货会生成入库单，单号是用户下一步要找的东西，别丢
    successMessage: (result) => {
      const inboundDocId = (result as { inboundDocId?: unknown } | null)?.inboundDocId
      return typeof inboundDocId === 'string' && inboundDocId
        ? `收货已确认，已生成入库单 ${inboundDocId}`
        : '收货已确认'
    },
    errorFallback: '收货确认失败',
    run: (docId, remark) => confirmInventoryCoreReceive(docId, remark),
  },
}

const DOC_ACTION_REMARK_MAX = 300

/**
 * Unicode 格式字符（`Cf` 类）：零宽空格、LRM/RLM 方向标记、方向隔离符等。
 * 肉眼看不见，`trim()` 也吃不掉。从聊天软件/表格/富文本复制过来的文本常带，
 * 不清掉就能拿「看起来是空的」的输入绕过必填。
 */
const INVISIBLE_FORMAT_RE = /\p{Cf}/gu

/** 裸前缀错误的统一说法：它本来就没带可读文案，直接说清「发生了什么 + 已经替你做了什么」。 */

/**
 * 单据中心的建单入口：只负责弹窗外壳，表单本体与提交逻辑走共享组件
 * `InventoryDocCreateForm`（#191 起与办理台共用同一份）。
 */
function CreateDocDialog({
  open,
  onOpenChange,
  locations,
  skuOptions,
  onSuccess,
  onStale,
  onBusyChange,
  initialDocType,
  allowedDocTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: () => void
  /** 状态/权限已变化时刷新列表（不关弹窗） */
  onStale: () => void
  /** 与 DocActionDialog 同样上报在途态，两个弹窗的闸门保持对称 */
  onBusyChange: (busy: boolean) => void
  initialDocType?: InventoryDocType
  allowedDocTypes?: readonly InventoryDocType[]
}) {
  const [submitting, setSubmitting] = useState(false)
  // useCallback：内联箭头每次重渲都换 identity，会让共享表单里两个 `[onBusyChange]`
  // 的 effect 反复 cleanup+setup，等价于「每次重渲闪断一次 busy」。
  // 当前两个调用方都只是 setState，批处理后净效果为零，但契约上不该这么写。
  const handleBusyChange = useCallback((busy: boolean) => {
    setSubmitting(busy)
    onBusyChange(busy)
  }, [onBusyChange])

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-5xl"
      dismissible={!submitting}
      ariaLabel="新建库存单据"
    >
      {!submitting && <DialogClose onOpenChange={onOpenChange} />}
      <DialogHeader>
        <DialogTitle>新建库存单据</DialogTitle>
      </DialogHeader>
      <div className="mt-4">
        <InventoryDocCreateForm
          // 原生 <dialog> 关闭不卸载 children：关着时绝不能取批次数（见共享组件的 visible 注释）
          visible={open}
          locations={locations}
          skuOptions={skuOptions}
          initialDocType={initialDocType}
          allowedDocTypes={allowedDocTypes}
          onSuccess={() => {
            // 不在这里手工失效批次缓存：关闭会让共享组件推进代次，下次打开自然重新取数。
            onOpenChange(false)
            onSuccess()
          }}
          onStale={onStale}
          onBusyChange={handleBusyChange}
          renderActions={({ submit, submitting: busy }) => (
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
              <Button onClick={submit} disabled={busy}>提交</Button>
            </DialogFooter>
          )}
        />
      </div>
    </Dialog>
  )
}

function DocActionDialog({
  pending,
  onOpenChange,
  onDone,
  onBusyChange,
}: {
  pending: { kind: DocActionKind; docId: string } | null
  onOpenChange: (open: boolean) => void
  onDone: (finished: { kind: DocActionKind; docId: string }) => void
  /** 把「有动作在途」上报给父组件，用来把行操作按钮一起锁住 */
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
  // 渲染（隐藏态），故留一份快照。同文件的 CreateDocDialog 用的也是常驻挂载。
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
  // 卸载时把在途态归还给父组件。DocActionDialog 在父组件里是无条件渲染的，这条只在整页
  // 卸载时触发，属纯防御；真正会被条件渲染摘掉的是下面的 CreateDocDialog。
  useEffect(() => () => onBusyChange(false), [onBusyChange])

  const active = pending ?? snapshot
  if (!active) return null
  const config = DOC_ACTION_CONFIG[active.kind]
  // 提交的是用户原样输入（只 trim 首尾空白）；清 Cf 字符只用来判「看起来是不是空的」——
  // 否则 ZWJ 组合 emoji、阿拉伯语方向控制符会在落库时被悄悄改写。
  const submittedRemark = remark.trim()
  const missing = config.remarkRequired && !remark.replace(INVISIBLE_FORMAT_RE, '').trim()

  async function submit() {
    if (!pending || submitting) return
    setTouched(true)
    if (missing) {
      toast.error(`请填写${config.label}`)
      return
    }
    setSubmitting(true)
    const token = ++submitTokenRef.current
    try {
      const result = await config.run(pending.docId, submittedRemark)
      toast.success(config.successMessage(result))
      onDone(pending)
    } catch (err) {
      toast.error(docActionErrorMessage(err, config.errorFallback))
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
      ariaLabel={config.title}
      ariaDescribedBy={descriptionId}
    >
      {!submitting && <DialogClose onOpenChange={onOpenChange} />}
      <DialogHeader>
        <DialogTitle>{config.title}</DialogTitle>
        <DialogDescription id={descriptionId}>
          单据号 {active.docId}
          {config.consequence && (
            <>
              <br />
              {config.consequence}
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium" htmlFor={remarkId}>
          {config.label}
          {config.remarkRequired && <span className="text-[var(--primary)]"> *</span>}
        </label>
        <Textarea
          // key 用 resetKey：换单据时把 textarea 整个重挂，丢掉滚动位置、选区这些 DOM 内部状态
          // （value 本身是受控的，靠 state 复位，不靠 key）
          key={resetKey}
          id={remarkId}
          ref={remarkRef}
          aria-required={config.remarkRequired}
          aria-invalid={touched && missing}
          aria-describedby={touched && missing ? errorId : undefined}
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          rows={4}
          maxLength={DOC_ACTION_REMARK_MAX}
          placeholder={config.placeholder}
        />
        <div className="mt-1 flex items-start justify-between gap-2">
          {touched && missing ? (
            // 不加 role="alert"：同文案的 toast 已经在 live region 里播报过一次，
            // 这里再挂一个 alert 会让读屏把同一句念两遍。视觉红字 + aria-invalid +
            // aria-describedby 已经把「哪里错了」说清楚。
            <p id={errorId} className="text-xs text-[var(--destructive)]">
              请填写{config.label}
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
        <Button onClick={submit} disabled={submitting} variant={config.confirmVariant}>
          {submitting ? '处理中…' : config.confirmText}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
