'use client'

import { useCallback, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardList, Plus } from 'lucide-react'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import InventoryLocationFilter from '@/components/inventory-location-filter'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { DocActionDialog, type DocActionSpec } from './doc-action-dialog'
import { InventoryDocCreateForm } from './inventory-doc-create-form'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import { PreserveListContextLink } from '@/components/return-context'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const GENERIC_DOC_TYPE_SET = new Set<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES)

/*
 * 从共享建单表单 re-export：单据中心与办理台共用同一份表单（#191），
 * 这两份口径跟着表单走。仍从本文件导出是为了不动既有测试的 import 路径 ——
 * 那批用例（与服务端 shouldCaptureSourceLot / genericDocEndpointSpec 的漂移守护）
 * 是这条链上最值钱的守护。
 */
export { SOURCE_LOT_DOC_TYPES, genericDocEndpointMode } from './inventory-doc-create-form'
export type { GenericDocEndpointMode } from './inventory-doc-create-form'

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

      {/*
        弹窗组件与办理台单据 Tab 共用（#192），动作集合由本页的 config 决定。
        **不要**把它套进权限条件里 —— 权限翻转时卸载正开着的弹窗会连输入一起丢，
        而 `pendingAction` 仍非空 → 点击闸把所有入口锁死（同 CreateDocDialog 上方的注释）。
      */}
      <DocActionDialog
        config={DOC_ACTION_CONFIG}
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
 *
 * 只绑 generic 三件套，是**本页专属**的配置：办理台的库存业务单（院退货 / 品项公司发货 /
 * 采购订单…）不在 INVENTORY_GENERIC_DOC_TYPES 里，走这三个 action 会被服务端的
 * `assertGenericDocTransition` 直接拒掉，那边自己配一份同形状的 config。
 */
const DOC_ACTION_CONFIG: Readonly<Record<DocActionKind, DocActionSpec>> = {
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
