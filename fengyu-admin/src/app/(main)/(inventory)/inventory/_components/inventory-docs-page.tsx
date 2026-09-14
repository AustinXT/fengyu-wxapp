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
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import { PreserveListContextLink } from '@/components/return-context'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const GENERIC_DOC_TYPE_SET = new Set<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES)

// 导出供测试锁定：它与 INVENTORY_GENERIC_DOC_TYPES 的交集就是「通用建单入口里需要选来源批次」
// 的全集，必须与服务端 engine.ts 的 shouldCaptureSourceLot 判定保持一致（见同目录测试的守护用例）。
export const SOURCE_LOT_DOC_TYPES = new Set<InventoryDocType>([
  '品项公司发货',
  '分院配货',
  '分院调货出库',
  '市场间调货出库',
  '员工购出库',
  '供应链员工购出库',
  '内部领用',
  '非凤御市场出库',
  '市场退货',
  '院退货',
  '院顾客产品出库',
  '市场产品报损',
  '院产品报损',
  '库存转换出库',
])

function formatDate(v: string | null | undefined) {
  return v ? v.slice(0, 10) : '—'
}

function num(v: string): number | null {
  if (!v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function defaultItem(): DraftItem {
  return {
    lotId: '',
    skuId: '',
    batchNo: '',
    expiryDate: '',
    isGift: false,
    quantity: '1',
    reason: '',
    remark: '',
  }
}

interface DraftItem {
  lotId: string
  skuId: string
  batchNo: string
  expiryDate: string
  isGift: boolean
  quantity: string
  reason: string
  remark: string
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
  // 两个弹窗**各记各的在途态**：共用一个布尔的话，先结束的那个会把另一个仍在途的锁提前解开。
  const [actionDialogBusy, setActionDialogBusy] = useState(false)
  const [createDialogBusy, setCreateDialogBusy] = useState(false)
  // 降级路径下还要防「两个弹窗同时开着」：任一弹窗开着时就锁住开另一个的入口
  const actionBusy = actionDialogBusy || createDialogBusy || pendingAction !== null || open

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
          {actionBusy ? (
            // 在途时不能让人点走：详情是个链接，光给里面的按钮加 disabled 拦不住导航，
            // 直接换成一个禁用按钮（降级到 .show() 时背景可点才会走到这里）
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
                disabled={actionBusy}
                onClick={() => setPendingAction({ kind: 'approve', docId: r.id })}
              >
                通过
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionBusy}
                onClick={() => setPendingAction({ kind: 'reject', docId: r.id })}
              >
                驳回
              </Button>
            </>
          )}
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canReceive && r.status === '待收货' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={actionBusy}
              onClick={() => setPendingAction({ kind: 'receive', docId: r.id })}
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
            // 降级到 .show() 时背景可点，别让「新建」弹窗叠在「处理中」的动作弹窗之上
            <Button disabled={actionBusy} onClick={() => setOpen(true)}>
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

      {canCreate && (
        <CreateDocDialog
          open={open}
          onOpenChange={setOpen}
          locations={locations}
          skuOptions={skuOptions}
          onSuccess={() => startTransition(() => router.refresh())}
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
const STALE_STATE_MESSAGE = '单据状态或权限已变化，已为你刷新列表'

/** 状态型错误：说明单据已被别人改过，弹窗留着也没用，直接关掉 + 刷新列表给出路。 */
const STALE_STATE_PREFIXES: readonly string[] = [
  'CONFLICT',
  'INVALID_STATE',
  'NOT_FOUND',
  // 权限被收回后，页面上按旧权限渲染的按钮还在，留着弹窗只会让人反复点必失败的按钮 ——
  // 与状态被改是同构的死胡同，刷新后按钮会随权限消失。
  'PERMISSION_DENIED',
]

function rawErrorSignal(err: unknown): string {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest
  return (typeof digest === 'string' && digest) || (err instanceof Error ? err.message : '') || ''
}

/**
 * 整串恰好就是一个错误前缀、没有任何可读文案 —— `PermissionError` 的
 * `digest = 'PERMISSION_DENIED'` 就是这形态。这种串不能交给 `actionErrorMessage`
 * 直出（它剥前缀的正则要求冒号，剥不掉就原样返回，用户看到一串英文）。
 */
function isBarePrefixError(err: unknown): boolean {
  return STALE_STATE_PREFIXES.includes(rawErrorSignal(err))
}

function isStaleStateError(err: unknown): boolean {
  const raw = rawErrorSignal(err)
  // 要同时认「带冒号的完整 message」与「裸前缀」：HOF 层的 requireAnyPermission 抛的是
  // `PermissionError`，它的 digest 是字段常量 `'PERMISSION_DENIED'`（无冒号无文案），
  // 而 rethrowWithDigest 见 digest 已存在就跳过、不会补写 —— 只认带冒号的话，
  // 「权限被收回」这条最直接的路径恰好判不出来。
  return STALE_STATE_PREFIXES.some((prefix) => raw === prefix || raw.startsWith(`${prefix}:`))
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
  // 第一道闸在父组件（在途时行操作按钮全 disabled，见 actionBusy），这里是第二道：
  // 万一将来有人拆了那道闸，至少锁的归属还是对的。
  const submitTokenRef = useRef(0)
  const [remark, setRemark] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 关闭时**不卸载**，走 open=false 让原生 dialog.close() 正常执行 —— 焦点才会还给
  // 触发它的那个按钮，也才不会踩「卸载期补 close()、排队的 close 事件在 StrictMode
  // 重挂监听后才到达」那个坑。代价是关闭后还要拿着上一次的配置渲染（隐藏态），
  // 故留一份快照。同文件的 CreateDocDialog 用的也是常驻挂载。
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
      toast.error(
        isBarePrefixError(err)
          ? STALE_STATE_MESSAGE
          : actionErrorMessage(err, config.errorFallback),
      )
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

function CreateDocDialog({
  open,
  onOpenChange,
  locations,
  skuOptions,
  onSuccess,
  onBusyChange,
  initialDocType,
  allowedDocTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: () => void
  /** 与 DocActionDialog 同样上报在途态，两个弹窗的闸门保持对称 */
  onBusyChange: (busy: boolean) => void
  initialDocType?: InventoryDocType
  allowedDocTypes?: readonly InventoryDocType[]
}) {
  const availableDocTypes = allowedDocTypes ?? INVENTORY_GENERIC_DOC_TYPES
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    onBusyChange(submitting)
  }, [submitting, onBusyChange])
  const [docType, setDocType] = useState<InventoryDocType>(
    initialDocType && availableDocTypes.includes(initialDocType) ? initialDocType : availableDocTypes[0],
  )
  const [sourceOrgNodeId, setSourceOrgNodeId] = useState('')
  const [targetOrgNodeId, setTargetOrgNodeId] = useState('')
  const [docDate, setDocDate] = useState(() => {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  })
  const [remark, setRemark] = useState('')
  const [items, setItems] = useState<DraftItem[]>([defaultItem()])
  const requiresSourceLot = SOURCE_LOT_DOC_TYPES.has(docType)
  /**
   * 批次取数的弹窗级缓存：按 (库位, SKU) 存**Promise**，既去重在途请求也复用已取结果。
   * 没有它的话，N 条明细选同一个 SKU 就发 N 次；更隐蔽的是明细行用 index 当 React key，
   * 删掉中间一行会让其后每一行的 (库位,SKU) 组合整体平移，触发一连串重复请求 ——
   * 而 Server Action 走的是全局 FIFO 队列，这些请求串行排队，下拉会一起变灰，
   * 观感和 #129 的卡死几乎一样。
   *
   * ⚠️ 用 ref 不用 state：它**绝不能进任何 useEffect 的依赖数组**（#129 的成因正是如此）。
   */
  const lotCacheRef = useRef<LotCache>(new Map())
  /**
   * 缓存代次。原生 <dialog> 关闭不卸载组件，`lotCacheRef` 与每行的 `loaded` 都会常驻 ——
   * 只 clear() 缓存是不够的：子组件的 `loaded.key` 没变，effect 根本不会重跑。
   * 把代次编进 key，重开弹窗时所有批次下拉就会重新取数，不会拿几分钟前的数量去建下一张单
   * （提交必被服务端 FOR UPDATE + 可用量校验拒掉）。
   *
   * 代次在**关闭时**推进，不是打开时：
   * - 打开时推进的话，open→true 的首帧 `loaded.key` 仍等于旧 cacheKey，会闪一下旧批次；
   * - 关闭时推进，重开的第一帧渲染期就判定为过期 → 直接进加载态。
   * 配合下面传给 DocLotSelect 的 `active={open}`（关闭态只 cleanup 不取数），
   * 保证「关着不发请求、一次重开只产生一个新代次」—— 否则提交成功后弹窗已关，
   * N 个不同 SKU 的明细行会各发一次无用请求，排在重开后的可见请求前面，
   * 把批次框重新拖成长时间 disabled（正是 #129 的观感）。
   */
  const [lotEpoch, setLotEpoch] = useState(0)

  useEffect(() => {
    if (open) return
    // 正确性由取数侧的 settled + epoch 判定负责（见 LotCache 注释）—— 在这里按
    // 「关闭当刻是否 settled」一刀切会漏掉「关闭后、重开前才返回」的那批：它们关闭当刻还在途、
    // 躲过清理，重开时又已完成，于是被当成新鲜结果复用。
    // 这里只做内存清扫：当刻已完成的条目下次取数必被代次淘汰，留着也只是占内存
    // （用户翻过很多 SKU 又一直不关页面时会累积）。在途的必须留着给下一代过继。
    for (const [key, entry] of lotCacheRef.current) {
      if (entry.settled) lotCacheRef.current.delete(key)
    }
    setLotEpoch((n) => n + 1)
    // 代次一换，已选的 lotId 可能指向下一代里已经不存在的批次：受控 select 会显示空白，
    // state 却还留着旧值，直接提交就只能靠服务端 lockLotById 兜底报错。换主体/换 SKU
    // 都清了 lotId，这条路径也要清。
    setItems((prev) => (prev.some((item) => item.lotId) ? prev.map((item) => ({ ...item, lotId: '' })) : prev))
  }, [open])
  const isDocTypeLocked = Boolean(initialDocType && availableDocTypes.includes(initialDocType))
  const sourceLocationId = locations.find((location) => location.orgNodeId === sourceOrgNodeId)?.locationId ?? ''

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      const payload: CreateInventoryDocInput = {
        docType,
        sourceOrgNodeId: sourceOrgNodeId || null,
        targetOrgNodeId: targetOrgNodeId || null,
        docDate,
        remark,
        items: items.map<InventoryDocItemInput>((item) => ({
          lotId: num(item.lotId),
          skuId: item.skuId || null,
          batchNo: item.batchNo || null,
          expiryDate: item.expiryDate || null,
          isGift: item.isGift,
          quantity: Number(item.quantity || 0),
          reason: item.reason || null,
          remark: item.remark || null,
        })),
      }
      await createInventoryCoreDoc(payload)
      // 不在这里手工失效缓存：onOpenChange(false) 会走上面那个「关闭即推进代次」的 effect，
      // 下次打开自然重新取数。在这里再推一次只会在弹窗已关的状态下白发一轮请求。
      onOpenChange(false)
      onSuccess()
    } catch (err) {
      toast.error(actionErrorMessage(err, '创建单据失败'))
    } finally {
      setSubmitting(false)
    }
  }

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
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-4 gap-3">
          <Select value={docType} disabled={isDocTypeLocked} onChange={(e) => setDocType(e.target.value as InventoryDocType)}>
            {availableDocTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </Select>
          <DatePicker value={docDate} onValueChange={setDocDate} aria-label="单据日期" />
          <Select
            value={sourceOrgNodeId}
            onChange={(e) => {
              setSourceOrgNodeId(e.target.value)
              setItems((prev) => prev.map((item) => ({ ...item, lotId: '' })))
            }}
          >
            <option value="">出库/发起主体</option>
            {locations.filter((location) => location.orgNodeId).map((location) => (
              <option key={location.orgNodeId!} value={location.orgNodeId!}>
                {location.locationType} · {location.name}
              </option>
            ))}
          </Select>
          <Select value={targetOrgNodeId} onChange={(e) => setTargetOrgNodeId(e.target.value)}>
            <option value="">入库/接收主体</option>
            {locations.filter((location) => location.orgNodeId).map((location) => (
              <option key={location.orgNodeId!} value={location.orgNodeId!}>
                {location.locationType} · {location.name}
              </option>
            ))}
          </Select>
        </div>
        <Textarea placeholder="备注" value={remark} onChange={(e) => setRemark(e.target.value)} />

        <div className="space-y-2">
          {items.map((item, index) => (
            <div
              key={index}
              className={`${requiresSourceLot ? 'grid-cols-7' : 'grid-cols-6'} grid gap-2 rounded-md border border-[var(--border)] p-2`}
            >
              {requiresSourceLot && (
                <DocLotSelect
                  locationId={sourceLocationId}
                  skuId={item.skuId}
                  value={item.lotId}
                  onChange={(lotId) => updateItem(index, { lotId })}
                  cache={lotCacheRef.current}
                  epoch={lotEpoch}
                  active={open}
                  label={`明细 ${index + 1} 来源批次`}
                />
              )}
              <Select
                value={item.skuId}
                onChange={(e) => updateItem(index, { skuId: e.target.value, lotId: '' })}
              >
                <option value="">库存 SKU</option>
                {skuOptions.map((sku) => (
                  <option key={sku.skuId} value={sku.skuId}>
                    {sku.productCode} · {sku.productName}
                  </option>
                ))}
              </Select>
              <Input placeholder="批号" value={item.batchNo} onChange={(e) => updateItem(index, { batchNo: e.target.value })} />
              <DatePicker value={item.expiryDate} onValueChange={(value) => updateItem(index, { expiryDate: value })} aria-label={`明细 ${index + 1} 效期`} />
              <Input placeholder="数量" value={item.quantity} onChange={(e) => updateItem(index, { quantity: e.target.value })} />
              <Input placeholder="原因" value={item.reason} onChange={(e) => updateItem(index, { reason: e.target.value })} />
              <Button
                variant="outline"
                onClick={() => setItems((prev) => prev.length === 1 ? prev : prev.filter((_, i) => i !== index))}
              >
                删除
              </Button>
            </div>
          ))}
          <Button variant="outline" onClick={() => setItems((prev) => [...prev, defaultItem()])}>
            添加明细
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
        <Button onClick={submit} disabled={submitting}>提交</Button>
      </DialogFooter>
    </Dialog>
  )
}

/**
 * 来源批次下拉：每行一个实例、自带 state，按 (locationId, skuId) 拉取，取数走弹窗级 Promise 缓存。
 *
 * ⚠️ 依赖数组只能放**真实输入**（locationId / skuId / 显式的重试计数），
 * 绝不能放这个 effect 自己 set 的 state。曾经的写法是父层共享 `lotOptionsByKey` /
 * `loadingLotKeys` 两个 Record 再把它们塞进依赖数组：setState → re-render → 依赖变 →
 * effect 重跑 → cleanup 把上一轮 `cancelled` 置 true → 首次请求的 then/catch/finally
 * 全被跳过 → loading 永远停在 true → 下拉永久 disabled，6 种需选来源批次的单据
 * 全部建不出来（#129）。
 * （`retryToken` 虽然也是本组件的 state，但它只在 onFocus 里 set、不在 effect 体内 set，
 *   不构成自触发环 —— 区别就在这里。）
 *
 * 办理台 `inventory-operations-page.tsx` 的 `LotPicker` **不存在**这个 bug（它的依赖数组
 * 干净地只有 `[locationId, skuId]`），可作正例参照；但它在加载期间不清旧数据，
 * 本组件用 `loaded.key === cacheKey` 顺带解决了 —— 入参一变，渲染期立刻判定为加载中，
 * 不会闪出上一对入参的批次（删除明细行时尤其重要：明细用 index 当 React key，
 * 删行会让实例拿到下一行的 props）。
 */
type LotLoadState = { key: string; lots: InventoryLotRow[]; failed?: boolean }

/**
 * 弹窗级批次取数缓存：(库位, SKU) → 在途/已完成的 Promise。
 *
 * key **不含代次** —— 代次只管「结果算不算新鲜」（编在 DocLotSelect 的 cacheKey 里），
 * 在途去重是另一回事。
 *
 * 取数时按 `settled` + `epoch` 决定复用还是重取：
 * - 还在途（`settled === false`）→ 无条件复用，并把它「过继」给当前代次
 *   （Server Action 不可 abort，作废等于白等一轮）
 * - 已完成且属于**旧代次** → 淘汰重取（可用量可能已经过期）
 * - 已完成且属于当前代次 → 复用（同一弹窗内多行去重）
 */
type LotCache = Map<string, { promise: Promise<InventoryLotRow[]>; settled: boolean; epoch: number }>

function DocLotSelect({
  locationId,
  skuId,
  value,
  onChange,
  cache,
  epoch,
  active,
  label,
}: {
  locationId: string
  skuId: string
  value: string
  onChange: (lotId: string) => void
  /** 弹窗级 (库位,SKU) → Promise 缓存，见 CreateDocDialog 的 lotCacheRef */
  cache: LotCache
  /** 缓存代次，弹窗关闭时递增，用来强制下次打开重新取数 */
  epoch: number
  /** 弹窗是否打开。原生 <dialog> 关闭不卸载 children，关着时绝不能取数 */
  active: boolean
  label: string
}) {
  // 用 JSON 数组当 key，避免 ('a:b','c') 与 ('a','b:c') 这类分隔符歧义撞进同一个缓存槽。
  // 组件自己的新鲜度 key 含代次（换代即判定过期）；查缓存用的 key 不含代次（在途请求跨代可复用）。
  const cacheKey = locationId && skuId ? JSON.stringify([epoch, locationId, skuId]) : ''
  const requestKey = locationId && skuId ? JSON.stringify([locationId, skuId]) : ''
  const [retryToken, setRetryToken] = useState(0)
  const [loaded, setLoaded] = useState<LotLoadState | null>(null)

  useEffect(() => {
    if (!active || !cacheKey) return
    let cancelled = false
    let entry = cache.get(requestKey)
    // 已完成且属于旧代次 → 结果可能过期，淘汰重取（在途的不动，见 LotCache 注释）
    if (entry && entry.settled && entry.epoch !== epoch) {
      cache.delete(requestKey)
      entry = undefined
    }
    if (!entry) {
      const promise = listInventoryLotOptions(locationId, skuId).then((lots) => {
        // 契约异常（灰度不一致 / action 回归返回了非数组）必须走失败路径，
        // 不能吞成「正常的空列表」—— 那会和 #129 一样让用户误判为「没货」
        if (!Array.isArray(lots)) throw new Error('批次接口返回格式异常')
        return lots
      })
      entry = { promise, settled: false, epoch }
      cache.set(requestKey, entry)
      const created = entry
      void promise.then(
        () => { created.settled = true },
        () => { created.settled = true },
      )
    } else {
      // 在途条目被新代次接手：它落地后，同代次的其它明细行直接复用，不再多发一次
      entry.epoch = epoch
    }
    entry.promise
      .then((lots) => {
        if (!cancelled) setLoaded({ key: cacheKey, lots })
      })
      .catch((error) => {
        // 失败的 Promise 不能留在缓存里，否则重试会拿到同一个已 reject 的 Promise
        cache.delete(requestKey)
        // 失败必须让用户看见：静默吞掉会和「该批次真的没货」长得一模一样。
        // 多行共用同一个 key 时会各自 catch，用 cacheKey 当 toast id 去重，避免弹 N 条一样的。
        if (!cancelled) {
          setLoaded({ key: cacheKey, lots: [], failed: true })
          toast.error(actionErrorMessage(error, '加载可用批次失败'), { id: cacheKey })
        }
      })
    return () => {
      cancelled = true
    }
  }, [active, cacheKey, requestKey, epoch, locationId, skuId, cache, retryToken])

  const isCurrent = loaded?.key === cacheKey
  const lots = isCurrent ? loaded.lots : []
  const failed = isCurrent && loaded.failed === true
  const isLoadingLots = Boolean(cacheKey) && !isCurrent

  return (
    <Select
      aria-label={label}
      value={value}
      disabled={!locationId || !skuId || isLoadingLots}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => {
        // 失败态是唯一的重试入口：关掉弹窗再打开不会重挂载（原生 <dialog>），
        // 不给入口的话用户只能靠「切到别的 SKU 再切回来」猜出来。
        if (failed) {
          setLoaded(null)
          setRetryToken((n) => n + 1)
        }
      }}
    >
      <option value="">
        {!locationId
          ? '先选择出库主体'
          : !skuId
            ? '先选择库存 SKU'
            : isLoadingLots
              ? '加载库存批次...'
              : failed
                ? '批次加载失败，点此重试'
                : '选择库存批次'}
      </option>
      {lots.map((lot) => (
        <option key={lot.id} value={String(lot.id)}>
          {/*
            用 availableQuantity（在手 − 未完成预留）而不是 quantityOnHand：
            服务端扣减时校验的就是可用量，显示在手量会出现「界面写着可用 30、提交却报库存不足」
            的自相矛盾。接口本来就把这个字段算好返回了，之前只是没用上。
          */}
          {`${lot.batchNo || '无批号'} · 可用 ${lot.availableQuantity}${lot.expiryDate ? ` · ${formatDate(lot.expiryDate)}` : ''}`}
        </option>
      ))}
    </Select>
  )
}
