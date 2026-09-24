'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeftRight,
  Boxes,
  ClipboardCheck,
  PackageCheck,
  PackagePlus,
  PackageSearch,
  PackageX,
  RefreshCcw,
  RotateCcw,
  Send,
  ShoppingCart,
  Truck,
  Undo2,
  UserRoundCheck,
  Warehouse,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  approveItemCompanyShipmentCancellation,
  approveReturnForRestock,
  cancelSupplyChainPurchaseOrder,
  createExternalMarketOutbound,
  createInventoryConversion,
  createItemCompanyReplenishment,
  createItemCompanyShipment,
  createMarketReplenishment,
  createMarketStaffPurchase,
  createSupplyChainStaffPurchase,
  createPurchaseOrder,
  createMarketReportSummary,
  resolveInventorySkuSupplierStatus,
  summarizeMarketReplenishmentRequests,
  createReturnForRestock,
  createSelfPurchasedReceipt,
  createStoreAllocation,
  createStoreReplenishmentRequest,
  getShipmentReceiptProgress,
  listMarketEmployeeOptions,
  listSupplyChainEmployeeOptions,
  quoteMarketReplenishmentPrices,
  receiveItemCompanyShipment,
  receiveItemCompanyShipmentInFull,
  receiveSupplyChainPurchaseOrder,
  receiveStoreAllocation,
  receiveStoreAllocationInFull,
  rejectItemCompanyShipmentCancellation,
  rejectReturnForRestock,
  requestItemCompanyShipmentCancellation,
  summarizeStoreReplenishmentRequests,
} from '@/actions/inventory/business'
import type { MarketPromotionQuoteResult, ReceiveShipmentInFullInput } from '@/lib/inventory/business'
import {
  confirmInventoryCoreReceive,
  getInventoryCoreDocById,
  listInventoryOperationDocs,
} from '@/actions/inventory/docs'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import { actionErrorMessage } from '@/lib/action-error'
import type {
  InventoryDocDetail,
  InventoryDocRow,
  InventoryDocType,
  InventoryLocationRow,
  InventoryMarketTransferTarget,
  InventoryLotRow,
  InventorySkuOptionFilters,
  InventorySkuRow,
  InventorySupplierRow,
} from '@/lib/inventory/types'
import type { InventoryBusinessLevel } from '@/lib/inventory/business-level'
import { inventoryDocStatusLabel } from '@/lib/inventory/doc-status-label'
import {
  INVENTORY_INBOX_ACTION_STATUS,
  genericOperationId,
  resolveOperationDocQuery,
  resolveOperationInboxActions,
  type InventoryAnyOperationId,
  type InventoryGenericDocType,
  type InventoryGenericOperationId,
  type InventoryInboxActionKind,
  type InventoryOperationId,
} from '@/lib/inventory/operation-doc-types'
/*
 * 值导入。`operation-return` 运行时是纯的（对 business-level 只 `import type`），
 * 否则会把 @/lib/permissions → @/db 拖进客户端 bundle，见该文件头部注释。
 */
import {
  inventoryOperationDocHref,
  parseInventoryOperationId,
  parseInventoryOperationsTab,
} from '@/lib/inventory/operation-return'
import { DocActionDialog, type DocActionPending, type DocActionSpec } from './doc-action-dialog'
import { InventoryDocCreateForm } from './inventory-doc-create-form'
import { InventorySkuSearchSelect } from './inventory-sku-search-select'
import InventorySubjectSelect from '@/components/inventory-subject-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'

/**
 * 业务卡片 id 的单源在 `@/lib/inventory/operation-doc-types`：那里的
 * `Record<InventoryOperationId, …>` 映射表要求每个业务都登记自己的产出单据类型（#190），
 * 新增卡片时漏登记会直接编译失败。
 */
type OperationId = InventoryOperationId

interface OperationCardBase {
  title: string
  group: '需求与采购' | '发货、收货与退货' | '市场特殊业务'
  icon: typeof Boxes
  tone: string
  approvalOnly?: boolean
  shipmentCancellationAccess?: '申请' | '审批'
  selfPurchaseOnly?: boolean
  level: InventoryBusinessLevel
}

/** 内置表单业务：有专属业务函数与专属表单组件。 */
interface OperationDefinition extends OperationCardBase {
  id: OperationId
}

/**
 * 通用建单业务：没有专属函数，直接建一张该类型的单，用共享建单表单。
 *
 * `docType` 收窄到 `InventoryGenericDocType`（而不是宽泛的 `InventoryDocType`）——
 * 写一个业务单类型（如「品项公司发货」）进来会**编译失败**，而不是等运行时被
 * 白名单拒掉、或更糟：在某个没走白名单的路径上溜进去。
 */
interface GenericOperationDefinition extends OperationCardBase {
  docType: InventoryGenericDocType
}

/**
 * 工作区打开的业务，两类合一。`kind` 决定「填报表单」Tab 里渲染哪种表单，
 * 而单据 Tab 两类走同一个 action（服务端按 id 解析查询条件）。
 */
type ResolvedOperation =
  | (OperationDefinition & { kind: 'builtin' })
  | (GenericOperationDefinition & { id: InventoryGenericOperationId; kind: 'generic' })

const OPERATIONS: OperationDefinition[] = [
  { id: 'item-company-request', level: 'supply-chain', title: '品项公司报货需求', group: '需求与采购', icon: PackagePlus, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  { id: 'market-report-summary', level: 'supply-chain', title: '市场报货汇总', group: '需求与采购', icon: PackageSearch, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'company-shipment', level: 'supply-chain', title: '品项公司发货', group: '发货、收货与退货', icon: Truck, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'supply-chain-receipt', level: 'supply-chain', title: '供应链采购入库', group: '发货、收货与退货', icon: PackageCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'supply-chain-purchase-cancel', level: 'supply-chain', title: '关闭供应链采购', group: '发货、收货与退货', icon: RefreshCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', approvalOnly: true },
  { id: 'market-return-approval', level: 'supply-chain', title: '审批市场退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D4820A] bg-[#FFF8E6]', approvalOnly: true },
  { id: 'shipment-cancel-approval', level: 'supply-chain', title: '审批品项发货撤回', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', approvalOnly: true, shipmentCancellationAccess: '审批' },
  { id: 'supply-chain-conversion', level: 'supply-chain', title: '供应链库存转换', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'external-outbound', level: 'supply-chain', title: '非凤御市场出库', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
  { id: 'supply-chain-staff-purchase', level: 'supply-chain', title: '供应链员工购', group: '市场特殊业务', icon: UserRoundCheck, tone: 'text-[#8A4B7A] bg-[#FCF1F9]' },
  { id: 'market-report', level: 'market', title: '市场汇总报货', group: '需求与采购', icon: PackageSearch, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  // 采购订单位于流程图供应链泳道（报货单汇总 → 采购订单），归供应链办理台；
  // action 权限 inventory:supply_chain_operate 与 business.ts 的总部 scope 校验同源。
  // #194 起「供应链采购订单」已并入这一张卡片，来源在表单内多选。
  { id: 'purchase-order', level: 'supply-chain', title: '采购订单', group: '需求与采购', icon: ShoppingCart, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  { id: 'market-receipt', level: 'market', title: '市场采购入库', group: '发货、收货与退货', icon: PackageCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'store-allocation', level: 'market', title: '分院配货', group: '发货、收货与退货', icon: Send, tone: 'text-[#8B5A2B] bg-[#FFF5E8]' },
  { id: 'store-return-approval', level: 'market', title: '审批门店退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D4820A] bg-[#FFF8E6]', approvalOnly: true },
  { id: 'market-return', level: 'market', title: '市场退货申请', group: '发货、收货与退货', icon: Undo2, tone: 'text-[#D4820A] bg-[#FFF8E6]' },
  { id: 'shipment-cancel', level: 'market', title: '申请撤回品项发货', group: '发货、收货与退货', icon: RefreshCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', shipmentCancellationAccess: '申请' },
  { id: 'staff-purchase', level: 'market', title: '市场员工购', group: '市场特殊业务', icon: UserRoundCheck, tone: 'text-[#8A4B7A] bg-[#FCF1F9]' },
  { id: 'self-purchase', level: 'market', title: '自采产品入库', group: '市场特殊业务', icon: Warehouse, tone: 'text-[#3D8A5A] bg-[#F0F9F2]', selfPurchaseOnly: true },
  { id: 'store-request', level: 'store', title: '门店报货', group: '需求与采购', icon: PackagePlus, tone: 'text-[#C0322A] bg-[#FFF0EE]' },
  { id: 'store-receipt', level: 'store', title: '分院收货入库', group: '发货、收货与退货', icon: ClipboardCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'store-return', level: 'store', title: '门店退货申请', group: '发货、收货与退货', icon: Undo2, tone: 'text-[#D4820A] bg-[#FFF8E6]' },
]

/**
 * 通用建单业务（#191）：没有专属业务函数，就是直接建一张某类型的单。
 *
 * 改动前这 10 张卡带 `href` 直接跳单据中心，且**借用**三个转换业务的 id 当 React key ——
 * 一旦哪张卡被改成内嵌表单，它的单据 Tab 会列出库存转换单（页面完全正常、数据完全不对）。
 * 现在每张卡用 `generic:<docType>` 作为自己的 id，单据映射由 docType 天然派生。
 */
const GENERIC_OPERATIONS = {
  'supply-chain': [
    { docType: '内部领用', level: 'supply-chain', title: '内部领用', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
  ],
  market: [
    { docType: '市场间调货出库', level: 'market', title: '市场间调货', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
    { docType: '市场产品报损', level: 'market', title: '市场产品报损', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
    { docType: '市场库存盘点', level: 'market', title: '市场库存盘点', group: '市场特殊业务', icon: ClipboardCheck, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
    { docType: '市场产品盘溢', level: 'market', title: '市场产品盘溢', group: '市场特殊业务', icon: PackagePlus, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  ],
  store: [
    { docType: '分院调货出库', level: 'store', title: '门店调拨', group: '发货、收货与退货', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
    { docType: '院顾客退货', level: 'store', title: '顾客产品退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
    { docType: '院产品报损', level: 'store', title: '门店产品报损', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
    { docType: '分院库存盘点', level: 'store', title: '门店库存盘点', group: '市场特殊业务', icon: ClipboardCheck, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  ],
} as const satisfies Record<InventoryBusinessLevel, readonly GenericOperationDefinition[]>

/*
 * 跳转卡（#350）：不在办理台内建单，点开直接去对应的业务页。
 *
 * 「顾客产品出库」原是通用建单卡，#350 起顾客出库必须绑定销售单、只能由提货服务产生
 * （`院顾客产品出库` 已移出 INVENTORY_GENERIC_DOC_TYPES），入口改为提货录入页。
 * 它**不进** `levelOperations`：没有工作区、没有单据 Tab，也不参与 `?op=` 的 URL 恢复。
 *
 * 可用判据是目标页的入口权限（`pickup_record:create`，用户 2026-09-25 拍板），不是库存 operate ——
 * 代建门店业务的市场财务有 store operate 代建权却没有提货权限，按 operate 判会给它一张点进去就 403 的卡。
 */
interface LinkOperationDefinition extends Omit<OperationCardBase, 'approvalOnly' | 'shipmentCancellationAccess' | 'selfPurchaseOnly'> {
  key: string
  href: string
  /** 无权限时卡片上的说明，告诉用户缺的是什么 */
  deniedHint: string
}

const LINK_OPERATIONS: Record<InventoryBusinessLevel, readonly LinkOperationDefinition[]> = {
  'supply-chain': [],
  market: [],
  store: [
    {
      key: 'pickup-record-create',
      href: '/pickup-records/create',
      level: 'store',
      title: '顾客产品出库',
      group: '发货、收货与退货',
      icon: PackageX,
      tone: 'text-[#D94040] bg-[#FFF0F0]',
      deniedHint: '需提货录入权限',
    },
  ],
}

/*
 * 编译期覆盖性检查：9 张卡的 docType 并集必须**恰好**等于全部通用建单类型。
 * 漏一种（比如新增了通用类型却忘了配卡片），下面这行的类型立刻变成 never 而报错 ——
 * 不必等测试跑起来，更不必等用户发现某个业务在办理台里根本没有入口。
 */
type DeclaredGenericDocTypes = (typeof GENERIC_OPERATIONS)[InventoryBusinessLevel][number]['docType']
const _genericCardsCoverAllTypes: Exclude<InventoryGenericDocType, DeclaredGenericDocTypes> extends never
  ? true
  : ['缺少通用业务卡片', Exclude<InventoryGenericDocType, DeclaredGenericDocTypes>] = true
void _genericCardsCoverAllTypes

/** 通用卡 → 统一成与内置卡同形的条目（id 由 docType 派生）。 */
function genericAsOperation(definition: GenericOperationDefinition): ResolvedOperation {
  return { ...definition, id: genericOperationId(definition.docType), kind: 'generic' }
}

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function optionalText(value: string): string | null {
  return value.trim() || null
}

function positiveNumber(value: string): number | null {
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function nonnegativeNumber(value: string): number | null {
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}

function formatDoc(doc: InventoryDocRow): string {
  return `${doc.id} · ${doc.docDate.slice(0, 10)} · ${inventoryDocStatusLabel(doc)}`
}

function docCandidates(docs: InventoryDocRow[], docType: InventoryDocRow['docType'], status?: string) {
  return docs.filter((doc) => doc.docType === docType && doc.status !== '已取消' && (!status || doc.status === status))
}

function hasAvailableQuantity(item: InventoryDocDetail['items'][number]) {
  return remainingQuantity(item) > 0.000001
}

function remainingQuantity(item: InventoryDocDetail['items'][number]) {
  return Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))
}

function formatPrice(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(2)
}

function SmallIconButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip content={label}>
      <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled}>
        <X />
      </Button>
    </Tooltip>
  )
}

/**
 * `required` 只加视觉标记，**不往控件上加 HTML `required` 属性**。
 *
 * 注意区分两种原生校验，它们的职责不重叠：
 * - `min` / `max` / `step` 拦的是「填了但越界」。这正是 #135 组 3 要的浏览器级约束，
 *   submit() 里的 JS 校验**管不到**（它只看空/零/组合逻辑），两者互补，所以刻意保留。
 * - `required` 拦的是「空值」，而本页**大量字段是条件必填**：品项公司发货的
 *   「正常发货 / 赠送数量」二选一、批次走 filter-then-validate（不发货的行留空合法）、
 *   驳回时备注才必填。给它们加 `required` 会把合法的留空一律拦下，
 *   且弹出的是浏览器通用文案而不是业务文案（「请选择报货门店和市场」）。
 *
 * 所以这里不是"回避原生校验"，而是：**值域交给浏览器，必填与组合逻辑交给 submit()**。
 *
 * 标注判据取自各表单 submit() 的校验分支，不是凭字段名猜的：
 * `positiveNumber()` 对空串返回 null（`Number('') === 0`，不满足 `> 0`）→ 真必填；
 * `nonnegativeNumber()` 对空串返回 0 → 清空等价于填 0，**不是**必填；
 * `optionalText()` → 可选。
 */
function FormField({
  label,
  children,
  className = '',
  required = false,
  group = false,
}: {
  label: string
  children: ReactNode
  className?: string
  required?: boolean
  /**
   * 复合控件（可检索的商品选择：触发按钮 + 搜索框 + 选项列表）用 group：渲染成
   * `div[role=group]` 并以 aria-labelledby 关联字段名。`<label>` 只能包含一个关联控件，
   * 包住整个选择器既是无效语义，点面板里任何东西还会被 label 激活转发回触发按钮（#339）。
   */
  group?: boolean
}) {
  const labelId = useId()
  const caption = (
    <span id={group ? labelId : undefined} className="block text-sm font-medium">
      {label}
      {required && (
        <>
          <span className="ml-0.5 text-[var(--primary)]" aria-hidden="true">*</span>
          <span className="sr-only">（必填）</span>
        </>
      )}
    </span>
  )
  if (group) {
    return (
      <div role="group" aria-labelledby={labelId} className={`space-y-1.5 ${className}`}>
        {caption}
        {children}
      </div>
    )
  }
  return (
    <label className={`space-y-1.5 ${className}`}>
      {caption}
      {children}
    </label>
  )
}

function RemarkField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormField label="备注">
      <Textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder="填写备注" />
    </FormField>
  )
}

function OperationHeader({
  title,
  onClose,
  closeDisabled = false,
}: {
  title: string
  onClose: () => void
  closeDisabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-[#FFF0EE] text-[var(--primary)]">
          <Boxes className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <Button type="button" variant="outline" onClick={onClose} disabled={closeDisabled}>
        关闭
      </Button>
    </div>
  )
}

function DocPicker({
  label,
  docs,
  value,
  current = null,
  onChange,
  disabled = false,
  required = false,
}: {
  label: string
  docs: InventoryDocRow[]
  value: string
  /**
   * 当前选中的那张单据本身（各表单 `useLoadedDocument()` 拿到的 `doc`）。
   * 只用于「选中值不在 `docs` 里」时补一条选项，见下方 `selectedMissing`。
   */
  current?: InventoryDocRow | null
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
}) {
  /*
   * 选中值不在候选集里的兜底（#192）。
   *
   * 两边口径本来就不一样：`docs` 来自 RSC 传下来的 `workflowDocs`，那是页面服务端
   * 按 `page: 1, pageSize: 100` 拉的一页 —— **全类型混排的最近 100 张**；
   * 而 `value` 可能来自待办区「去收货」的预选券，待办段是服务端按类型 + 状态**全量分页**查的。
   * 长期挂着的待收货单大概率就落在那 100 张之外。
   *
   * `<select value={x}>` 匹配不到任何 `<option>` 时，浏览器落到 `selectedIndex = -1`：
   * 表现是**下拉一片空白、下方明细表却已经加载好**，既没有报错也没有任何提示，
   * 用户只会以为跳转失败。同一条路还能被正常路径踩到 —— 选好一张单之后
   * 行内动作 / 建单成功触发 `router.refresh()`，这张单的状态变了就会掉出
   * `docCandidates` 的状态过滤，下拉同样归空。
   *
   * 所以：选中值没有对应选项时就地补一条。有 `current` 就用它的完整文案；
   * 还在加载（`current` 尚为 null）时先用单号占位，保证 select 任何时刻都有选中项。
   *
   * ⚠️ 这只治**显示**：候选集本身仍是最近 100 张混排，正常路径下更老的单在下拉里
   * 依旧翻不出来、选不到。要根治得让服务端按 docType + status 出候选（PR follow-up）。
   */
  const selectedMissing = value !== '' && !docs.some((doc) => doc.id === value)
  return (
    <FormField label={label} required={required}>
      <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">请选择</option>
        {selectedMissing && (
          <option value={value}>{current && current.id === value ? formatDoc(current) : value}</option>
        )}
        {docs.map((doc) => (
          <option key={doc.id} value={doc.id}>{formatDoc(doc)}</option>
        ))}
      </Select>
    </FormField>
  )
}

/**
 * 办理台各明细行的库存商品选择：服务端检索 + 分页（#339），见 `InventorySkuSearchSelect`。
 * `filters` 必须与该业务建单时的服务端校验同口径，不传则只出启用商品（批次 / 服务端再校验兜底）。
 */
function SkuPicker({
  value,
  onChange,
  filters,
  disabled = false,
  disabledHint,
}: {
  value: string
  onChange: (value: string) => void
  filters?: InventorySkuOptionFilters
  disabled?: boolean
  disabledHint?: string
}) {
  return (
    <InventorySkuSearchSelect
      value={value}
      onChange={(skuId) => onChange(skuId)}
      filters={filters}
      disabled={disabled}
      disabledHint={disabledHint}
    />
  )
}

function LotPicker({
  locationId,
  skuId,
  value,
  onChange,
}: {
  locationId: string
  skuId: string
  value: string
  onChange: (value: string) => void
}) {
  const [lots, setLots] = useState<InventoryLotRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!locationId || !skuId) {
      setLots([])
      return () => { cancelled = true }
    }
    setLoading(true)
    listInventoryLotOptions(locationId, skuId)
      .then((rows) => {
        if (!cancelled) setLots(rows)
      })
      .catch((error) => {
        if (!cancelled) {
          setLots([])
          toast.error(actionErrorMessage(error, '加载可用批次失败'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [locationId, skuId])

  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={!locationId || !skuId || loading}>
      <option value="">{loading ? '正在加载批次' : '选择库存批次'}</option>
      {lots.map((lot) => (
        <option key={lot.id} value={String(lot.id)}>
          批次 {lot.batchNo || '未填写'} · 可用 {lot.quantityOnHand}{lot.expiryDate ? ` · 效期 ${lot.expiryDate}` : ''}
        </option>
      ))}
    </Select>
  )
}

function useLoadedDocument() {
  const [docId, setDocId] = useState('')
  const [doc, setDoc] = useState<InventoryDocDetail | null>(null)
  const [loading, setLoading] = useState(false)

  const selectDocument = useCallback(async (id: string) => {
    setDocId(id)
    setDoc(null)
    if (!id) return
    setLoading(true)
    try {
      const detail = await getInventoryCoreDocById(id)
      if (!detail) {
        toast.error('未找到可操作的关联单据')
        return
      }
      setDoc(detail)
    } catch (error) {
      toast.error(actionErrorMessage(error, '加载关联单据失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  return { docId, doc, loading, selectDocument }
}

/** 待办区「去收货」跳到填报表单时带的预选券（#192）。 */
interface OperationFormPrefill {
  docId: string
  /**
   * 每点一次自增。用 token 而不是裸 docId 当触发源：同一张单点第二次时 docId 没变，
   * 只挂 docId 的 effect 不会再跑，表现是「第二次点没反应」且没有任何报错。
   */
  token: number
}

/**
 * 把预选券兑现成一次 `selectDocument`。
 *
 * 覆盖语义是**直接切换 + toast 告知**，不做二次确认：收货表单输入量小
 * （实收数量默认预填待收数），代价低。注意 `selectDocument` 会重置明细行 ——
 * 在填报表单里填到一半再从待办区跳过来，填的内容会丢，这点在 PR 里单列说明。
 */
function useDocumentPrefill(
  prefill: OperationFormPrefill | null | undefined,
  selectDocument: (id: string) => Promise<void>,
) {
  const token = prefill?.token
  const docId = prefill?.docId
  useEffect(() => {
    if (!docId) return
    void selectDocument(docId)
    toast.info(`已切换到单据 ${docId}`)
    // 依赖只挂 token（理由见 OperationFormPrefill.token）。docId 随 token 一起确定，
    // selectDocument 是 useLoadedDocument 里 deps 为空的 useCallback，恒定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
}

function SourceDocumentItems({
  doc,
  canViewPrice,
}: {
  doc: InventoryDocDetail | null
  canViewPrice: boolean
}) {
  if (!doc) return null
  return (
    <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
          <tr>
            <th className="px-3 py-2 font-medium">商品</th>
            <th className="px-3 py-2 font-medium">数量</th>
            <th className="px-3 py-2 font-medium">已处理</th>
            <th className="px-3 py-2 font-medium">待处理</th>
            {canViewPrice && <th className="px-3 py-2 font-medium">单价</th>}
          </tr>
        </thead>
        <tbody>
          {doc.items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--border)]">
              <td className="px-3 py-2">
                <div className="font-medium">{item.skuName}</div>
                <div className="text-xs text-[#888888]">{item.specName || item.skuId}</div>
              </td>
              <td className="px-3 py-2">{item.quantity}</td>
              <td className="px-3 py-2">{item.fulfilledQuantity ?? 0}</td>
              <td className="px-3 py-2">{Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))}</td>
              {canViewPrice && <td className="px-3 py-2">{item.actualUnitPrice ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function InventoryOperationsPage({
  level,
  locations,
  marketTransferTargets,
  suppliers,
  workflowDocs,
  canCreate,
  canApprove,
  canSelfPurchase,
  canRequestShipmentCancellation,
  canApproveShipmentCancellation,
  canViewPrice,
  canCreatePickupRecord,
  initialOperationId,
}: {
  level: InventoryBusinessLevel
  locations: InventoryLocationRow[]
  /** 市场间调货出库的接收主体候选（#340），只喂给通用建单表单，见其同名 prop */
  marketTransferTargets?: readonly InventoryMarketTransferTarget[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canCreate: boolean
  canApprove: boolean
  canSelfPurchase: boolean
  canRequestShipmentCancellation: boolean
  canApproveShipmentCancellation: boolean
  canViewPrice: boolean
  /** 跳转卡「顾客产品出库」的可用判据：目标页（提货录入）的入口权限（#350） */
  canCreatePickupRecord: boolean
  /** 深链 `?create=<docType>` 解析出的初始业务（#191），服务端已校验权限与白名单。 */
  initialOperationId?: InventoryAnyOperationId
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  /*
   * #190 返回入口的 URL 恢复：详情页「返回XX办理台」在 window.close() 关不掉时会降级导航到
   * `/inventory/operations/<level>?op=<业务>&tab=docs`。这里只在**首次挂载**读一次 ——
   * 恢复的也只有 URL 层（level 由路由段带、选中的业务卡片、单据 Tab），
   * 填了一半的 React 表单 state 恢复不了，那正是详情页要优先走 window.close() 的理由。
   *
   * 参数名 `op`/`tab` 刻意避开 `create`/`view`：本页的服务端入口会把带 `view=docs` 的请求
   * 整体重定向到单据中心，撞上就永远回不到办理台。
   */
  const restoredOperation = useMemo(
    () => parseInventoryOperationId(searchParams.get('op')),
    [searchParams],
  )
  const [activeOperation, setActiveOperation] = useState<InventoryAnyOperationId | null>(
    () => initialOperationId ?? restoredOperation ?? null,
  )
  /*
   * 单据 Tab 的「一次性券」：只对**从详情页返回时 URL 里带的那个业务**生效。
   * 必须是一次性的 —— 下面 `<Tabs key={operation}>` 在 A→B→A 时会重建，
   * 若直接读 URL 上的 tab，第二次打开 A 又会被弹回单据 Tab，用户永远回不到填报表单，
   * 而且没有任何报错。
   */
  const [pendingDocsTabFor, setPendingDocsTabFor] = useState<InventoryAnyOperationId | null>(
    () => (parseInventoryOperationsTab(searchParams.get('tab')) === 'docs' ? restoredOperation : null),
  )
  /*
   * 工作区里有提交在途时，锁住所有卡片与关闭按钮：这时候切走会把表单连同
   * 在途请求一起卸载 —— 单其实已经建出去了，用户只看到面板消失，没有任何结果反馈。
   */
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const levelOperations = useMemo<ResolvedOperation[]>(
    () => [
      ...OPERATIONS.filter((operation) => operation.level === level).map(
        (operation) => ({ ...operation, kind: 'builtin' }) as ResolvedOperation,
      ),
      ...GENERIC_OPERATIONS[level].map(genericAsOperation),
    ],
    [level],
  )
  /*
   * 权限判据的唯一收口点：卡片的 disabled 态与「URL 恢复出来的业务能不能打开」必须同一份。
   * 不收口的话，手改 URL `?op=purchase-order` 能打开一张按钮本来是 disabled 的卡片 ——
   * 只是 UI 越权（server action 侧 withPermission 仍会拦），但不该让表单渲染出来。
   * 刻意**不含** `!workspaceBusy`：那是「提交在途时锁卡片」的临时态，不是权限。
   */
  const operationEnabled = useCallback((operation: OperationCardBase) => {
    const hasShipmentCancellationAccess = operation.shipmentCancellationAccess === '申请'
      ? canRequestShipmentCancellation
      : operation.shipmentCancellationAccess === '审批'
        ? canApproveShipmentCancellation
        : true
    const hasSelfPurchaseAccess = !operation.selfPurchaseOnly || canSelfPurchase
    return (operation.approvalOnly ? canApprove : canCreate)
      && hasShipmentCancellationAccess
      && hasSelfPurchaseAccess
  }, [canApprove, canApproveShipmentCancellation, canCreate, canRequestShipmentCancellation, canSelfPurchase])
  // `levelOperations` 只含本层级的卡，跨层级的 `?op=` 天然解析不出来（市场台带门店业务 → null）。
  const active = levelOperations.find(
    (operation) => operation.id === activeOperation && operationEnabled(operation),
  ) ?? null
  const selectOperation = useCallback((id: InventoryAnyOperationId) => {
    // 手点卡片一律落回「填报表单」：一次性券只服务于返回路径。
    setPendingDocsTabFor(null)
    setActiveOperation(id)
  }, [])
  const levelLinkOperations = LINK_OPERATIONS[level]
  const groups = useMemo(
    () => Array.from(new Set([...levelOperations, ...levelLinkOperations].map((operation) => operation.group))),
    [levelOperations, levelLinkOperations],
  )
  const levelMeta = {
    'supply-chain': { title: '供应链库存业务', description: '处理品项公司需求、采购、发货、退货审批和总部库存。' },
    market: { title: '市场库存业务', description: '处理市场采购、门店配货、退货审批及市场特殊库存业务。' },
    store: { title: '门店库存业务', description: '处理门店报货、收货、退货、调拨和日常库存业务。' },
  }[level]

  useEffect(() => {
    if (!initialOperationId) return
    /*
     * 先打开再抹参数。`useState(initialOperationId ?? null)` 只吃**首次挂载**的初值，
     * 客户端软导航（Link / router.push 到同一路由带 ?create=）时服务端 prop 变了、
     * 组件却不重挂，光抹参数的话就成了「整页加载生效、软导航静默失效」的半生效 ——
     * 而验收标准明确要求二选一。
     */
    setActiveOperation(initialOperationId)
    // 抹掉 ?create=：留着的话用户关掉工作区一刷新又自动弹开，这个 URL 被收藏 / 分享
    // 出去也会带着「自动打开某张卡」的副作用。
    router.replace(`/inventory/operations/${level}`, { scroll: false })
  }, [initialOperationId, level, router])

  /*
   * 从详情页返回时滚到已展开的工作区（#190）。工作区渲染在卡片网格**下方**，
   * 不滚的话用户落在页面顶部，看不到自己刚被恢复出来的那张卡，会以为返回没生效。
   * 只在恢复路径生效、且只做一次（ref 守卫）——手点卡片不该被页面自己拽走。
   */
  const workspaceRef = useRef<HTMLDivElement>(null)
  const restoreScrolled = useRef(false)
  useEffect(() => {
    if (restoreScrolled.current) return
    if (!restoredOperation) return
    const node = workspaceRef.current
    if (!node || typeof node.scrollIntoView !== 'function') return
    restoreScrolled.current = true
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [restoredOperation])

  const afterSuccess = useCallback((message: string) => {
    toast.success(message)
    router.refresh()
  }, [router])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="size-6 text-[var(--primary)]" />
          <div>
            <h1 className="text-xl font-medium">{levelMeta.title}</h1>
            <p className="mt-1 text-sm text-[#666666]">{levelMeta.description}</p>
          </div>
        </div>
      </div>

      {!canCreate && !canApprove && !canSelfPurchase && !canRequestShipmentCancellation && !canApproveShipmentCancellation && (
        <div className="border border-[#F2D7D4] bg-[#FFF8F7] px-4 py-3 text-sm text-[#9F2D27]">
          当前账号没有库存操作权限。
        </div>
      )}

      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group} className="space-y-3">
            <h2 className="text-sm font-medium text-[#555555]">{group}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {levelOperations.filter((operation) => operation.group === group).map((operation) => {
                const Icon = operation.icon
                // 权限判据走 operationEnabled（与 URL 恢复共用同一份，见上方定义）；
                // !workspaceBusy 是「提交在途时锁卡片」，只在这里叠加。
                const enabled = operationEnabled(operation) && !workspaceBusy
                const content = (
                  <>
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] ${operation.tone}`}>
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{operation.title}</span>
                      {operation.approvalOnly && <Badge variant="outline" className="mt-1 text-[10px]">审批权限</Badge>}
                      {operation.shipmentCancellationAccess === '申请' && <Badge variant="outline" className="mt-1 text-[10px]">撤回申请权限</Badge>}
                      {operation.shipmentCancellationAccess === '审批' && <Badge variant="outline" className="mt-1 text-[10px]">撤回审批权限</Badge>}
                      {operation.selfPurchaseOnly && <Badge variant="outline" className="mt-1 text-[10px]">自采入库权限</Badge>}
                    </span>
                  </>
                )
                return (
                  <button
                    key={operation.id}
                    type="button"
                    disabled={!enabled}
                    onClick={() => selectOperation(operation.id)}
                    className="flex min-h-24 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-sm transition-colors hover:border-[var(--primary)] hover:bg-[#FFFDFC] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {content}
                  </button>
                )
              })}
              {levelLinkOperations.filter((operation) => operation.group === group).map((operation) => {
                const Icon = operation.icon
                const className = 'flex min-h-24 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-sm transition-colors'
                const content = (
                  <>
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] ${operation.tone}`}>
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{operation.title}</span>
                      <span className="mt-1 block text-xs text-[#888888]">
                        {canCreatePickupRecord ? '前往提货录入（按销售单出库）' : operation.deniedHint}
                      </span>
                    </span>
                  </>
                )
                // 无权限时渲染成 disabled 的 button 而不是去掉 href 的 Link：与其余卡片同一套
                // 可访问语义（读屏报「不可用」），也不会留下一个点了没反应的链接。
                return canCreatePickupRecord && !workspaceBusy ? (
                  <Link key={operation.key} href={operation.href} className={`${className} hover:border-[var(--primary)] hover:bg-[#FFFDFC]`}>
                    {content}
                  </Link>
                ) : (
                  <button key={operation.key} type="button" disabled className={`${className} cursor-not-allowed opacity-45`}>
                    {content}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {active && (
        <Card ref={workspaceRef}>
          <CardContent className="p-5">
            <OperationWorkspace
              /*
               * key：工作区自己也有跟着业务走的 state 了（Tab 选中态、「去收货」的表单预选券）。
               * 内层 `<Tabs key={operation}>` 只重建 Tabs 子树，管不到 OperationWorkspace
               * 自己的 useState —— 不加这道 key，A→B 时 B 会继承 A 的 Tab 选中态与预选券。
               */
              key={active.id}
              operation={active}
              level={level}
              defaultTab={pendingDocsTabFor === active.id ? 'docs' : 'form'}
              /*
               * 行内动作的前端可见性判据，与卡片 `enabled` **同一个** operationEnabled ——
               * 别在下游再算一份。当前 `active` 已经过这道判据，所以这里恒为 true；
               * 留着这个 prop 是为了让 OperationDocsTab 的权限口径显式可测，
               * 也为了将来有人放宽 `active` 的筛选时不至于连闸门都没有。
               * 真正的授权边界在 Server Action 的 withPermission + assertLocationWritable。
               */
              canAct={operationEnabled(active)}
              busy={workspaceBusy}
              onBusyChange={setWorkspaceBusy}
              locations={locations}
              marketTransferTargets={marketTransferTargets}
              suppliers={suppliers}
              workflowDocs={workflowDocs}
              canViewPrice={canViewPrice}
              onClose={() => { setPendingDocsTabFor(null); setActiveOperation(null) }}
              onSuccess={afterSuccess}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function OperationWorkspace({
  operation: card,
  level,
  defaultTab,
  canAct,
  busy,
  onBusyChange,
  locations,
  marketTransferTargets,
  suppliers,
  workflowDocs,
  canViewPrice,
  onClose,
  onSuccess,
}: {
  operation: ResolvedOperation
  /** 单据 Tab 的单据号链接要带来源参数（#190 返回入口），所以层级得一路传到下游。 */
  level: InventoryBusinessLevel
  /** 只在「从详情页返回」那一次是 'docs'，由父层的一次性券决定。 */
  defaultTab: 'form' | 'docs'
  /** 待办行内动作按钮的前端可见性判据，由父层用 operationEnabled 算好（#192）。 */
  canAct: boolean
  busy: boolean
  /**
   * 工作区里**任一**提交在途时上报（建单表单 / 待办行内动作两条路都算），父层据此锁卡片。
   * 必须是稳定引用（父层的 `setWorkspaceBusy`）：下游 `DocActionDialog` 的 effect cleanup
   * 会在引用变化时补一次 `false`。
   */
  onBusyChange: (busy: boolean) => void
  locations: InventoryLocationRow[]
  marketTransferTargets?: readonly InventoryMarketTransferTarget[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onClose: () => void
  onSuccess: (message: string) => void
}) {
  const router = useRouter()
  const operation = card.id
  /*
   * Tabs 改受控（#192）：待办区的「去收货」要能把用户从单据 Tab 送回填报表单。
   * 初值仍是父层那张一次性券，切换权交给 setTab —— 组件外部（行内动作）也能推它。
   */
  const [tab, setTab] = useState<string>(defaultTab)
  /*
   * 「去收货」的表单预选券。用 token 而不是裸 docId：同一张单点第二次也要能再触发
   * （裸 docId 在 effect 依赖里不变，第二次点击静默失效）。
   */
  const [prefill, setPrefill] = useState<{ docId: string; token: number } | null>(null)
  /** 待办条数，挂在「单据」Tab 的角标上 —— 不点开也知道这张卡有没有活。 */
  const [inboxTotal, setInboxTotal] = useState(0)
  /*
   * 工作区里有**两条**提交路径会在途：填报表单侧的建单（`InventoryDocCreateForm`）与
   * 单据 Tab 里待办区的行内动作。两者的在途态都必须上报给父层的 `workspaceBusy` ——
   * 不上报的那条（行内动作原先就漏了）提交在途时卡片与「关闭」按钮都不锁，
   * 用户一切走就把在途请求连同整个工作区卸载：单其实已经办出去了，界面上却什么反馈都没有。
   *
   * 各存一份再 OR 上报，**不能共用一个布尔**：两个面板都是 keepMounted 的，
   * 「建单在途时切到单据 Tab 再办一张待办」完全可达，共用的话先结束的那条
   * 会把仍在途的那条一起解锁。
   */
  const [formBusy, setFormBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  useEffect(() => {
    onBusyChange(formBusy || actionBusy)
  }, [formBusy, actionBusy, onBusyChange])
  const handleGotoForm = useCallback((docId: string) => {
    setPrefill((previous) => ({ docId, token: (previous?.token ?? 0) + 1 }))
    setTab('form')
  }, [])
  return (
    <div className="space-y-5">
      <OperationHeader title={card.title} onClose={onClose} closeDisabled={busy} />
      {/*
        * key：`activeOperation` A→B 时父层元素类型与位置不变，React 原地更新、不重挂，
        * Tabs 的 uncontrolled state 会把「单据」选中态带到下一个业务 ——
        * 点开 B 直接落在 B 的单据页、填报表单被藏起来。加 key 强制重建。
        *
        * defaultTab 必须是父层的**一次性券**（pendingDocsTabFor === active.id），不能直接读 URL：
        * key 在 A→B→A 时重建 Tabs，直接读 URL 的话第二次打开 A 又被弹回单据 Tab，
        * 用户永远回不到填报表单，且没有任何报错。
        */}
      <Tabs key={operation} value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="form">填报表单</TabsTrigger>
          <TabsTrigger value="docs">
            单据
            {/*
              * 待办角标。sr-only 补一句是因为光一个数字读屏念出来是「单据 3」——
              * 听不出 3 是什么。
              */}
            {inboxTotal > 0 && (
              <Badge variant="outline" className="ml-1">
                {inboxTotal}
                <span className="sr-only"> 条待我处理</span>
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        {/*
          * keepMounted：表单面板切走时只隐藏不卸载。默认的卸载语义会把填了一半的
          * 明细行、选好的批次连同 useState 一起丢掉，用户去「单据」看一眼回来就得重填。
          */}
        <TabsContent value="form" keepMounted className="space-y-5">
          {/*
            * 通用业务没有专属表单，走与单据中心**同一份**共享建单表单（#191）。
            * visible 接 `true` 而不是「表单 Tab 是否在前台」：面板是 keepMounted 的，
            * 跟着 Tab 切换走会在用户去看一眼单据时清掉已选批次（#190 承诺切 Tab 不丢表单）。
            * 代价是久置后批次数据可能陈旧 —— 由服务端 FOR UPDATE + 可用量校验兜底，
            * 与「弹窗开着不动很久再提交」是同一条兜底路径。
            */}
          {card.kind === 'generic' && (
            <InventoryDocCreateForm
              visible
              locations={locations}
              marketTransferTargets={marketTransferTargets}
              initialDocType={card.docType}
              allowedDocTypes={[card.docType]}
              onSuccess={(docId) => onSuccess(`${card.title}单据已创建：${docId}`)}
              /*
               * 只刷新，**不能**接 onSuccess —— 那会在提交失败时弹一条绿色「成功」，
               * 跟共享组件自己弹的红色错误 toast 同屏打架。
               */
              onStale={() => router.refresh()}
              // 建单在途态先落到本地 formBusy，与行内动作的 actionBusy 合并后再上报（见上方注释）。
              onBusyChange={setFormBusy}
              renderActions={({ submit, submitting }) => (
                <div className="flex justify-end">
                  <Button type="button" onClick={submit} loading={submitting}>创建{card.title}单据</Button>
                </div>
              )}
            />
          )}
          {operation === 'store-request' && <StoreRequestForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'market-report' && <MarketReportForm locations={locations} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'item-company-request' && <ItemCompanyReplenishmentForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'purchase-order' && <PurchaseOrderForm locations={locations} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'market-report-summary' && <MarketReportSummaryForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'company-shipment' && <CompanyShipmentForm locations={locations} workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'market-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="market" prefill={prefill} onSuccess={onSuccess} />}
          {operation === 'supply-chain-receipt' && <SupplyChainPurchaseReceiptForm locations={locations} workflowDocs={workflowDocs} canViewPrice={canViewPrice} prefill={prefill} onSuccess={onSuccess} />}
          {operation === 'supply-chain-purchase-cancel' && <SupplyChainPurchaseCancelForm workflowDocs={workflowDocs} prefill={prefill} onSuccess={onSuccess} />}
          {operation === 'store-allocation' && <StoreAllocationForm locations={locations} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'store-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="store" prefill={prefill} onSuccess={onSuccess} />}
          {operation === 'store-return' && <ReturnForm locations={locations} sourceType="门店" onSuccess={onSuccess} />}
          {operation === 'market-return' && <ReturnForm locations={locations} sourceType="市场" onSuccess={onSuccess} />}
          {operation === 'store-return-approval' && <ReturnApprovalForm workflowDocs={workflowDocs} docType="院退货" onSuccess={onSuccess} />}
          {operation === 'market-return-approval' && <ReturnApprovalForm workflowDocs={workflowDocs} docType="市场退货" onSuccess={onSuccess} />}
          {operation === 'shipment-cancel' && <ShipmentCancellationRequestForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'shipment-cancel-approval' && <ShipmentCancellationApprovalForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'staff-purchase' && <MarketStaffPurchaseForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'supply-chain-staff-purchase' && <SupplyChainStaffPurchaseForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'self-purchase' && <SelfPurchaseForm locations={locations} suppliers={suppliers} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'external-outbound' && <ExternalOutboundForm locations={locations} onSuccess={onSuccess} />}
          {operation === 'supply-chain-conversion' && <ConversionForm locations={locations} locationType="总部" onSuccess={onSuccess} />}
        </TabsContent>
        {/*
          * keepMounted：单据面板切走时也不卸载。两个理由，缺一不可 ——
          * (1) 待办角标挂在 Tab 标题上，卸载了就归零，「不点开也知道有没有活」直接失效；
          * (2) 切回来要重新发两次查询。
          * 代价是**点开业务卡片就立刻发一次两段查询**（原先要切到单据 Tab 才发），
          * 是本次改动最大的 DB 往返增量。
          */}
        <TabsContent value="docs" keepMounted>
          <OperationDocsTab
            operation={operation}
            level={level}
            canViewPrice={canViewPrice}
            canAct={canAct}
            onGotoForm={handleGotoForm}
            onInboxTotalChange={setInboxTotal}
            /*
             * 行内动作的在途态：与建单那条口径对齐，在途时一并锁住卡片与「关闭」按钮。
             * `setActionBusy` 是 setState，稳定引用 —— 下游 DocActionDialog 要求。
             */
            onActionBusyChange={setActionBusy}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

const OPERATION_DOCS_PAGE_SIZE = 20

/*
 * ────────── 待办区的行内动作（#192） ──────────
 *
 * 动作集合、以及「哪个动作在哪个状态下出现」的单源在
 * `@/lib/inventory/operation-doc-types`（纯数据，与服务端的 inbox 查询条件同文件、
 * 由单测互相钉死）。本文件只负责把它们接到 Server Action、文案与弹窗上。
 */

/**
 * **不进弹窗**的两个动作：只把用户送回「填报表单」Tab 并预选这张单。
 *
 * 供应链采购入库要逐行核对效期（批号留空已由服务端按入库单号+行号生成（#345），效期推断不出来），
 * 所以它只有跳转版、没有一键版；市场 / 门店收货两条既有一键版也留跳转版，
 * 部分收货与差异登记仍得回表单。
 */
const INBOX_GOTO_ACTION_KINDS = ['shipment-receive-goto', 'purchase-receive-goto'] as const
type InboxGotoActionKind = (typeof INBOX_GOTO_ACTION_KINDS)[number]
/**
 * 走 `DocActionDialog` 的动作。
 *
 * 刻意从 `InventoryInboxActionKind` 里 `Exclude` 掉跳转类 —— `DocActionDialog` 的
 * `config` 是 `Record<K, DocActionSpec>`，只要把跳转类也算进 K，就必须给它们编一份
 * 用不上的弹窗文案；而漏编则直接编译失败。类型上分开，两类动作各自完整。
 */
type InboxDialogActionKind = Exclude<InventoryInboxActionKind, InboxGotoActionKind>

const INBOX_GOTO_ACTION_SET: ReadonlySet<InventoryInboxActionKind> = new Set(INBOX_GOTO_ACTION_KINDS)

function isInboxGotoAction(kind: InventoryInboxActionKind): kind is InboxGotoActionKind {
  return INBOX_GOTO_ACTION_SET.has(kind)
}

/**
 * 行内按钮文案。同一张卡片上不会同时出现「通过」的两种来源（退货 / 撤回），不会撞名。
 *
 * ⚠️ 这里**没有「草稿 → 取消」**，是数据层刻意的决定不是遗漏：
 * 没有任何业务产出草稿单（`insertDocHeader` 每次都显式传 status，`草稿` 只是列默认值），
 * 全仓也没有「取消草稿」的 Server Action。口径与理由写在
 * `@/lib/inventory/operation-doc-types` 的 `INVENTORY_INBOX_ACTION_KINDS` 上，
 * 并有单测断言状态值域不含 `草稿` —— 哪天真有业务产出草稿单，那条会红并提醒补这个动作。
 */
const INBOX_ACTION_LABEL: Record<InventoryInboxActionKind, string> = {
  'return-approve': '通过',
  'return-reject': '驳回',
  'cancellation-approve': '通过',
  'cancellation-reject': '驳回',
  'shipment-receive-full': '一键收货',
  'shipment-receive-goto': '去收货',
  'purchase-receive-goto': '去收货',
  'purchase-close': '关闭采购',
  'generic-receive': '确认收货',
}

/**
 * 一键整单收货 → 两个**单权限**的 Server Action。
 *
 * ⚠️ 必须按业务分发到两个 action，**不能**做成一个按 docType 分发的聚合入口：
 * lib 层只有 `assertLocationWritable`（scope 校验）没有 action 级校验，聚合写法会让
 * 只持有 `inventory:market_operate` 的市场角色在 scope 覆盖下属门店时替门店收货 ——
 * 而现有 `receiveStoreAllocation` 是单权限 `inventory:store_operate`，市场角色本该被拒。
 *
 * 用 `Map` 而不是对象字面量：对象查表会命中 `Object.prototype`，
 * `operation` 万一是 `'constructor'` 这类串会取到一个 truthy 的函数（fail-open）。
 */
const FULL_RECEIVE_ACTIONS: ReadonlyMap<
  string,
  (input: ReceiveShipmentInFullInput) => Promise<{ id: string; shipmentId: string }>
> = new Map([
  ['market-receipt', receiveItemCompanyShipmentInFull],
  ['store-receipt', receiveStoreAllocationInFull],
])

/**
 * 待办行内动作的弹窗配置。
 *
 * 做成工厂而不是模块级常量，只为了 `shipment-receive-full` 一条 —— 它要按业务选
 * 市场 / 门店两个不同权限的 action（见 `FULL_RECEIVE_ACTIONS`）。
 *
 * `remarkRequired` 每条都对齐服务端：服务端 `required(...)` 的一律 true。
 * 抄错了 TS **不会**报错（run 的入参形状抄错才会），所以这份口径由单测逐条钉住。
 */
function buildInboxActionConfig(
  operation: InventoryAnyOperationId,
): Readonly<Record<InboxDialogActionKind, DocActionSpec>> {
  return {
    'return-approve': {
      title: '确认通过退货？',
      label: '审批备注',
      placeholder: '选填，将记录在单据的审批信息中',
      // business.ts 的 approveReturnForRestock：auditRemark 可选
      remarkRequired: false,
      consequence: '通过后将从退货主体出库并回库到上级主体，单据变为已完成，不可撤销。',
      confirmText: '确认通过',
      successMessage: () => '退货已通过，货品已回库',
      errorFallback: '退货审批失败',
      run: (docId, remark) => approveReturnForRestock({ returnDocId: docId, auditRemark: remark || null }),
    },
    'return-reject': {
      title: '驳回退货申请',
      label: '驳回原因',
      placeholder: '请说明驳回原因，制单人可查看此说明',
      // business.ts 的 rejectReturnForRestock：required(input.auditRemark, '驳回原因')
      remarkRequired: true,
      confirmText: '确认驳回',
      confirmVariant: 'destructive',
      successMessage: () => '退货申请已驳回',
      errorFallback: '驳回失败',
      run: (docId, remark) => rejectReturnForRestock({ returnDocId: docId, auditRemark: remark }),
    },
    'cancellation-approve': {
      title: '确认通过撤回申请？',
      label: '审批备注',
      placeholder: '选填，将记录在单据的审批信息中',
      // business.ts 的 approveItemCompanyShipmentCancellation：auditRemark 可选
      remarkRequired: false,
      consequence: '撤回后总部库存将回滚、采购订单履约数量回退，发货单变为已取消，不可撤销。',
      confirmText: '确认通过',
      successMessage: () => '撤回申请已通过，发货单已取消',
      errorFallback: '撤回审批失败',
      run: (docId, remark) =>
        approveItemCompanyShipmentCancellation({ shipmentId: docId, auditRemark: remark || null }),
    },
    'cancellation-reject': {
      title: '驳回撤回申请',
      label: '驳回原因',
      placeholder: '请说明驳回原因，申请人可查看此说明',
      // business.ts 的 rejectItemCompanyShipmentCancellation：required(input.auditRemark, '驳回原因')
      remarkRequired: true,
      confirmText: '确认驳回',
      confirmVariant: 'destructive',
      successMessage: () => '撤回申请已驳回，发货单回到待收货',
      errorFallback: '驳回失败',
      run: (docId, remark) =>
        rejectItemCompanyShipmentCancellation({ shipmentId: docId, auditRemark: remark }),
    },
    'shipment-receive-full': {
      title: '整单收货',
      label: '收货备注',
      placeholder: '选填，将记录在入库单上',
      remarkRequired: false,
      consequence: '将按各明细的待收数量整单收货并生成入库单。需要部分收货或登记差异请用「去收货」。',
      confirmText: '确认整单收货',
      // 收货产出一张新入库单，单号是用户下一步要找的东西，别丢
      successMessage: (result) => {
        const inboundDocId = (result as { id?: unknown } | null)?.id
        return typeof inboundDocId === 'string' && inboundDocId
          ? `收货已确认，已生成入库单 ${inboundDocId}`
          : '收货已确认'
      },
      errorFallback: '整单收货失败',
      run: async (docId, remark) => {
        const receive = FULL_RECEIVE_ACTIONS.get(operation)
        // fail-closed：只有市场收货 / 门店收货两个台配了一键入口，其余业务宁可报错也不乱调。
        if (!receive) throw new Error('当前业务没有一键整单收货入口')
        return receive({ shipmentId: docId, remark: remark || null })
      },
    },
    'purchase-close': {
      title: '关闭采购订单',
      label: '关闭原因',
      placeholder: '请说明关闭原因，制单人可查看此说明',
      // business.ts 的 cancelSupplyChainPurchaseOrder：required(input.cancellationReason, '关闭原因')
      remarkRequired: true,
      consequence: '关闭后未收数量将退还来源报货单，采购订单变为已取消，不可撤销。',
      confirmText: '确认关闭',
      confirmVariant: 'destructive',
      successMessage: () => '采购订单已关闭，未收数量已释放',
      errorFallback: '关闭采购订单失败',
      run: (docId, remark) =>
        cancelSupplyChainPurchaseOrder({ purchaseOrderId: docId, cancellationReason: remark }),
    },
    'generic-receive': {
      title: '确认收货',
      label: '收货备注',
      placeholder: '选填，如实收与单据有差异请在此说明',
      remarkRequired: false,
      consequence: '确认后将生成对应的入库单并增加在手库存。',
      confirmText: '确认收货',
      successMessage: (result) => {
        const inboundDocId = (result as { inboundDocId?: unknown } | null)?.inboundDocId
        return typeof inboundDocId === 'string' && inboundDocId
          ? `收货已确认，已生成入库单 ${inboundDocId}`
          : '收货已确认'
      },
      errorFallback: '收货确认失败',
      /*
       * 唯一走 generic 三件套的动作：`分院调货出库` / `市场间调货出库`（#340）在 `INVENTORY_GENERIC_DOC_TYPES` 里，
       * 过得了服务端的 `assertGenericDocTransition`。上面 6 条绑的都是专用业务 action ——
       * 院退货 / 品项公司发货 / 分院配货 / 采购订单都不在那张白名单里，
       * 走 generic 会被 100% 拒掉（INVALID_STATE「必须通过对应的专用业务流程处理」）。
       */
      run: (docId, remark) => confirmInventoryCoreReceive(docId, remark),
    },
  }
}

/**
 * 业务工作区的「单据」Tab（#190 一段 → #192 两段）。
 *
 * 上段「待我处理」= 本业务要经手、但由上游产出的单（待审批 / 待收货），带行内动作；
 * 下段「本业务产出」= #190 的原语义，只读。
 *
 * 单据类型 / 状态 / 层级的收窄规则在服务端按 operationId 查映射表解析
 * （`listInventoryOperationDocs` 一次调用返回两段），这里只管展示、翻页与动作分发。
 *
 * `export` 是为了能脱开整页单独渲染测试（与同目录 inventory-docs-page 导出
 * SOURCE_LOT_DOC_TYPES 同例）。
 */
export function OperationDocsTab({
  operation,
  level,
  canViewPrice,
  canAct,
  onGotoForm,
  onInboxTotalChange,
  onActionBusyChange,
}: {
  /** 内置业务 id 或 `generic:<docType>`；查询条件由服务端按 id 解析（#190/#191）。 */
  operation: InventoryAnyOperationId
  /** 拼「返回XX办理台」来源参数用（#190）。 */
  level: InventoryBusinessLevel
  canViewPrice: boolean
  /**
   * 行内动作按钮的前端可见性。与业务卡片的 `enabled` 同源（父层的 `operationEnabled`）。
   *
   * ⚠️ 这只是**体验**，不是安全边界：授权判据在 Server Action 的
   * `withPermission` / `withAnyPermission` + lib 层的 `assertLocationWritable`。
   * 伪造调用照样会被服务端拒掉。
   */
  canAct: boolean
  /** 「去收货」：把用户送回填报表单并预选这张单。 */
  onGotoForm: (docId: string) => void
  /** 待办条数上报给工作区，挂在 Tab 角标上。 */
  onInboxTotalChange: (total: number) => void
  /**
   * 行内动作的提交在途态上报给工作区（#192 follow-up）。
   *
   * 和建单表单那条路径同口径：在途时锁住业务卡片与「关闭」按钮 —— 这时候切走会把
   * 在途请求连同整个工作区一起卸载，单已经办出去了而用户只看到面板消失。
   * 漏报的表现是「两条提交路径一个锁、一个不锁」，从界面上完全看不出来。
   *
   * ⚠️ 必须传**稳定引用**（setState 或 useCallback）：它会并进传给 `DocActionDialog` 的
   * `onBusyChange`，后者的 effect cleanup 在引用变化时补一次 `false`，
   * 内联箭头等于每次重渲都把在途态闪断一下。
   */
  onActionBusyChange: (busy: boolean) => void
}) {
  const router = useRouter()
  const [rows, setRows] = useState<InventoryDocRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(OPERATION_DOCS_PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [priceVisible, setPriceVisible] = useState(canViewPrice)
  /*
   * 待办段的 rows/total/pageSize 各存一份，**不与产出段共用** ——
   * 两段各自翻页、engine 也各自回传夹过白名单的页长，共用一个 state 会让其中一段算错总页数。
   */
  const [inboxRows, setInboxRows] = useState<InventoryDocRow[]>([])
  const [inboxTotal, setInboxTotal] = useState(0)
  const [inboxPage, setInboxPage] = useState(1)
  const [inboxPageSize, setInboxPageSize] = useState(OPERATION_DOCS_PAGE_SIZE)
  const [inboxFailed, setInboxFailed] = useState(false)
  /*
   * 行内动作跑完之后的重取券。**这是最容易漏的一条**：本 Tab 的数据是客户端 action 拉的，
   * `router.refresh()` 对它完全无效 —— 只调后者的话「提示 + 刷新」只完成了提示，
   * 办完的单仍停在待办区，用户会再点一次。
   */
  const [reloadToken, setReloadToken] = useState(0)
  /** 当前挂在弹窗上的动作。非空即「有窗开着」，同时也是开窗入口的点击闸。 */
  const [pendingInboxAction, setPendingInboxAction] = useState<DocActionPending<InboxDialogActionKind> | null>(null)
  /** 提交在途态，由 DocActionDialog 上报（`setActionBusy` 是稳定引用，符合它的契约）。 */
  const [actionBusy, setActionBusy] = useState(false)
  /*
   * 在途态有**两个消费者，职责不同，别合并**：
   * - 本地 `actionBusy`：开窗入口的点击闸（在途时点另一行直接不响应，不开第二个弹窗）；
   * - `onActionBusyChange`：上报给工作区，锁住业务卡片与「关闭」按钮。
   * 只留前者就是本次修的那条 —— 行内动作在途时工作区照样能被关掉。
   *
   * `useCallback` 而不是内联箭头：`DocActionDialog` 的 onBusyChange 要求稳定引用
   * （它的 effect cleanup 会在引用变化时补一次 false）。`onActionBusyChange` 由调用方
   * 保证稳定，这里的依赖数组才立得住。
   */
  const handleActionBusyChange = useCallback((busy: boolean) => {
    setActionBusy(busy)
    onActionBusyChange(busy)
  }, [onActionBusyChange])

  /*
   * 「这个业务有没有待办段」直接读映射表（纯函数、客户端可调），不等服务端响应：
   * 等响应的话首帧会闪一下、首次请求失败时整个区块连同失败提示一起消失
   * —— 用户只会看到产出段报错，不知道待办也没取到。
   * 查询条件本身仍然只在服务端解析，这里读的是同一张表的同一个字段，不是第二份真相。
   */
  const hasInbox = useMemo(() => resolveOperationDocQuery(operation)?.inbox != null, [operation])
  const inboxActions = useMemo(() => resolveOperationInboxActions(operation), [operation])
  const inboxActionConfig = useMemo(() => buildInboxActionConfig(operation), [operation])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    setInboxFailed(false)
    listInventoryOperationDocs({
      operationId: operation,
      page,
      inboxPage,
      pageSize: OPERATION_DOCS_PAGE_SIZE,
    })
      .then((result) => {
        if (cancelled) return
        setRows(result.produced.data)
        setTotal(result.produced.total)
        // 服务端会把非白名单页长夹成 20，按它返回的实际值渲染分页器，
        // 否则前端按自己那份 pageSize 算总页数，最后几页会翻不到。
        setPageSize(result.produced.pageSize)
        setPriceVisible(result.produced.canViewPrice)
        if (result.inbox) {
          setInboxRows(result.inbox.data)
          setInboxTotal(result.inbox.total)
          setInboxPageSize(result.inbox.pageSize)
        } else {
          setInboxRows([])
          setInboxTotal(0)
        }
      })
      .catch((error) => {
        if (cancelled) return
        // 刻意**不清零 total**：清了会让 Pagination 算出 totalPages=1，
        // 越界自纠 effect 把用户从第 3 页静默弹回第 1 页并再发一次请求 ——
        // 一次瞬时失败被放大成「跳页 + 重复请求 + 第二条 toast」。待办段同理。
        setRows([])
        setInboxRows([])
        // 失败态与空态必须分开：都渲染成「暂无单据」会让人以为这个业务真的没单，
        // 而实际上是这次没取到。
        setFailed(true)
        setInboxFailed(true)
        toast.error(actionErrorMessage(error, '加载单据失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [operation, page, inboxPage, reloadToken])

  useEffect(() => {
    onInboxTotalChange(hasInbox ? inboxTotal : 0)
  }, [hasInbox, inboxTotal, onInboxTotalChange])

  const columns: Column<InventoryDocRow>[] = [
    {
      key: 'id',
      header: '单据号',
      /*
       * 新标签打开，且**不做整行点击**：keepMounted 的全部意义就是「去单据 Tab 看一眼
       * 回来表单还在」，行内 router.push 会把整个办理台连同填了一半的明细一起卸载，
       * 而 returnTo 那套只能恢复 URL、恢复不了 React state。
       *
       * href 带来源参数（`from/level/op`，两个闭集枚举，详见 operation-return.ts）：
       * 详情页据此渲染「返回XX办理台」。漏传的话详情页的返回入口会静默退化成
       * 「返回单据中心」—— 两个页面各自看都完全正常，没人看得出来。
       *
       * `rel="opener"`（而不是默认的 noopener）：详情页的返回按钮要靠 `window.opener`
       * 判断「本标签是办理台开出来的」，能判就直接 window.close() 回到原标签，
       * 办理台填了一半的表单一个字不丢。这是甲方「返回到原来的页面」的字面要求。
       * 同源页面，没有 noopener 要防的跨源风险。
       */
      cell: (row) => (
        <a
          href={inventoryOperationDocHref(row.id, level, operation)}
          target="_blank"
          rel="opener"
          className="font-mono text-xs text-[var(--primary)] underline-offset-2 hover:underline"
        >
          {row.id}
        </a>
      ),
    },
    {
      key: 'docType',
      header: '类型',
      cell: (row) => (
        <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-xs text-[var(--primary)]">{row.docType}</span>
      ),
    },
    { key: 'sourceOrgNodeName', header: '出库/发起', cell: (row) => row.sourceOrgNodeName ?? '—' },
    { key: 'targetOrgNodeName', header: '入库/接收', cell: (row) => row.targetOrgNodeName ?? '—' },
    { key: 'docDate', header: '日期', cell: (row) => row.docDate.slice(0, 10) },
    { key: 'totalQuantity', header: '数量', cell: (row) => <span className="font-medium">{row.totalQuantity}</span> },
    /*
     * 列头只看会话级价格权限，**不从当前页数据反推**：行级遮蔽后 totalAmount 会变成
     * undefined，按"本页有没有金额"决定列头的话，混合绑定账号翻到全遮蔽的一页时整列消失、
     * 翻回有权限的页又出现，表头随页抖动，且无权限的行也不再按验收要求显示「—」。
     * 代价是有一批**业务卡片**（按卡片计 12 个：品项公司发货与两个撤回 Tab 共用的发货单、
     * 两张退货申请、两张退货回库、非凤御出库、三个层级的转换、门店报货）产出的单据
     * 本就不带金额，会多一列全是「—」。那要靠「docType → 有无金额语义」的单源来治
     * （engine 侧的 AMOUNTLESS_DOC_TYPES 只覆盖一种，是遮蔽语义不是无金额全集，见 PR follow-up）。
     */
    ...(priceVisible
      ? [{ key: 'totalAmount', header: '金额', cell: (row: InventoryDocRow) => row.totalAmount ?? '—' } as Column<InventoryDocRow>]
      : []),
    {
      key: 'status',
      header: '状态',
      cell: (row) => (
        <span className={row.status === '已完成' ? 'text-[#3D8A5A]' : row.status === '已驳回' ? 'text-[#888888]' : 'text-[#D4820A]'}>
          {inventoryDocStatusLabel(row)}
        </span>
      ),
    },
  ]

  /**
   * 一行上该出现哪些按钮：本业务配了哪些动作 × 这些动作各自的可操作状态 × 当前行状态。
   *
   * 状态判据读 `INVENTORY_INBOX_ACTION_STATUS`（与服务端 inbox.statuses 同文件、单测互钉），
   * 不在这里手写 `row.status === '待审批'` —— 映射表放宽了状态而按钮没跟上的话，
   * 按钮就会出现在点一次报一次错的行上。
   *
   * 匹配不到任何动作（已完成 / 已驳回 / 已取消）就返回 null，**不渲染空按钮位**。
   */
  function inboxRowActions(row: InventoryDocRow) {
    const kinds = inboxActions.filter((kind) => INVENTORY_INBOX_ACTION_STATUS[kind] === row.status)
    if (kinds.length === 0) return null
    return (
      <div className="flex flex-wrap gap-1">
        {kinds.map((kind) => (
          <Button
            key={kind}
            variant="ghost"
            size="sm"
            /*
             * 可访问名带单据号（#194 的「<字段名> <行标识>」口径）：一页十几行按钮
             * 全叫「通过」，读屏分不清，Playwright 也只能 strict mode violation。
             */
            aria-label={`${INBOX_ACTION_LABEL[kind]} ${row.id}`}
            onClick={() => {
              /*
               * 点击闸而不是 disabled：点下去就变 disabled 会让 `showModal()` 记不到
               * 「打开前的焦点」，关闭弹窗后焦点回不到这个按钮上（#134 的结论）。
               * 在途时点另一行也走这条 —— 直接不响应，不开第二个弹窗。
               */
              if (pendingInboxAction || actionBusy) return
              // 跳转类动作没有 Server Action，只切 Tab + 预选单据，不进弹窗。
              if (isInboxGotoAction(kind)) {
                onGotoForm(row.id)
                return
              }
              setPendingInboxAction({ kind, docId: row.id })
            }}
          >
            {INBOX_ACTION_LABEL[kind]}
          </Button>
        ))}
      </div>
    )
  }

  const inboxColumns: Column<InventoryDocRow>[] = [
    ...columns,
    /*
     * 撤回原因是审批人唯一的判断依据，不该逼他点进详情页才看得到。
     * 只有撤回审批这张卡有（别的业务这一列全是空）。
     */
    ...(operation === 'shipment-cancel-approval'
      ? [{
          key: 'cancellationRequestReason',
          header: '撤回原因',
          cell: (row: InventoryDocRow) => row.cancellationRequestReason ?? '—',
        } as Column<InventoryDocRow>]
      : []),
    /*
     * 一个可用动作都没有（无权限 / 本业务没配动作）时整列都不渲染 ——
     * 留一列空白表头只是噪音。
     */
    ...(canAct && inboxActions.length > 0
      ? [{ key: 'inboxActions', header: '操作', cell: inboxRowActions } as Column<InventoryDocRow>]
      : []),
  ]

  /*
   * 空态收敛：`total === 0` 才算真空。
   * 不能用 `rows.length === 0` —— 办完最后一张单后停在第 3 页时 rows 也是空的，
   * 那时必须把表格连同 Pagination 一起渲染出来，靠它的越界自纠把人带回第 1 页。
   */
  const inboxEmpty = !loading && inboxTotal === 0 && inboxRows.length === 0
  const producedEmpty = !loading && total === 0 && rows.length === 0
  /*
   * 「只有一边空时，空的那一边不占一大块」：产出段只在**待办段有内容**时收成一行字。
   * 两边都空时产出段仍渲染整表，那句「暂无单据」是这个业务唯一的总结论。
   */
  const compactProduced = producedEmpty && hasInbox && !inboxEmpty
  const inboxEmptyText = inboxFailed ? '待办加载失败，请稍后重试' : '当前没有待处理单据'

  return (
    <div className="space-y-6">
      {/* 无 inbox 语义的业务（17 个内置 + 9 个通用）整段不渲染，外观与 #190 完全一致。 */}
      {hasInbox && (
        <section className="space-y-2" aria-label="待我处理">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">待我处理</h3>
            <Badge variant="outline">{inboxTotal}</Badge>
            <span className="text-xs text-[#888888]">上游已提交、等你审批或收货的单据</span>
          </div>
          {inboxEmpty ? (
            <p className="px-1 py-2 text-sm text-[#888888]">{inboxEmptyText}</p>
          ) : (
            <>
              <DataTable
                columns={inboxColumns}
                data={inboxRows}
                loading={loading}
                emptyText={inboxEmptyText}
              />
              {/* 待办段自己的页码，与产出段互不干扰（服务端也是两个独立的 page 入参）。 */}
              <Pagination
                total={inboxTotal}
                page={inboxPage}
                pageSize={inboxPageSize}
                onPageChange={setInboxPage}
              />
            </>
          )}
        </section>
      )}

      {/* space-y-3 与 #190 的原布局逐字一致：无 inbox 的 17 个业务外观不能有任何变化 */}
      <section className="space-y-3" aria-label="本业务产出">
        {/*
          * 产出段**不加任何行内动作**：产出单绝大多数是终态，少数非终态的处理入口在别的
          * 业务卡片上（purchase-order 产出的待收货采购订单由 supply-chain-receipt /
          * supply-chain-purchase-cancel 处理）。在这里再放一份等于多一处口径。
          */}
        {hasInbox && <h3 className="text-sm font-medium">本业务产出</h3>}
        {compactProduced ? (
          <p className="px-1 py-2 text-sm text-[#888888]">本业务暂无产出单据</p>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={rows}
              loading={loading}
              emptyText={failed ? '单据加载失败，请切换 Tab 或稍后重试' : '暂无单据'}
            />
            <Pagination total={total} page={page} pageSize={pageSize} onPageChange={setPage} />
          </>
        )}
      </section>

      {/*
        * **无条件渲染**，绝不能写成 `{canAct && <DocActionDialog/>}`：权限翻转时条件渲染会把
        * 正开着的弹窗整个卸载 —— 填的备注没了，而 pendingInboxAction 仍非空 → 开窗入口被
        * 点击闸永久锁死，只能整页重载（#134 评审 R9 抓到的真死锁）。
        */}
      <DocActionDialog
        config={inboxActionConfig}
        pending={pendingInboxAction}
        onBusyChange={handleActionBusyChange}
        onOpenChange={(next) => {
          if (!next) setPendingInboxAction(null)
        }}
        onDone={(finished) => {
          // 只关「当初发起的那一张」：期间若已切到别的单据，别把人家开着的弹窗连同
          // 刚敲进去的备注一起抹掉。在途切单已被点击闸从状态上禁掉，这是第二道防线。
          setPendingInboxAction((current) =>
            current && current.docId === finished.docId && current.kind === finished.kind
              ? null
              : current,
          )
          // 两件事都得做，只做后一件等于没刷新（见 reloadToken 的注释）：
          // reloadToken 重取本 Tab 的两段，router.refresh() 让表单 Tab 的
          // DocPicker 候选（RSC 的 workflowDocs）跟着变。
          setReloadToken((n) => n + 1)
          router.refresh()
        }}
      />
    </div>
  )
}

interface SimpleSkuLine {
  skuId: string
  quantity: string
  remark: string
}

function StoreRequestForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const stores = locations.filter((location) => location.locationType === '门店' && location.isActive)
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const [storeId, setStoreId] = useState('')
  const [marketId, setMarketId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<SimpleSkuLine[]>([{ skuId: '', quantity: '1', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<SimpleSkuLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  function selectStore(nextStoreId: string) {
    setStoreId(nextStoreId)
    const store = stores.find((location) => location.locationId === nextStoreId)
    const nextMarketId = store?.parentLocationId ?? ''
    // 候选按门店所属市场过滤（市场自采商品只能在归属市场报货），换了市场，已选商品就可能不再合法
    if (nextMarketId !== marketId) setLines((previous) => previous.map((line) => ({ ...line, skuId: '' })))
    setMarketId(nextMarketId)
  }

  async function submit() {
    if (saving) return
    if (!storeId || !marketId) {
      toast.error('请选择报货门店和市场')
      return
    }
    const items = lines.map((line) => ({
      skuId: line.skuId,
      quantity: positiveNumber(line.quantity),
      remark: optionalText(line.remark),
    }))
    if (items.some((item) => !item.skuId || item.quantity === null)) {
      toast.error('请完整填写商品和报货数量')
      return
    }
    setSaving(true)
    try {
      const result = await createStoreReplenishmentRequest({
        storeId,
        marketId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`门店报货单已创建：${result.id}`)
      setLines([{ skuId: '', quantity: '1', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建门店报货失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="报货门店" required>
          <InventorySubjectSelect
            options={stores.map((location) => ({ value: location.locationId, label: location.name }))}
            value={storeId}
            onChange={selectStore}
            placeholder="请选择门店"
          />
        </FormField>
        <FormField label="所属市场" required>
          {/* 值由「报货门店」联动派生（selectStore 写 parentLocationId），不能自己补 */}
          <InventorySubjectSelect
            options={markets.map((location) => ({ value: location.locationId, label: location.name }))}
            value={marketId}
            onChange={(nextMarketId) => {
              // 与 selectStore 同理：候选按市场过滤，换市场后已选商品可能不再合法
              if (nextMarketId !== marketId) setLines((previous) => previous.map((line) => ({ ...line, skuId: '' })))
              setMarketId(nextMarketId)
            }}
            placeholder="请选择市场"
            autoSelect={false}
          />
        </FormField>
        <FormField label="报货日期">
          <DatePicker value={docDate} onValueChange={setDocDate} />
        </FormField>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">报货明细</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', quantity: '1', remark: '' }])}>
            添加明细
          </Button>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_2.5rem]">
            <FormField label="商品" required group>
              <SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId })} filters={{ reportable: true, availableToMarketId: marketId }} disabled={!marketId} disabledHint={storeId ? '所选门店未关联市场' : '请先选择报货门店'} />
            </FormField>
            <FormField label="数量" required>
              <Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} />
            </FormField>
            <FormField label="明细备注">
              <Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} />
            </FormField>
            <div className="flex items-end justify-end">
              <SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} />
            </div>
          </div>
        ))}
      </div>

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>创建门店报货单</Button>
      </div>
    </form>
  )
}

function ItemCompanyReplenishmentForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<SimpleSkuLine[]>([{ skuId: '', quantity: '1', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<SimpleSkuLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!supplyChainLocationId) {
      toast.error('请选择供应链库存主体')
      return
    }
    const items = lines.map((line) => ({
      skuId: line.skuId,
      quantity: positiveNumber(line.quantity),
      remark: optionalText(line.remark),
    }))
    if (items.some((item) => !item.skuId || item.quantity === null)) {
      toast.error('请完整填写供应链商品和报货数量')
      return
    }
    setSaving(true)
    try {
      const result = await createItemCompanyReplenishment({
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`品项公司报货需求已创建：${result.id}`)
      setLines([{ skuId: '', quantity: '1', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建品项公司报货需求失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="供应链库存主体" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={supplyChainLocationId}
            onChange={setSupplyChainLocationId}
            placeholder="请选择总部"
          />
        </FormField>
        <FormField label="报货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">报货明细</h3>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', quantity: '1', remark: '' }])}>添加明细</Button>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_2.5rem]">
            <FormField label="供应链商品" required group><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId })} filters={{ sourceType: '供应链', reportable: true }} /></FormField>
            <FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
            <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
            <div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div>
          </div>
        ))}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建品项公司报货需求</Button></div>
    </form>
  )
}

interface MarketReportLine {
  skuId: string
  skuName: string
  specName: string | null
  requestItemIds: number[]
  requestQuantity: number
  availableQuantity: number
  suggestedPurchaseQuantity: number
  selected: boolean
  purchaseQuantity: string
}

function MarketReportForm({
  locations,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [marketId, setMarketId] = useState('')
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<MarketReportLine[]>([])
  const [quoteResult, setQuoteResult] = useState<MarketPromotionQuoteResult | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [quoting, setQuoting] = useState(false)
  const [saving, setSaving] = useState(false)
  const quoteRequestRef = useRef(0)

  const quoteItems = useMemo(() => lines
    .filter((line) => line.selected)
    .map((line) => ({ skuId: line.skuId, quantity: positiveNumber(line.purchaseQuantity) }))
    .filter((line): line is { skuId: string; quantity: number } => line.quantity !== null), [lines])
  const quoteBasketKey = useMemo(() => JSON.stringify({ marketId, docDate, items: quoteItems }), [docDate, marketId, quoteItems])

  function updateLine(index: number, patch: Partial<MarketReportLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  useEffect(() => {
    const requestId = ++quoteRequestRef.current
    setQuoteResult(null)
    if (!canViewPrice || !marketId || quoteItems.length === 0) {
      setQuoting(false)
      return
    }
    setQuoting(true)
    const timer = setTimeout(() => {
      void quoteMarketReplenishmentPrices({ marketId, docDate: optionalText(docDate), items: quoteItems })
        .then((result) => {
          if (quoteRequestRef.current === requestId) setQuoteResult(result)
        })
        .catch((error) => {
          if (quoteRequestRef.current === requestId) {
            toast.error(actionErrorMessage(error, '获取福利报价失败'))
          }
        })
        .finally(() => {
          if (quoteRequestRef.current === requestId) setQuoting(false)
        })
    }, 300)
    return () => clearTimeout(timer)
  }, [canViewPrice, docDate, marketId, quoteBasketKey, quoteItems])

  async function loadSummary() {
    if (!marketId) {
      toast.error('请选择市场')
      return
    }
    setLoadingSummary(true)
    try {
      const summary = await summarizeStoreReplenishmentRequests({
        marketId,
        startDate: optionalText(startDate),
        endDate: optionalText(endDate),
      })
      setLines(summary.items.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        requestItemIds: item.requestItemIds,
        requestQuantity: item.outstandingQuantity,
        availableQuantity: item.availableQuantity,
        suggestedPurchaseQuantity: item.suggestedPurchaseQuantity,
        // 库存已覆盖的行默认不建市场报货；需要补货时由操作人显式勾选并填写数量。
        selected: item.suggestedPurchaseQuantity > 0,
        purchaseQuantity: item.suggestedPurchaseQuantity > 0 ? String(item.suggestedPurchaseQuantity) : '',
      })))
      if (summary.items.length === 0) toast.info('当前没有待汇总的门店报货明细')
    } catch (error) {
      toast.error(actionErrorMessage(error, '汇总门店报货失败'))
    } finally {
      setLoadingSummary(false)
    }
  }

  async function selectPromotion(skuId: string, promotionPlanId: string) {
    if (!quoteResult) return
    const currentLine = quoteResult.items.find((item) => item.skuId === skuId)
    const selectedOption = currentLine?.eligibleOptions.find((option) => option.promotionPlanId === currentLine.promotionPlanId)
    const nextOption = currentLine?.eligibleOptions.find((option) => option.promotionPlanId === promotionPlanId)
    if (!currentLine || !nextOption) return
    const selections = new Map(
      quoteResult.items
        .filter((item) => item.promotionPlanId)
        .map((item) => [item.skuId, item.promotionPlanId!]),
    )
    if (selectedOption?.promotionRuleType === '组合' && selectedOption.promotionPlanId !== promotionPlanId) {
      for (const componentSkuId of selectedOption.componentSkuIds) {
        selections.delete(componentSkuId)
        const coveredByNextCombo = nextOption.promotionRuleType === '组合'
          && nextOption.componentSkuIds.includes(componentSkuId)
        const replacedByNextSingle = nextOption.promotionRuleType === '单品阶梯'
          && componentSkuId === skuId
        if (coveredByNextCombo || replacedByNextSingle) continue
        const component = quoteResult.items.find((item) => item.skuId === componentSkuId)
        const fallback = component?.eligibleOptions.find((option) => (
          option.promotionRuleType === '单品阶梯' && option.promotionPlanId !== selectedOption.promotionPlanId
        ))
        if (!fallback) {
          toast.error('该组合福利没有完整的单品替代方案，请改选另一套组合福利')
          return
        }
        selections.set(componentSkuId, fallback.promotionPlanId)
      }
    }
    if (nextOption.promotionRuleType === '组合') {
      for (const componentSkuId of nextOption.componentSkuIds) {
        selections.set(componentSkuId, nextOption.promotionPlanId)
      }
    } else {
      selections.set(skuId, nextOption.promotionPlanId)
    }
    const requestId = ++quoteRequestRef.current
    setQuoting(true)
    try {
      const result = await quoteMarketReplenishmentPrices({
        marketId,
        docDate: optionalText(docDate),
        items: quoteItems,
        selections: Array.from(selections, ([selectedSkuId, selectedPlanId]) => ({
          skuId: selectedSkuId,
          promotionPlanId: selectedPlanId,
        })),
      })
      if (quoteRequestRef.current === requestId) setQuoteResult(result)
    } catch (error) {
      toast.error(actionErrorMessage(error, '获取福利报价失败'))
    } finally {
      if (quoteRequestRef.current === requestId) setQuoting(false)
    }
  }

  async function submit() {
    if (saving) return
    if (!marketId || !supplyChainLocationId) {
      toast.error('请选择市场和供应链库存主体')
      return
    }
    const items = lines.filter((line) => line.selected).map((line) => ({
      skuId: line.skuId,
      sourceRequestItemIds: line.requestItemIds,
      purchaseQuantity: positiveNumber(line.purchaseQuantity),
    }))
    if (items.length === 0 || items.some((item) => item.purchaseQuantity === null)) {
      toast.error('请选择至少一条明细并填写实际采购数量')
      return
    }
    if (canViewPrice && (!quoteResult || quoting)) {
      toast.error('福利报价尚未完成，请稍候')
      return
    }
    setSaving(true)
    try {
      const result = await createMarketReplenishment({
        marketId,
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, purchaseQuantity: item.purchaseQuantity! })),
        promotionSelections: canViewPrice
          ? quoteResult!.items
              .filter((item) => item.promotionPlanId)
              .map((item) => ({ skuId: item.skuId, promotionPlanId: item.promotionPlanId! }))
          : undefined,
      })
      onSuccess(`市场报货单已创建：${result.id}`)
      setLines([])
      setQuoteResult(null)
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建市场报货失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <FormField label="市场" required>
          <InventorySubjectSelect
            options={markets.map((location) => ({ value: location.locationId, label: location.name }))}
            value={marketId}
            onChange={(nextMarketId) => { setMarketId(nextMarketId); setLines([]); setQuoteResult(null) }}
            placeholder="请选择市场"
          />
        </FormField>
        <FormField label="供应链库存主体" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={supplyChainLocationId}
            onChange={setSupplyChainLocationId}
            placeholder="请选择总部"
          />
        </FormField>
        <FormField label="汇总开始日期">
          <DatePicker value={startDate} onValueChange={setStartDate} />
        </FormField>
        <FormField label="汇总结束日期">
          <DatePicker value={endDate} onValueChange={setEndDate} />
        </FormField>
        <div className="flex items-end">
          <Button type="button" variant="outline" loading={loadingSummary} onClick={loadSummary} className="w-full">汇总门店报货</Button>
        </div>
      </div>
      <FormField label="报货日期" className="max-w-xs">
        <DatePicker value={docDate} onValueChange={setDocDate} />
      </FormField>

      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">市场报货明细</h3>
          <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
                <tr>
                  <th className="w-12 px-3 py-2 font-medium">选择</th>
                  <th className="px-3 py-2 font-medium">商品</th>
                  <th className="px-3 py-2 font-medium">待配数量</th>
                  <th className="px-3 py-2 font-medium">市场可用库存</th>
                  <th className="px-3 py-2 font-medium">建议采购</th>
                  <th className="px-3 py-2 font-medium">实际采购</th>
                  {canViewPrice && <th className="px-3 py-2 font-medium">福利报价</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const currentQuote = quoteResult?.items.find((item) => item.skuId === line.skuId)
                  /*
                   * 行内控件的可访问名（#194）。行内控件没有 <label> 可包裹（字段名只在 <th> 上），
                   * 读屏只会念「复选框」/「编辑框」，Playwright 也只能按行结构猜位置。
                   *
                   * ⚠️ 只带 skuName **不够**：skuName 落库时取的是 `sku.productName`（纯商品名，不含规格），
                   * 本表又把规格当独立副标题渲染 —— 同一商品的两个规格同时成行时，可访问名会完全重复，
                   * 读屏分不清，Playwright 报 strict mode violation 或静默填错行。
                   * `specName || skuId` 与下面「商品」列副标题是同一个表达式：既和屏幕上看到的一致，
                   * 规格缺省时又退回天然唯一的 skuId（本表按 sku 聚合，一行 = 一个 skuId）。
                   *
                   * aria-label 必须写在数值输入的 type 属性**之前**，
                   * 否则源码守护测试抓属性串时会被模板串里的 `>` 截断（见本组件的单测）。
                   */
                  const rowName = `${line.skuName} ${line.specName || line.skuId}`
                  return (
                    <tr key={line.skuId} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2"><input aria-label={`选择 ${rowName}`} type="checkbox" checked={line.selected} onChange={(event) => updateLine(index, { selected: event.target.checked })} /></td>
                      <td className="px-3 py-2"><div className="font-medium">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || line.skuId}</div></td>
                      <td className="px-3 py-2">{line.requestQuantity}</td>
                      <td className="px-3 py-2">{line.availableQuantity}</td>
                      <td className="px-3 py-2">{line.suggestedPurchaseQuantity}</td>
                      <td className="px-3 py-2"><Input className="w-24" aria-label={`实际采购 ${rowName}`} type="number" min="0" step="0.01" max="9999999999.99" value={line.purchaseQuantity} onChange={(event) => updateLine(index, { purchaseQuantity: event.target.value })} disabled={!line.selected} /></td>
                      {canViewPrice && (
                        <td className="px-3 py-2">
                          {!line.selected ? (
                            <span className="text-xs text-[#888888]">未参与本次报货</span>
                          ) : quoting && !currentQuote ? (
                            <span className="text-xs text-[#666666]">正在自动报价…</span>
                          ) : currentQuote ? (
                            <div className="min-w-64 space-y-1.5">
                              {currentQuote.eligibleOptions.length > 1
                                || (!currentQuote.promotionPlanId && currentQuote.eligibleOptions.length > 0) ? (
                                // 同一行的第三个控件，可访问名口径与上面两个对齐：`<字段名> <行标识>`。
                                // 原先只带商品名（「<商品名>福利方案」），同商品多规格成行时照样重名。
                                <Select
                                  value={currentQuote.promotionPlanId ?? ''}
                                  onChange={(event) => void selectPromotion(line.skuId, event.target.value)}
                                  disabled={quoting}
                                  aria-label={`福利方案 ${rowName}`}
                                >
                                  {!currentQuote.promotionPlanId && (
                                    <option value="" disabled>请选择福利方案</option>
                                  )}
                                  {currentQuote.eligibleOptions.map((option) => (
                                    <option key={option.promotionPlanId} value={option.promotionPlanId}>
                                      {option.promotionPlanNo} · {option.promotionName}{option.promotionRuleType === '组合' ? '（组合）' : ''}
                                    </option>
                                  ))}
                                </Select>
                              ) : currentQuote.promotionPlanNo ? (
                                <div className="text-xs font-medium text-[#7B5E2B]">
                                  {currentQuote.promotionPlanNo} · {currentQuote.promotionName}
                                </div>
                              ) : (
                                <div className="text-xs text-[#888888]">无匹配福利，按标准价</div>
                              )}
                              <div className="text-xs text-[#666666]">
                                {currentQuote.marketStandardUnitPrice} - {currentQuote.marketUnitDiscount} = {currentQuote.marketActualUnitPrice}
                                {currentQuote.selectionMode === '人工选择' ? ' · 已改选' : currentQuote.promotionPlanId ? ' · 系统推荐' : ''}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-[#D94040]">报价失败，请调整后重试</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {canViewPrice && quoteResult && (
            <div className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[#E8D8B8] bg-[#FFFDF8] p-3 text-sm sm:grid-cols-3">
              <div><span className="text-[#888888]">标准金额</span><div className="mt-1 font-medium">{quoteResult.totalStandardAmount.toFixed(2)}</div></div>
              <div><span className="text-[#888888]">福利优惠</span><div className="mt-1 font-medium text-[#C0322A]">-{quoteResult.totalDiscountAmount.toFixed(2)}</div></div>
              <div><span className="text-[#888888]">应付金额</span><div className="mt-1 font-medium text-[#3D8A5A]">{quoteResult.totalActualAmount.toFixed(2)}</div></div>
            </div>
          )}
        </div>
      )}

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={lines.length === 0}>创建市场报货单</Button>
      </div>
    </form>
  )
}

interface DocumentQuantityLine {
  sourceItemId: number
  skuName: string
  specName: string | null
  quantity: string
}

interface MarketReportSummaryDraftLine {
  skuId: string
  skuName: string
  specName: string | null
  marketId: string
  marketName: string
  outstandingQuantity: number
  supplierId: string | null
  supplierName: string | null
  selected: boolean
  quantity: string
}

/**
 * 市场报货汇总表单（#193）：供应链侧跨市场汇总各市场的报货需求，落成一张汇总单。
 *
 * 明细按「商品 × 市场」成行 —— 行上不留市场，下游采购订单就没法按市场发货，
 * 也没法把履约回写到正确的市场报货明细。
 */
function MarketReportSummaryForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  // 主体的「唯一候选自动选中」交给 InventorySubjectSelect（#189），这里不再自己补值
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([])
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<MarketReportSummaryDraftLine[]>([])
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sourceItemIdsByLine, setSourceItemIdsByLine] = useState<Map<string, number[]>>(new Map())

  function lineKey(line: { skuId: string; marketId: string }) {
    return `${line.skuId}@${line.marketId}`
  }

  const marketOptions = locations.filter(
    (location) => location.locationType === '市场' && location.isActive && location.orgNodeId,
  )

  async function loadSummary() {
    if (!supplyChainLocationId) {
      toast.error('请选择供应链库存主体')
      return
    }
    setLoadingSummary(true)
    try {
      const summary = await summarizeMarketReplenishmentRequests({
        supplyChainLocationId,
        startDate: optionalText(startDate),
        endDate: optionalText(endDate),
        // 不勾 = 全部市场（服务端把空数组与 null 同等对待）
        marketIds: selectedMarketIds.length > 0 ? selectedMarketIds : null,
      })
      const nextSourceIds = new Map<string, number[]>()
      setLines(summary.items.map((item) => {
        nextSourceIds.set(`${item.skuId}@${item.marketId}`, item.requestItemIds)
        return {
          skuId: item.skuId,
          skuName: item.skuName,
          specName: item.specName,
          marketId: item.marketId,
          marketName: item.marketName,
          outstandingQuantity: item.outstandingQuantity,
          supplierId: item.supplierId,
          supplierName: item.supplierName,
          selected: true,
          quantity: String(item.outstandingQuantity),
        }
      }))
      setSourceItemIdsByLine(nextSourceIds)
      if (summary.items.length === 0) toast.info('当前没有待汇总的市场报货明细')
    } catch (error) {
      toast.error(actionErrorMessage(error, '汇总市场报货失败'))
    } finally {
      setLoadingSummary(false)
    }
  }

  function updateLine(key: string, patch: Partial<MarketReportSummaryDraftLine>) {
    setLines((previous) => previous.map((line) => (
      lineKey(line) === key ? { ...line, ...patch } : line
    )))
  }

  async function submit() {
    if (saving) return
    if (!supplyChainLocationId) {
      toast.error('请选择供应链库存主体')
      return
    }
    const items: Array<{ skuId: string; marketId: string; quantity: number; sourceReportItemIds: number[] }> = []
    for (const line of lines) {
      if (!line.selected) continue
      const quantity = positiveNumber(line.quantity)
      if (quantity === null) continue
      items.push({
        skuId: line.skuId,
        marketId: line.marketId,
        quantity,
        sourceReportItemIds: sourceItemIdsByLine.get(lineKey(line)) ?? [],
      })
    }
    if (items.length === 0) {
      toast.error('请至少勾选一条并填写汇总数量')
      return
    }
    setSaving(true)
    try {
      const result = await createMarketReportSummary({
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items,
      })
      onSuccess(`市场报货汇总单已创建：${result.id}`)
      setLines([])
      setSourceItemIdsByLine(new Map())
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建市场报货汇总失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <FormField label="供应链库存主体" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={supplyChainLocationId}
            onChange={setSupplyChainLocationId}
            placeholder="请选择总部"
          />
        </FormField>
        <FormField label="报货起始日期"><DatePicker value={startDate} onValueChange={setStartDate} /></FormField>
        <FormField label="报货截止日期"><DatePicker value={endDate} onValueChange={setEndDate} /></FormField>
        <FormField label="汇总单日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>

      {marketOptions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">市场范围</h3>
          <p className="text-xs text-[#666666]">不勾选则汇总全部市场。</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] p-3">
            {marketOptions.map((market) => (
              <label key={market.orgNodeId!} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedMarketIds.includes(market.orgNodeId!)}
                  onChange={(event) => setSelectedMarketIds((previous) => (
                    event.target.checked
                      ? [...previous, market.orgNodeId!]
                      : previous.filter((id) => id !== market.orgNodeId)
                  ))}
                />
                {market.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-start">
        <Button type="button" variant="secondary" loading={loadingSummary} onClick={() => void loadSummary()}>
          汇总各市场报货
        </Button>
      </div>

      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
              <tr>
                <th className="px-3 py-2 font-medium">汇总</th>
                <th className="px-3 py-2 font-medium">商品</th>
                <th className="px-3 py-2 font-medium">市场</th>
                <th className="px-3 py-2 font-medium">供应商</th>
                <th className="px-3 py-2 text-right font-medium">未汇总数量</th>
                <th className="px-3 py-2 text-right font-medium">本次汇总</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const key = lineKey(line)
                /*
                 * 行内控件的可访问名（#194）。行内控件没有 <label> 可包裹（字段名只在 <th> 上）。
                 * 本表按「商品 × 市场」成行（行唯一键 = skuId + marketId），所以两个维度都得带。
                 *
                 * ⚠️ 规格也得带：skuName 是纯商品名（落库取 `sku.productName`），本表又把规格
                 * 当独立副标题渲染 —— 同一商品的两个规格同时报给同一个市场时，
                 * 只有「商品名 + 市场名」的可访问名完全重复，读屏分不清，
                 * Playwright 要么 strict mode violation 要么静默填错行。
                 * 规格缺省时退回 skuId（本表行唯一键含 skuId，天然唯一）。
                 */
                const rowName = `${line.skuName} ${line.specName || line.skuId} ${line.marketName}`
                return (
                  <tr key={key} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <input
                        aria-label={`汇总 ${rowName}`}
                        type="checkbox"
                        checked={line.selected}
                        onChange={(event) => updateLine(key, { selected: event.target.checked })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div>{line.skuName}</div>
                      {line.specName && <div className="text-xs text-[#888888]">{line.specName}</div>}
                    </td>
                    <td className="px-3 py-2">{line.marketName}</td>
                    <td className={`px-3 py-2 ${line.supplierId ? '' : 'text-[#D94040]'}`}>
                      {line.supplierName ?? '未绑定'}
                    </td>
                    <td className="px-3 py-2 text-right">{line.outstandingQuantity}</td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        aria-label={`本次汇总 ${rowName}`}
                        type="number"
                        min="0"
                        step="0.01"
                        max="9999999999.99"
                        value={line.quantity}
                        disabled={!line.selected}
                        onChange={(event) => updateLine(key, { quantity: event.target.value })}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={lines.length === 0}>创建市场报货汇总单</Button>
      </div>
    </form>
  )
}

interface PurchaseSourceLine {
  sourceItemId: number
  docId: string
  docType: string
  skuId: string
  skuName: string
  specName: string | null
  marketId: string | null
  /** 来源明细行上的供应商快照；仅采购订单与市场报货汇总会写，展示用。 */
  supplier: string | null
  supplierId: string | null
  /** 供应链采购价：采购订单行金额的价基（#335），与服务端 requiredSupplyChainCost 同源。 */
  supplyChainUnitCost: number | null
  availableQuantity: number
  quantity: string
}

/**
 * 合并后的采购订单表单（#194）。
 *
 * 取代原先的「创建采购订单」+「供应链采购订单」两张几乎一样的表单：一次勾选多张报货单
 * （市场报货汇总 / 品项公司报货需求），把商品按 SKU × 市场汇总成采购明细。
 * 供应商跟着商品走，界面不再让人选；缺供应商档案的商品会被挡下并标红提示。
 */
function PurchaseOrderForm({
  locations,
  workflowDocs,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])
  const [lines, setLines] = useState<PurchaseSourceLine[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const marketNameByOrgNodeId = useMemo(
    () => new Map(locations.filter((location) => location.orgNodeId).map((location) => [location.orgNodeId as string, location.name])),
    [locations],
  )

  // 供应商的真相源是**商品档案**，与服务端 `loadSku().supplierId` 同一口径。
  // 两次踩坑记在这里：
  //   ① 早先读来源明细行的 `supplier_id`，但只有采购订单与市场报货汇总会写那一列，
  //      品项公司报货需求的明细从不写 → 供应链采购每行都判「未绑定」，提交被永久禁用；
  //   ② 接着改用办理台的 `skuOptions`，可它只是列表页第一页（最多 100 条），
  //      排在后面的合法 SKU 同样被误判。
  // 所以按**选中的 SKU 精确批量查**，并且和建单时一样连「档案是否仍启用」一起看。
  const [skuSupplierStatus, setSkuSupplierStatus] = useState<
    Map<string, { supplierId: string | null; supplierName: string | null }>
  >(new Map())

  const candidates = useMemo(
    () => [
      ...docCandidates(workflowDocs, '市场报货汇总'),
      ...docCandidates(workflowDocs, '品项公司报货需求'),
    ],
    [workflowDocs],
  )

  // 勾选集合一变就整体重拉：增量维护行状态会漏掉期间被别人下单或取消掉的明细。
  useEffect(() => {
    let cancelled = false
    if (selectedDocIds.length === 0) {
      setLines([])
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const details = await Promise.all(selectedDocIds.map((id) => getInventoryCoreDocById(id)))
        if (cancelled) return
        const next: PurchaseSourceLine[] = []
        for (const detail of details) {
          if (!detail) continue
          for (const item of detail.items) {
            if (!hasAvailableQuantity(item)) continue
            const available = remainingQuantity(item)
            next.push({
              sourceItemId: item.id,
              docId: detail.id,
              docType: detail.docType,
              skuId: item.skuId,
              skuName: item.skuName,
              specName: item.specName,
              marketId: item.marketId,
              supplier: item.supplier,
              supplierId: item.supplierId,
              // 汇总行的 actualUnitPrice 是市场结算价，采购订单按供应链采购价计（#335）
              supplyChainUnitCost: item.supplyChainUnitCost ?? null,
              availableQuantity: available,
              quantity: String(available),
            })
          }
        }
        // 按本批明细涉及的 SKU 精确查供应商档案状态（不用分页列表）
        const status = await resolveInventorySkuSupplierStatus(
          Array.from(new Set(next.map((line) => line.skuId))),
        )
        if (cancelled) return
        setSkuSupplierStatus(new Map(status.map((row) => [row.skuId, row])))
        setLines(next)
        // 来源单的 target 就是供应链主体，默认带出来省一次选择（候选唯一时尤其明显）。
        setSupplyChainLocationId((current) => current
          || (details.find((detail) => detail?.targetOrgNodeId)?.targetOrgNodeId ?? ''))
      } catch (error) {
        if (!cancelled) toast.error(actionErrorMessage(error, '加载报货单明细失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedDocIds])

  const groups = useMemo(() => {
    const map = new Map<string, {
      key: string
      skuName: string
      specName: string | null
      marketId: string | null
      supplier: string | null
      missingSupplier: boolean
      lines: PurchaseSourceLine[]
    }>()
    for (const line of lines) {
      const key = `${line.skuId}@${line.marketId ?? ''}`
      const status = skuSupplierStatus.get(line.skuId)
      const group = map.get(key) ?? {
        key,
        skuName: line.skuName,
        specName: line.specName,
        marketId: line.marketId,
        supplier: status?.supplierName ?? line.supplier,
        missingSupplier: !status?.supplierId,
        lines: [],
      }
      group.lines.push(line)
      map.set(key, group)
    }
    return Array.from(map.values())
  }, [lines, skuSupplierStatus])

  const missingSupplierNames = useMemo(
    () => Array.from(new Set(
      lines.filter((line) => !skuSupplierStatus.get(line.skuId)?.supplierId).map((line) => line.skuName),
    )),
    [lines, skuSupplierStatus],
  )

  function updateLine(sourceItemId: number, quantity: string) {
    setLines((previous) => previous.map((line) => (
      line.sourceItemId === sourceItemId ? { ...line, quantity } : line
    )))
  }

  function toggleDoc(id: string, checked: boolean) {
    setSelectedDocIds((previous) => (
      checked ? [...previous, id] : previous.filter((docId) => docId !== id)
    ))
  }

  async function submit() {
    if (saving) return
    if (!supplyChainLocationId) {
      toast.error('请选择供应链库存主体')
      return
    }
    // 服务端同样 fail-closed，这里先挡一道是为了让操作人一次看全要补哪些商品。
    if (missingSupplierNames.length > 0) {
      toast.error(`以下商品未绑定供应商档案，请先在商品资料补全：${missingSupplierNames.join('、')}`)
      return
    }
    const items: Array<{ sourceItemId: number; quantity: number }> = []
    for (const line of lines) {
      const quantity = positiveNumber(line.quantity)
      if (quantity === null) continue
      items.push({ sourceItemId: line.sourceItemId, quantity })
    }
    if (items.length === 0) {
      toast.error('请填写至少一条采购数量')
      return
    }
    setSaving(true)
    try {
      const result = await createPurchaseOrder({
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items,
      })
      onSuccess(`采购订单已创建：${result.id}`)
      setSelectedDocIds([])
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建采购订单失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <FormField label="供应链库存主体" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={supplyChainLocationId}
            onChange={setSupplyChainLocationId}
            placeholder="请选择总部"
            /* #189：候选唯一时自动选中。合并后的表单没有单选的来源单，
               「尚未勾选任何来源」对应它原先的 `!doc` —— 勾了之后主体交还来源单决定。 */
            autoSelect={selectedDocIds.length === 0}
          />
        </FormField>
        <FormField label="订单日期">
          <DatePicker value={docDate} onValueChange={setDocDate} />
        </FormField>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">来源报货单<span className="ml-1 text-[#D94040]">*</span></h3>
        <p className="text-xs text-[#666666]">可同时勾选多张市场报货汇总单与品项公司报货需求单，商品会按「商品 × 市场」合并成采购明细。</p>
        {candidates.length === 0
          ? <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[#888888]">暂无可采购的报货单</div>
          : (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] p-2">
              {candidates.map((doc) => (
                <label key={doc.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={selectedDocIds.includes(doc.id)}
                    onChange={(event) => toggleDoc(doc.id, event.target.checked)}
                  />
                  <span className="text-xs text-[#888888]">{doc.docType}</span>
                  <span>{formatDoc(doc)}</span>
                </label>
              ))}
            </div>
          )}
      </div>

      {loading && <div className="text-sm text-[#666666]">正在加载报货明细</div>}

      {missingSupplierNames.length > 0 && (
        <div className="rounded-[var(--radius)] border border-[#D94040] bg-[#FFF0F0] p-3 text-sm text-[#D94040]">
          以下商品未绑定供应商档案，补全后才能下单：{missingSupplierNames.join('、')}
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">采购明细</h3>
          {groups.map((group) => (
            <div key={group.key} className={`space-y-2 rounded-[var(--radius)] border p-3 ${group.missingSupplier ? 'border-[#D94040]' : 'border-[var(--border)]'}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{group.skuName}</span>
                {group.specName && <span className="text-xs text-[#888888]">{group.specName}</span>}
                <span className="text-xs text-[#5E8BB3]">
                  {group.marketId ? (marketNameByOrgNodeId.get(group.marketId) ?? group.marketId) : '品项公司自用'}
                </span>
                <span className={`text-xs ${group.missingSupplier ? 'text-[#D94040]' : 'text-[#666666]'}`}>
                  供应商：{group.supplier ?? '未绑定'}
                </span>
              </div>
              {group.lines.map((line) => (
                <div key={line.sourceItemId} className="grid grid-cols-1 gap-2 border-t border-[var(--border)] pt-2 md:grid-cols-[minmax(0,1fr)_8rem_10rem]">
                  <div className="text-xs text-[#888888]">
                    来源 {line.docId}（可采购 {line.availableQuantity}）
                  </div>
                  {canViewPrice && (
                    <div className="text-xs text-[#888888]">
                      供应链采购价 {line.supplyChainUnitCost ?? '—'}
                    </div>
                  )}
                  <FormField label="采购数量">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      max="9999999999.99"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.sourceItemId, event.target.value)}
                    />
                  </FormField>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={lines.length === 0 || missingSupplierNames.length > 0}>
          创建采购订单
        </Button>
      </div>
    </form>
  )
}


interface ShipmentDraftLine {
  purchaseOrderItemId: number
  skuId: string
  skuName: string
  specName: string | null
  lotId: string
  remainingQuantity: number
  quantity: string
  giftQuantity: string
  remark: string
}

function CompanyShipmentForm({
  locations,
  workflowDocs,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  workflowDocs: InventoryDocRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [sourceOrgNodeId, setSourceOrgNodeId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [logisticsCompany, setLogisticsCompany] = useState('')
  const [trackingNo, setTrackingNo] = useState('')
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<ShipmentDraftLine[]>([])
  const [shipMarketId, setShipMarketId] = useState('')
  const [saving, setSaving] = useState(false)

  // 合并后一张采购单可含多个市场的行，外加无市场归属的品项公司自用行（#194）。
  // 发货单单头只能有一个市场，自用行更是压根不走发货 —— 装载全部明细会让用户一提交
  // 就撞上服务端的「只能发往同一个市场」/「该明细没有市场归属」。这里先按市场收窄。
  const shipMarkets = useMemo(() => {
    if (!doc) return [] as Array<{ id: string; name: string }>
    const seen = new Map<string, string>()
    for (const item of doc.items) {
      if (!item.marketId || seen.has(item.marketId)) continue
      seen.set(item.marketId, item.marketName ?? item.marketId)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [doc])

  useEffect(() => {
    setShipMarketId((current) => (
      shipMarkets.some((market) => market.id === current) ? current : (shipMarkets[0]?.id ?? '')
    ))
  }, [shipMarkets])

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSourceOrgNodeId(doc.targetOrgNodeId ?? '')
    // 采购行的 fulfilledQuantity 记的是已入库量（#335），剩余可发量要看发货血缘：
    // 过渡期发货仍以采购行数量封顶（由 #336 改为引用市场报货单），与服务端
    // `createItemCompanyShipment` 的 `orderItem.quantity - shipped` 同口径。
    // 拿不到发货进度时 fail-closed（剩余可发记 0），不退化成全量可发。
    const shippedByItem = new Map(
      doc.fulfillmentProgress?.kind === '供应链采购收货'
        ? doc.fulfillmentProgress.items.map((progress) => [progress.itemId, progress.shippedQuantity])
        : [],
    )
    setLines(doc.items.filter((item) => item.marketId && item.marketId === shipMarketId).map((item) => {
      const shipped = shippedByItem.get(item.id)
      const remaining = shipped === undefined ? 0 : Math.max(0, item.quantity - shipped)
      return {
        purchaseOrderItemId: item.id,
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        lotId: '',
        remainingQuantity: remaining,
        quantity: String(remaining),
        giftQuantity: '0',
        remark: '',
      }
    }))
  }, [doc, shipMarketId])

  function updateLine(index: number, patch: Partial<ShipmentDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !sourceOrgNodeId) {
      toast.error('请选择采购订单和发货总部')
      return
    }
    const parsed = lines.map((line) => ({
      purchaseOrderItemId: line.purchaseOrderItemId,
      lotId: Number(line.lotId),
      quantity: nonnegativeNumber(line.quantity),
      giftQuantity: nonnegativeNumber(line.giftQuantity),
      remark: optionalText(line.remark),
    })).filter((line) => (line.quantity ?? 0) + (line.giftQuantity ?? 0) > 0)
    if (parsed.length === 0 || parsed.some((line) => !Number.isInteger(line.lotId) || line.lotId <= 0 || line.quantity === null || line.giftQuantity === null)) {
      toast.error('请为每条发货明细选择批次并填写数量')
      return
    }
    setSaving(true)
    try {
      const result = await createItemCompanyShipment({
        purchaseOrderId: doc.id,
        sourceOrgNodeId,
        docDate: optionalText(docDate),
        logisticsCompany: optionalText(logisticsCompany),
        trackingNo: optionalText(trackingNo),
        remark: optionalText(remark),
        items: parsed.map((line) => ({ ...line, quantity: line.quantity!, giftQuantity: line.giftQuantity! })),
      })
      onSuccess(`品项公司发货单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建品项公司发货失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, '采购订单')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="采购订单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} />
        <FormField label="发货总部" required>
          <InventorySubjectSelect
            options={headquarters.filter((location) => location.orgNodeId).map((location) => ({ value: location.orgNodeId!, label: location.name }))}
            value={sourceOrgNodeId}
            onChange={setSourceOrgNodeId}
            placeholder="请选择总部"
            autoSelect={!doc}
          />
        </FormField>
        {shipMarkets.length > 1 && (
          <FormField label="发往市场" required>
            <Select value={shipMarketId} onChange={(event) => setShipMarketId(event.target.value)}>
              {shipMarkets.map((market) => <option key={market.id} value={market.id}>{market.name}</option>)}
            </Select>
          </FormField>
        )}
        <FormField label="发货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
        <FormField label="物流公司"><Input value={logisticsCompany} onChange={(event) => setLogisticsCompany(event.target.value)} /></FormField>
        <FormField label="物流单号"><Input value={trackingNo} onChange={(event) => setTrackingNo(event.target.value)} /></FormField>
      </div>

      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
      {shipMarkets.length > 1 && (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-3 text-xs text-[#666666]">
          本单含 {shipMarkets.length} 个市场的明细，发货单一次只能发往一个市场，请分次发货。
        </div>
      )}
      {/* 候选按 doc_type 筛，纯供应链行的采购单也会列进来；选中后表单会是空的，
          不给提示的话用户只会看到一个没有明细、点了也提交不了的表单。 */}
      {doc && !loading && shipMarkets.length === 0 && (
        <div className="rounded-[var(--radius)] border border-[#D4820A] bg-[#FFF8E6] p-3 text-sm text-[#7B5E2B]">
          该采购订单没有市场归属的明细（全部是品项公司自用行），请改走「供应链采购入库」。
        </div>
      )}
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">发货批次与数量</h3>
          {lines.map((line, index) => (
            <div key={line.purchaseOrderItemId} className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-5">
              <div>
                <div className="text-sm font-medium">{line.skuName}</div>
                <div className="text-xs text-[#888888]">{line.specName || line.skuId}</div>
                {line.remainingQuantity <= 0.000001 && <div className="mt-1 text-xs text-[#888888]">正常已履约，仍可单独填写赠送数量</div>}
              </div>
              <FormField label="发货批次"><LotPicker locationId={headquarters.find((location) => location.orgNodeId === sourceOrgNodeId)?.locationId ?? ''} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
              <FormField label="正常发货"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              <FormField label="赠送数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.giftQuantity} onChange={(event) => updateLine(index, { giftQuantity: event.target.value })} /></FormField>
              <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
            </div>
          ))}
        </div>
      )}

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>创建品项公司发货单</Button></div>
    </form>
  )
}

interface ReceiptProgressLine {
  shipmentItemId: number
  skuName: string
  isGift: boolean
  shippedQuantity: number
  receivedQuantity: number
  outstandingQuantity: number
  receivedInput: string
  remark: string
}

function ShipmentReceiptForm({
  workflowDocs,
  kind,
  prefill,
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  kind: 'market' | 'store'
  /** 待办区「去收货」带来的预选券（#192）。 */
  prefill?: OperationFormPrefill | null
  onSuccess: (message: string) => void
}) {
  const docType = kind === 'market' ? '品项公司发货' : '分院配货'
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  useDocumentPrefill(prefill, selectDocument)
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<ReceiptProgressLine[]>([])
  const [loadingProgress, setLoadingProgress] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!doc) {
      setLines([])
      return () => { cancelled = true }
    }
    setLoadingProgress(true)
    getShipmentReceiptProgress(doc.id)
      .then((progress) => {
        if (!cancelled) {
          setLines(progress.items.filter((item) => item.outstandingQuantity > 0.000001).map((item) => ({
            shipmentItemId: item.itemId,
            skuName: item.skuName,
            isGift: item.isGift,
            shippedQuantity: item.shippedQuantity,
            receivedQuantity: item.receivedQuantity,
            outstandingQuantity: item.outstandingQuantity,
            receivedInput: String(item.outstandingQuantity),
            remark: '',
          })))
        }
      })
      .catch((error) => {
        if (!cancelled) toast.error(actionErrorMessage(error, '加载发货进度失败'))
      })
      .finally(() => {
        if (!cancelled) setLoadingProgress(false)
      })
    return () => { cancelled = true }
  }, [doc])

  function updateLine(index: number, patch: Partial<ReceiptProgressLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc) {
      toast.error('请选择待收货发货单')
      return
    }
    const items = lines.map((line) => ({
      shipmentItemId: line.shipmentItemId,
      receivedQuantity: positiveNumber(line.receivedInput),
      remark: optionalText(line.remark),
    })).filter((line) => line.receivedQuantity !== null)
    if (items.length === 0) {
      toast.error('请填写至少一条实收数量')
      return
    }
    setSaving(true)
    try {
      const input = {
        shipmentId: doc.id,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, receivedQuantity: item.receivedQuantity! })),
      }
      const result = kind === 'market'
        ? await receiveItemCompanyShipment(input)
        : await receiveStoreAllocation(input)
      onSuccess(`${kind === 'market' ? '市场采购入库' : '分院收货入库'}已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '登记实收失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, docType, '待收货')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label={kind === 'market' ? '品项公司发货单' : '分院配货单'} docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} required />
        <FormField label="收货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {(loading || loadingProgress) && <div className="text-sm text-[#666666]">正在加载待收货明细</div>}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]"><tr><th className="px-3 py-2 font-medium">商品</th><th className="px-3 py-2 font-medium">发货</th><th className="px-3 py-2 font-medium">已收</th><th className="px-3 py-2 font-medium">待收</th><th className="px-3 py-2 font-medium">本次实收</th><th className="px-3 py-2 font-medium">明细备注</th></tr></thead>
            <tbody>{lines.map((line, index) => {
              /*
               * 行内控件的可访问名（#194）。⚠️ 本表只用商品名是**不够**的，而且这里连规格都拼不上：
               *   · 一行 = 发货单的一条明细（getShipmentReceiptProgress 走 allDocItemsForUpdate 原样返回，
               *     不按 sku 聚合），skuName 落库时取的是 `sku.productName`（纯商品名，不含规格）；
               *   · 同一商品的两个规格 → 两行，skuName 完全相同；
               *   · 同一个 sku 的赠品行与正常行 → 两行，连 skuId 都相同（只差「赠送」角标）。
               * 返回 payload（ReceiptProgressLine）里没有 specName，表格也只显示商品名 + 角标，
               * 要补规格得改 src/lib/inventory/business.ts 的 getShipmentReceiptProgress，超出本次范围。
               * 所以这张表按规则用**行序号**兜底：lines 装载后不排序、不增删，updateLine 也按 index
               * 打补丁，序号在这张单据的加载期内是稳定的。
               */
              const rowName = `${line.skuName} 第${index + 1}行`
              return <tr key={line.shipmentItemId} className="border-t border-[var(--border)]"><td className="px-3 py-2"><div className="font-medium">{line.skuName}</div>{line.isGift && <Badge variant="outline" className="mt-1 text-[10px]">赠送</Badge>}</td><td className="px-3 py-2">{line.shippedQuantity}</td><td className="px-3 py-2">{line.receivedQuantity}</td><td className="px-3 py-2">{line.outstandingQuantity}</td><td className="px-3 py-2"><Input className="w-24" aria-label={`本次实收 ${rowName}`} type="number" min="0" step="0.01" max="9999999999.99" value={line.receivedInput} onChange={(event) => updateLine(index, { receivedInput: event.target.value })} /></td><td className="px-3 py-2"><Input aria-label={`明细备注 ${rowName}`} value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></td></tr>
            })}</tbody>
          </table>
        </div>
      )}
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>登记本次实收</Button></div>
    </form>
  )
}

interface SupplyChainPurchaseReceiptDraftLine {
  purchaseOrderItemId: number
  skuName: string
  specName: string | null
  quantity: string
  batchNo: string
  expiryDate: string
  remark: string
}

function SupplyChainPurchaseReceiptForm({
  locations,
  workflowDocs,
  canViewPrice,
  prefill,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  /** 待办区「去收货」带来的预选券（#192）。 */
  prefill?: OperationFormPrefill | null
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  useDocumentPrefill(prefill, selectDocument)
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<SupplyChainPurchaseReceiptDraftLine[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSupplyChainLocationId(doc.targetOrgNodeId ?? '')
    // 所有行（不论有无市场归属）都走供应链采购入库（#335），market_id 只是来源追溯标记。
    setLines(doc.items.filter(hasAvailableQuantity).map((item) => ({
      purchaseOrderItemId: item.id,
      skuName: item.skuName,
      specName: item.specName,
      quantity: String(Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))),
      batchNo: '',
      expiryDate: '',
      remark: '',
    })))
  }, [doc])

  function updateLine(index: number, patch: Partial<SupplyChainPurchaseReceiptDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !supplyChainLocationId) {
      toast.error('请选择待收货的采购订单')
      return
    }
    const items = lines.map((line) => ({
      purchaseOrderItemId: line.purchaseOrderItemId,
      quantity: positiveNumber(line.quantity),
      batchNo: optionalText(line.batchNo),
      expiryDate: optionalText(line.expiryDate),
      remark: optionalText(line.remark),
    })).filter((line) => line.quantity !== null)
    if (items.length === 0) {
      toast.error('请填写至少一条实收数量')
      return
    }
    setSaving(true)
    try {
      const result = await receiveSupplyChainPurchaseOrder({
        purchaseOrderId: doc.id,
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`供应链采购入库单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '登记供应链采购入库失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, '采购订单', '待收货')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="采购订单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} />
        <FormField label="供应链库存主体" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={supplyChainLocationId}
            onChange={setSupplyChainLocationId}
            placeholder="请选择总部"
            autoSelect={!doc}
            disabled={Boolean(doc)}
          />
        </FormField>
        <FormField label="入库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">本次实收入库</h3>
          {lines.map((line, index) => (
            <div key={line.purchaseOrderItemId} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-5">
              <div><div className="font-medium text-sm">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || `明细 #${line.purchaseOrderItemId}`}</div></div>
              <FormField label="实收数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              <FormField label="批号"><Input value={line.batchNo} onChange={(event) => updateLine(index, { batchNo: event.target.value })} placeholder="留空自动生成" /></FormField>
              <FormField label="效期"><DatePicker value={line.expiryDate} onValueChange={(value) => updateLine(index, { expiryDate: value })} /></FormField>
              <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
            </div>
          ))}
        </div>
      )}
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>登记供应链采购入库</Button></div>
    </form>
  )
}

function SupplyChainPurchaseCancelForm({
  workflowDocs,
  prefill,
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  /** 待办区跳转带来的预选券（#192）。本业务的行内动作是弹窗关闭，跳转只在表单侧兜底。 */
  prefill?: OperationFormPrefill | null
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  useDocumentPrefill(prefill, selectDocument)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = docCandidates(workflowDocs, '采购订单', '待收货')

  async function submit() {
    if (saving) return
    if (!doc || !reason.trim()) {
      toast.error('请选择待收货的采购订单并填写关闭原因')
      return
    }
    setSaving(true)
    try {
      await cancelSupplyChainPurchaseOrder({
        purchaseOrderId: doc.id,
        cancellationReason: reason.trim(),
      })
      onSuccess('采购订单已关闭，未收数量已释放')
    } catch (error) {
      toast.error(actionErrorMessage(error, '关闭采购订单失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DocPicker label="待收货采购订单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} />
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <FormField label="关闭原因" required><Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>
      <div className="flex justify-end">
        <Button type="button" variant="destructive" loading={saving} onClick={() => void submit()} disabled={!doc}>关闭采购订单</Button>
      </div>
    </div>
  )
}

interface StoreAllocationDraftLine {
  requestItemId: number
  skuId: string
  skuName: string
  specName: string | null
  lotId: string
  remainingQuantity: number
  quantity: string
  giftQuantity: string
  storeStandardUnitPrice: number | null
  sourceActualUnitPrice: number | null
  storeUnitDiscount: string
  remark: string
}

function storeAllocationPricePreview(line: StoreAllocationDraftLine) {
  const discount = nonnegativeNumber(line.storeUnitDiscount)
  const actualUnitPrice = line.storeStandardUnitPrice !== null && discount !== null && discount <= line.storeStandardUnitPrice
    ? Number((line.storeStandardUnitPrice - discount).toFixed(4))
    : line.storeStandardUnitPrice === null && discount === 0
      ? line.sourceActualUnitPrice
      : null
  const quantity = nonnegativeNumber(line.quantity)
  return {
    actualUnitPrice,
    amount: actualUnitPrice !== null && quantity !== null
      ? Number((actualUnitPrice * quantity).toFixed(4))
      : null,
  }
}

function StoreAllocationForm({
  locations,
  workflowDocs,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [sourceMarketId, setSourceMarketId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<StoreAllocationDraftLine[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSourceMarketId(doc.marketId ?? doc.targetOrgNodeId ?? '')
    const lineFor = (item: InventoryDocDetail['items'][number], sku?: InventorySkuRow): StoreAllocationDraftLine => {
      const remaining = remainingQuantity(item)
      return {
        requestItemId: item.id,
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        lotId: '',
        remainingQuantity: remaining,
        quantity: String(remaining),
        giftQuantity: '0',
        storeStandardUnitPrice: sku?.storePurchasePrice ?? item.standardUnitPrice ?? null,
        sourceActualUnitPrice: item.actualUnitPrice ?? sku?.storePurchasePrice ?? null,
        storeUnitDiscount: String(item.unitDiscount ?? 0),
        remark: '',
      }
    }
    setLines(doc.items.map((item) => lineFor(item)))
    /*
     * 门店标准单价取商品档案的当前门店进货价（#339）。原先查的是页面预加载的前 100 条 SKU，
     * 排在后面的商品静默退回明细快照价 —— 现在按本单明细的 skuIds 精确查。
     * 取回后只补两列价格（纯展示预览，实价以服务端建单时计算为准），不动用户已填的批次与数量。
     */
    let cancelled = false
    const skuIds = Array.from(new Set(doc.items.map((item) => item.skuId)))
    const chunks: string[][] = []
    for (let index = 0; index < skuIds.length; index += 100) chunks.push(skuIds.slice(index, index + 100))
    void Promise.allSettled(chunks.map((ids) => listInventorySkus({ skuIds: ids, onlyActive: false, page: 1, pageSize: 100 })))
      .then((results) => {
        if (cancelled) return
        // 分块各自生效：某一块失败不连累已成功的那些行
        const skuById = new Map(results
          .flatMap((result) => (result.status === 'fulfilled' ? result.value.data : []))
          .map((sku) => [sku.skuId, sku]))
        const itemById = new Map(doc.items.map((item) => [item.id, item]))
        setLines((previous) => previous.map((line) => {
          const item = itemById.get(line.requestItemId)
          const sku = skuById.get(line.skuId)
          if (!item || !sku) return line
          const priced = lineFor(item, sku)
          return { ...line, storeStandardUnitPrice: priced.storeStandardUnitPrice, sourceActualUnitPrice: priced.sourceActualUnitPrice }
        }))
        // 取价失败退回明细快照价（与改造前「商品不在前 100 条」时同一口径），不阻断配货；
        // 但要让人知道预览里的门店标准单价可能不是当前档案价
        if (results.some((result) => result.status === 'rejected')) {
          toast.warning('部分商品的当前门店进货价加载失败，价格预览暂按报货单快照显示，以提交后服务端计算为准')
        }
      })
    return () => {
      cancelled = true
    }
  }, [doc])

  function updateLine(index: number, patch: Partial<StoreAllocationDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !sourceMarketId) {
      toast.error('请选择门店报货单和配货市场')
      return
    }
    const items = lines.map((line) => ({
      requestItemId: line.requestItemId,
      lotId: Number(line.lotId),
      quantity: nonnegativeNumber(line.quantity),
      giftQuantity: nonnegativeNumber(line.giftQuantity),
      storeUnitDiscount: canViewPrice ? nonnegativeNumber(line.storeUnitDiscount) : 0,
      remark: optionalText(line.remark),
    })).filter((line) => (line.quantity ?? 0) + (line.giftQuantity ?? 0) > 0)
    if (items.length === 0 || items.some((line) => !Number.isInteger(line.lotId) || line.lotId <= 0 || line.quantity === null || line.giftQuantity === null || line.storeUnitDiscount === null)) {
      toast.error('请为每条配货明细选择批次并填写数量')
      return
    }
    setSaving(true)
    try {
      const result = await createStoreAllocation({
        storeRequestId: doc.id,
        sourceMarketId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({
          ...item,
          quantity: item.quantity!,
          giftQuantity: item.giftQuantity!,
          storeUnitDiscount: item.storeUnitDiscount!,
        })),
      })
      onSuccess(`分院配货单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建分院配货失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, '门店报货')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="门店报货单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} />
        <FormField label="配货市场" required>
          <InventorySubjectSelect
            options={markets.map((location) => ({ value: location.locationId, label: location.name }))}
            value={sourceMarketId}
            onChange={setSourceMarketId}
            placeholder="请选择市场"
            autoSelect={!doc}
          />
        </FormField>
        <FormField label="配货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载门店报货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">配货批次与数量</h3>
          {lines.map((line, index) => {
            const pricePreview = storeAllocationPricePreview(line)
            return (
              <div key={line.requestItemId} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                <div className={`grid grid-cols-1 gap-3 ${canViewPrice ? 'xl:grid-cols-6' : 'md:grid-cols-5'}`}>
                  <div>
                    <div className="text-sm font-medium">{line.skuName}</div>
                    <div className="text-xs text-[#888888]">{line.specName || line.skuId}</div>
                    {line.remainingQuantity <= 0.000001 && <div className="mt-1 text-xs text-[#888888]">正常已履约，仍可单独填写赠送数量</div>}
                  </div>
                  <FormField label="市场批次"><LotPicker locationId={sourceMarketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
                  <FormField label="正常配货"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
                  <FormField label="赠送数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.giftQuantity} onChange={(event) => updateLine(index, { giftQuantity: event.target.value })} /></FormField>
                  {canViewPrice && <FormField label="门店单价优惠"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.storeUnitDiscount} onChange={(event) => updateLine(index, { storeUnitDiscount: event.target.value })} /></FormField>}
                  <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
                </div>
                {canViewPrice && (
                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3 text-sm md:grid-cols-4">
                    <div><div className="text-xs text-[#888888]">门店标准单价</div><div className="mt-1 font-medium">{formatPrice(line.storeStandardUnitPrice)}</div></div>
                    <div><div className="text-xs text-[#888888]">单价优惠</div><div className="mt-1 font-medium">{formatPrice(nonnegativeNumber(line.storeUnitDiscount))}</div></div>
                    <div><div className="text-xs text-[#888888]">优惠后实际单价</div><div className="mt-1 font-medium">{formatPrice(pricePreview.actualUnitPrice)}</div></div>
                    <div><div className="text-xs text-[#888888]">本行应付货款</div><div className="mt-1 font-medium">{formatPrice(pricePreview.amount)}</div></div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>创建分院配货单</Button></div>
    </form>
  )
}

interface LotDraftLine {
  skuId: string
  lotId: string
  quantity: string
  reason: string
  remark: string
}

function ReturnForm({
  locations,
  sourceType,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  sourceType: '市场' | '门店'
  onSuccess: (message: string) => void
}) {
  const sourceLocations = locations.filter((location) => location.locationType === sourceType && location.isActive)
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [sourceOrgNodeId, setSourceOrgNodeId] = useState('')
  const [targetOrgNodeId, setTargetOrgNodeId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)
  const source = sourceLocations.find((location) => location.orgNodeId === sourceOrgNodeId)

  function selectSource(nextSourceId: string) {
    setSourceOrgNodeId(nextSourceId)
    const nextSource = sourceLocations.find((location) => location.orgNodeId === nextSourceId)
    if (nextSource?.locationType === '门店') setTargetOrgNodeId(nextSource.parentLocationId ?? '')
    if (nextSource?.locationType === '市场') setTargetOrgNodeId(headquarters[0]?.orgNodeId ?? '')
    setLines((previous) => previous.map((line) => ({ ...line, lotId: '' })))
  }

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!sourceOrgNodeId || !targetOrgNodeId) {
      toast.error('请选择退货主体和回库主体')
      return
    }
    const items = lines.map((line) => ({
      lotId: Number(line.lotId),
      quantity: positiveNumber(line.quantity),
      reason: optionalText(line.reason),
      remark: optionalText(line.remark),
    }))
    if (items.some((item) => !Number.isInteger(item.lotId) || item.lotId <= 0 || item.quantity === null)) {
      toast.error('请完整填写退货批次和数量')
      return
    }
    setSaving(true)
    try {
      const result = await createReturnForRestock({
        sourceOrgNodeId,
        targetOrgNodeId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`退货申请已创建：${result.id}`)
      setLines([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建退货申请失败'))
    } finally {
      setSaving(false)
    }
  }

  // 注意跨 id 空间比较：parentLocationId 存的是 inventory_locations 的父级 location_id，
  // 这里拿它比 org_node_id —— 只因为父级必然是市场 / 总部（两者 location_id = org_nodes.id）
  // 才成立。门店的 location_id 是 store_id，永远不会出现在 targets 里。
  const targets = source?.locationType === '门店'
    // isActive 与其它 16 处候选口径对齐：停用主体不该进候选，否则「候选唯一」会被它污染。
    ? locations.filter((location) => location.orgNodeId === source.parentLocationId && location.isActive)
    : headquarters
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="退货主体" required>
          <InventorySubjectSelect
            options={sourceLocations.filter((location) => location.orgNodeId).map((location) => ({ value: location.orgNodeId!, label: `${location.locationType} · ${location.name}` }))}
            value={sourceOrgNodeId}
            onChange={selectSource}
            placeholder={`请选择${sourceType}`}
          />
        </FormField>
        <FormField label="回库主体" required>
          {/*
            值由「退货主体」联动派生（门店→父市场、市场→总部），不能自己补：未选来源时
            targets 退化成 headquarters，自动选中会把唯一总部固定成只读——而门店退货
            只能退回父市场，那就是个撒谎的只读值，还会盖掉 selectSource 刚写进去的市场。
          */}
          <InventorySubjectSelect
            options={targets.filter((location) => location.orgNodeId).map((location) => ({ value: location.orgNodeId!, label: location.name }))}
            value={targetOrgNodeId}
            onChange={setTargetOrgNodeId}
            placeholder="请选择回库主体"
            autoSelect={false}
          />
        </FormField>
        <FormField label="退货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">退货批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem]">
            <FormField label="商品" required group><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField>
            <FormField label="来源批次" required><LotPicker locationId={source?.locationId ?? ''} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
            <FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
            <FormField label="退货原因"><Input value={line.reason} onChange={(event) => updateLine(index, { reason: event.target.value })} /></FormField>
            <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
            <div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div>
          </div>
        ))}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建退货申请</Button></div>
    </form>
  )
}

function ReturnApprovalForm({
  workflowDocs,
  docType,
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  docType: '院退货' | '市场退货'
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [auditRemark, setAuditRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = workflowDocs.filter((row) => row.docType === docType && row.status === '待审批')

  async function approve() {
    if (saving) return
    if (!doc) {
      toast.error('请选择待审批退货单')
      return
    }
    setSaving(true)
    try {
      const result = await approveReturnForRestock({ returnDocId: doc.id, auditRemark: optionalText(auditRemark) })
      onSuccess(`退货已审批回库：${result.id}`)
    } catch (error) {
      toast.error(actionErrorMessage(error, '审批退货失败'))
    } finally {
      setSaving(false)
    }
  }

  async function reject() {
    if (saving) return
    if (!doc || !auditRemark.trim()) {
      toast.error('请选择退货单并填写驳回原因')
      return
    }
    setSaving(true)
    try {
      await rejectReturnForRestock({ returnDocId: doc.id, auditRemark: auditRemark.trim() })
      onSuccess('退货申请已驳回')
    } catch (error) {
      toast.error(actionErrorMessage(error, '驳回退货失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待审批退货单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} /></div>
      {loading && <div className="text-sm text-[#666666]">正在加载退货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <RemarkField value={auditRemark} onChange={setAuditRemark} />
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" loading={saving} onClick={() => void reject()} disabled={!doc}>驳回退货</Button><Button type="button" loading={saving} onClick={() => void approve()} disabled={!doc}>审批并回库</Button></div>
    </div>
  )
}

function ShipmentCancellationRequestForm({
  workflowDocs,
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = docCandidates(workflowDocs, '品项公司发货', '待收货')

  async function submit() {
    if (saving) return
    if (!doc || !reason.trim()) {
      toast.error('请选择待收货发货单并填写撤回原因')
      return
    }
    setSaving(true)
    try {
      await requestItemCompanyShipmentCancellation({ shipmentId: doc.id, cancellationReason: reason.trim() })
      onSuccess('品项公司发货撤回申请已提交，等待具备撤回审批权限的用户处理')
    } catch (error) {
      toast.error(actionErrorMessage(error, '提交品项公司发货撤回申请失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待收货品项公司发货单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} /></div>
      {loading && <div className="text-sm text-[#666666]">正在加载发货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <FormField label="撤回原因" required><Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>
      <div className="flex justify-end"><Button type="button" variant="destructive" loading={saving} onClick={() => void submit()} disabled={!doc}>提交撤回申请</Button></div>
    </div>
  )
}

function ShipmentCancellationApprovalForm({
  workflowDocs,
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [auditRemark, setAuditRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = workflowDocs.filter((row) => row.docType === '品项公司发货' && row.status === '待审批')

  async function approve() {
    if (saving || !doc) {
      if (!doc) toast.error('请选择待审批的品项公司发货撤回申请')
      return
    }
    setSaving(true)
    try {
      await approveItemCompanyShipmentCancellation({
        shipmentId: doc.id,
        auditRemark: optionalText(auditRemark),
      })
      onSuccess('品项公司发货已撤回，总部库存已恢复')
    } catch (error) {
      toast.error(actionErrorMessage(error, '审批品项公司发货撤回失败'))
    } finally {
      setSaving(false)
    }
  }

  async function reject() {
    if (saving) return
    if (!doc || !auditRemark.trim()) {
      toast.error('请选择撤回申请并填写驳回原因')
      return
    }
    setSaving(true)
    try {
      await rejectItemCompanyShipmentCancellation({ shipmentId: doc.id, auditRemark: auditRemark.trim() })
      onSuccess('品项公司发货撤回申请已驳回，单据恢复待收货')
    } catch (error) {
      toast.error(actionErrorMessage(error, '驳回品项公司发货撤回申请失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DocPicker label="待审批品项公司发货单" required docs={candidates} value={docId} current={doc} onChange={(id) => void selectDocument(id)} />
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载撤回申请明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      {doc?.cancellationRequestReason && (
        <div className="rounded-[var(--radius)] border border-[#F2D7D4] bg-[#FFF8F7] p-3 text-sm">
          <div className="text-xs text-[#888888]">市场撤回原因</div>
          <div className="mt-1">{doc.cancellationRequestReason}</div>
        </div>
      )}
      <FormField label="审批备注 / 驳回原因"><Textarea value={auditRemark} onChange={(event) => setAuditRemark(event.target.value)} /></FormField>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" loading={saving} onClick={() => void reject()} disabled={!doc}>驳回申请</Button>
        <Button type="button" variant="destructive" loading={saving} onClick={() => void approve()} disabled={!doc}>审批并撤回发货</Button>
      </div>
    </div>
  )
}

function SupplyChainStaffPurchaseForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [locationId, setLocationId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [employeeOptions, setEmployeeOptions] = useState<Array<{ employeeId: string; name: string }>>([])
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  const employeeRequestRef = useRef(0)
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)

  // 卸载标志：主体候选唯一时员工列表会在挂载那一刻就开始拉（#189），此前只有用户手选
  // 才会发起。请求序号挡得住结果错配，但挡不住「打开就切走」时给已卸载表单弹错误 toast。
  // ⚠️ 必须是独立的 ref，不能拿请求序号当卸载标志：StrictMode（dev 默认开）会 mount →
  // cleanup → 再 mount，污染序号会让首发请求的结果被永久丢弃，loading 再也不复位。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function selectLocation(nextLocationId: string) {
    const requestId = ++employeeRequestRef.current
    setLocationId(nextLocationId)
    setEmployeeId('')
    setEmployeeOptions([])
    setLines((previous) => previous.map((line) => ({ ...line, lotId: '' })))
    if (!nextLocationId) {
      setLoadingEmployees(false)
      return
    }
    setLoadingEmployees(true)
    try {
      const options = await listSupplyChainEmployeeOptions(nextLocationId)
      if (employeeRequestRef.current === requestId) setEmployeeOptions(options)
    } catch (error) {
      if (mountedRef.current && employeeRequestRef.current === requestId) {
        toast.error(actionErrorMessage(error, '加载供应链员工失败'))
      }
    } finally {
      if (employeeRequestRef.current === requestId) setLoadingEmployees(false)
    }
  }

  async function submit() {
    if (saving) return
    if (!locationId || !employeeId) {
      toast.error('请选择供应链总部和购买员工')
      return
    }
    const items = lines.map((line) => ({ lotId: Number(line.lotId), quantity: positiveNumber(line.quantity), remark: optionalText(line.remark) }))
    if (items.some((item) => !Number.isInteger(item.lotId) || item.lotId <= 0 || item.quantity === null)) {
      toast.error('请完整填写员工购批次和数量')
      return
    }
    setSaving(true)
    try {
      const result = await createSupplyChainStaffPurchase({
        locationId,
        employeeId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`供应链员工购出库单已创建：${result.id}`)
      setEmployeeId('')
      setLines([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建供应链员工购失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="供应链总部" required>
          <InventorySubjectSelect
            options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))}
            value={locationId}
            onChange={(nextLocationId) => void selectLocation(nextLocationId)}
            placeholder="请选择供应链总部"
          />
        </FormField>
        <FormField label="购买员工" required>
          <Select value={employeeId} disabled={!locationId || loadingEmployees} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">{loadingEmployees ? '正在加载员工' : locationId ? '请选择员工' : '请先选择供应链总部'}</option>
            {employeeOptions.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>)}
          </Select>
        </FormField>
        <FormField label="出库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">员工购批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required group><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="供应链批次" required><LotPicker locationId={locationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建供应链员工购出库单</Button></div>
    </form>
  )
}

function MarketStaffPurchaseForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const [marketId, setMarketId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [employeeOptions, setEmployeeOptions] = useState<Array<{ employeeId: string; name: string }>>([])
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  const employeeRequestRef = useRef(0)
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)

  // 卸载标志：主体候选唯一时员工列表会在挂载那一刻就开始拉（#189），此前只有用户手选
  // 才会发起。请求序号挡得住结果错配，但挡不住「打开就切走」时给已卸载表单弹错误 toast。
  // ⚠️ 必须是独立的 ref，不能拿请求序号当卸载标志：StrictMode（dev 默认开）会 mount →
  // cleanup → 再 mount，污染序号会让首发请求的结果被永久丢弃，loading 再也不复位。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function selectMarket(nextMarketId: string) {
    const requestId = ++employeeRequestRef.current
    setMarketId(nextMarketId)
    setEmployeeId('')
    setEmployeeOptions([])
    setLines((previous) => previous.map((line) => ({ ...line, lotId: '' })))
    if (!nextMarketId) {
      setLoadingEmployees(false)
      return
    }
    setLoadingEmployees(true)
    try {
      const options = await listMarketEmployeeOptions(nextMarketId)
      if (employeeRequestRef.current === requestId) setEmployeeOptions(options)
    } catch (error) {
      if (mountedRef.current && employeeRequestRef.current === requestId) {
        toast.error(actionErrorMessage(error, '加载市场员工失败'))
      }
    } finally {
      if (employeeRequestRef.current === requestId) setLoadingEmployees(false)
    }
  }

  async function submit() {
    if (saving) return
    if (!marketId || !employeeId) {
      toast.error('请选择市场和购买员工')
      return
    }
    const items = lines.map((line) => ({ lotId: Number(line.lotId), quantity: positiveNumber(line.quantity), remark: optionalText(line.remark) }))
    if (items.some((item) => !Number.isInteger(item.lotId) || item.lotId <= 0 || item.quantity === null)) {
      toast.error('请完整填写员工购批次和数量')
      return
    }
    setSaving(true)
    try {
      const result = await createMarketStaffPurchase({
        marketId,
        employeeId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`市场员工购出库单已创建：${result.id}`)
      setEmployeeId('')
      setLines([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建市场员工购失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="市场" required>
          <InventorySubjectSelect
            options={markets.map((location) => ({ value: location.locationId, label: location.name }))}
            value={marketId}
            onChange={(nextMarketId) => void selectMarket(nextMarketId)}
            placeholder="请选择市场"
          />
        </FormField>
        <FormField label="购买员工" required>
          <Select value={employeeId} disabled={!marketId || loadingEmployees} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">{loadingEmployees ? '正在加载员工' : marketId ? '请选择员工' : '请先选择市场'}</option>
            {employeeOptions.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>)}
          </Select>
        </FormField>
        <FormField label="出库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">员工购批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required group><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="市场批次" required><LotPicker locationId={marketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建员工购出库单</Button></div>
    </form>
  )
}

interface SelfPurchaseDraftLine {
  skuId: string
  quantity: string
  batchNo: string
  expiryDate: string
  isGift: boolean
  marketActualUnitPrice: string
  storeUnitDiscount: string
  remark: string
}

function SelfPurchaseForm({
  locations,
  suppliers,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  suppliers: InventorySupplierRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const [marketId, setMarketId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [receiptAttachmentUrl, setReceiptAttachmentUrl] = useState('')
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<SelfPurchaseDraftLine[]>([{ skuId: '', quantity: '1', batchNo: '', expiryDate: '', isGift: false, marketActualUnitPrice: '', storeUnitDiscount: '0', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<SelfPurchaseDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!marketId || !supplierId) {
      toast.error('请选择市场和供应商')
      return
    }
    const hasInvalidLine = lines.some((line) => {
      const hasActualPriceInput = canViewPrice && line.marketActualUnitPrice.trim() !== ''
      return !line.skuId ||
        positiveNumber(line.quantity) === null ||
        (hasActualPriceInput && nonnegativeNumber(line.marketActualUnitPrice) === null) ||
        (canViewPrice && nonnegativeNumber(line.storeUnitDiscount) === null)
    })
    if (hasInvalidLine) {
      toast.error('请完整填写自采入库明细')
      return
    }
    const items = lines.map((line) => ({
      skuId: line.skuId,
      quantity: positiveNumber(line.quantity),
      batchNo: optionalText(line.batchNo),
      expiryDate: optionalText(line.expiryDate),
      isGift: line.isGift,
      marketActualUnitPrice: canViewPrice && line.marketActualUnitPrice.trim() ? nonnegativeNumber(line.marketActualUnitPrice) : null,
      storeUnitDiscount: canViewPrice ? nonnegativeNumber(line.storeUnitDiscount) : 0,
      remark: optionalText(line.remark),
    }))
    setSaving(true)
    try {
      const result = await createSelfPurchasedReceipt({
        marketId,
        supplierId,
        docDate: optionalText(docDate),
        receiptAttachmentUrl: optionalText(receiptAttachmentUrl),
        remark: optionalText(remark),
        items: items.map((item) => ({
          ...item,
          quantity: item.quantity!,
          marketActualUnitPrice: item.marketActualUnitPrice,
          storeUnitDiscount: item.storeUnitDiscount!,
        })),
      })
      onSuccess(`自采产品入库单已创建：${result.id}`)
      setLines([{ skuId: '', quantity: '1', batchNo: '', expiryDate: '', isGift: false, marketActualUnitPrice: '', storeUnitDiscount: '0', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建自采产品入库失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <FormField label="入库市场" required>
          <InventorySubjectSelect
            options={markets.map((location) => ({ value: location.locationId, label: location.name }))}
            value={marketId}
            onChange={(nextMarketId) => { setMarketId(nextMarketId); setLines((previous) => previous.map((line) => ({ ...line, skuId: '' }))) }}
            placeholder="请选择市场"
          />
        </FormField>
        <FormField label="供应商" required><Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">请选择供应商</option>{suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}</Select></FormField>
        <FormField label="入库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
        <FormField label="收据附件地址" className="md:col-span-2"><Input value={receiptAttachmentUrl} onChange={(event) => setReceiptAttachmentUrl(event.target.value)} placeholder="填写附件地址" /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">自采入库明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', quantity: '1', batchNo: '', expiryDate: '', isGift: false, marketActualUnitPrice: '', storeUnitDiscount: '0', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className={`grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 ${canViewPrice ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}><FormField label="自采商品" required group><SkuPicker value={line.skuId} filters={{ ownedByMarketId: marketId }} disabled={!marketId} disabledHint="请先选择市场" onChange={(skuId) => updateLine(index, { skuId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="批号"><Input value={line.batchNo} onChange={(event) => updateLine(index, { batchNo: event.target.value })} placeholder="留空自动生成" /></FormField><FormField label="效期"><DatePicker value={line.expiryDate} onValueChange={(value) => updateLine(index, { expiryDate: value })} /></FormField><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={line.isGift} onChange={(event) => updateLine(index, { isGift: event.target.checked })} />赠送</label>{canViewPrice && <><FormField label="实际采购单价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.marketActualUnitPrice} onChange={(event) => updateLine(index, { marketActualUnitPrice: event.target.value })} placeholder="资料价或本次价格" /></FormField><FormField label="门店单价优惠"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.storeUnitDiscount} onChange={(event) => updateLine(index, { storeUnitDiscount: event.target.value })} /></FormField></>}<FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建自采产品入库单</Button></div>
    </form>
  )
}

function ExternalOutboundForm({
  locations,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [locationId, setLocationId] = useState('')
  const [externalPartyName, setExternalPartyName] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!locationId || !externalPartyName.trim()) {
      toast.error('请选择供应链库存主体并填写外部对象')
      return
    }
    const items = lines.map((line) => ({ lotId: Number(line.lotId), quantity: positiveNumber(line.quantity), remark: optionalText(line.remark) }))
    if (items.some((item) => !Number.isInteger(item.lotId) || item.lotId <= 0 || item.quantity === null)) {
      toast.error('请完整填写出库批次和数量')
      return
    }
    setSaving(true)
    try {
      const result = await createExternalMarketOutbound({
        locationId,
        externalPartyName: externalPartyName.trim(),
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`非凤御市场出库单已创建：${result.id}`)
      setLines([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建非凤御市场出库失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3"><FormField label="供应链库存主体" required><InventorySubjectSelect options={headquarters.map((location) => ({ value: location.locationId, label: location.name }))} value={locationId} onChange={(nextLocationId) => { setLocationId(nextLocationId); setLines((previous) => previous.map((line) => ({ ...line, lotId: '' }))) }} placeholder="请选择供应链库存主体" /></FormField><FormField label="外部对象" required><Input value={externalPartyName} onChange={(event) => setExternalPartyName(event.target.value)} /></FormField><FormField label="出库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField></div>
      <div className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">出库批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>{lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required group><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="供应链批次" required><LotPicker locationId={locationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}</div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建非凤御市场出库单</Button></div>
    </form>
  )
}

interface ConversionDraftLine {
  sourceSkuId: string
  sourceLotId: string
  sourceQuantity: string
  targetSkuId: string
  targetQuantity: string
  targetBatchNo: string
  targetExpiryDate: string
  remark: string
}

function ConversionForm({
  locations,
  locationType,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  locationType: InventoryLocationRow['locationType']
  onSuccess: (message: string) => void
}) {
  const availableLocations = locations.filter((location) => location.locationType === locationType && location.isActive)
  const [locationId, setLocationId] = useState('')
  // 目标商品口径对齐服务端 `assertSkuAvailableToMarket(targetSku, marketIdForLocation(location))`：
  // 市场 / 门店主体可转入供应链商品或本市场自采商品，总部主体只能转入供应链商品。
  const selectedLocation = availableLocations.find((candidate) => candidate.locationId === locationId)
  const targetMarketId = selectedLocation?.locationType === '市场'
    ? selectedLocation.locationId
    : selectedLocation?.locationType === '门店' ? selectedLocation.parentLocationId : null
  const targetSkuFilters: InventorySkuOptionFilters = targetMarketId
    ? { availableToMarketId: targetMarketId }
    : { sourceType: '供应链' }
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<ConversionDraftLine[]>([{ sourceSkuId: '', sourceLotId: '', sourceQuantity: '1', targetSkuId: '', targetQuantity: '1', targetBatchNo: '', targetExpiryDate: '', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<ConversionDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!locationId) {
      toast.error('请选择转换库存主体')
      return
    }
    const items = lines.map((line) => ({
      sourceLotId: Number(line.sourceLotId),
      sourceQuantity: positiveNumber(line.sourceQuantity),
      targetSkuId: line.targetSkuId,
      targetQuantity: positiveNumber(line.targetQuantity),
      targetBatchNo: optionalText(line.targetBatchNo),
      targetExpiryDate: optionalText(line.targetExpiryDate),
      remark: optionalText(line.remark),
    }))
    if (items.some((item) => !Number.isInteger(item.sourceLotId) || item.sourceLotId <= 0 || !item.targetSkuId || item.sourceQuantity === null || item.targetQuantity === null)) {
      toast.error('请完整填写库存转换的来源批次、目标商品和数量')
      return
    }
    setSaving(true)
    try {
      const result = await createInventoryConversion({
        locationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, sourceQuantity: item.sourceQuantity!, targetQuantity: item.targetQuantity! })),
      })
      onSuccess(`库存转换已完成：${result.outboundId} / ${result.inboundId}`)
      setLines([{ sourceSkuId: '', sourceLotId: '', sourceQuantity: '1', targetSkuId: '', targetQuantity: '1', targetBatchNo: '', targetExpiryDate: '', remark: '' }])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建库存转换失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="转换库存主体" required><InventorySubjectSelect options={availableLocations.map((location) => ({ value: location.locationId, label: `${location.locationType} · ${location.name}` }))} value={locationId} onChange={(nextLocationId) => { setLocationId(nextLocationId); setLines((previous) => previous.map((line) => ({ ...line, sourceLotId: '', targetSkuId: '' }))) }} placeholder={`请选择${locationType}`} /></FormField>
        <FormField label="转换日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">转换明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { sourceSkuId: '', sourceLotId: '', sourceQuantity: '1', targetSkuId: '', targetQuantity: '1', targetBatchNo: '', targetExpiryDate: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 xl:grid-cols-8"><FormField label="来源商品" required group><SkuPicker value={line.sourceSkuId} onChange={(sourceSkuId) => updateLine(index, { sourceSkuId, sourceLotId: '' })} /></FormField><FormField label="来源批次" required><LotPicker locationId={locationId} skuId={line.sourceSkuId} value={line.sourceLotId} onChange={(sourceLotId) => updateLine(index, { sourceLotId })} /></FormField><FormField label="出库数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.sourceQuantity} onChange={(event) => updateLine(index, { sourceQuantity: event.target.value })} /></FormField><FormField label="目标商品" required group><SkuPicker value={line.targetSkuId} filters={targetSkuFilters} disabled={!locationId} disabledHint="请先选择转换库存主体" onChange={(targetSkuId) => updateLine(index, { targetSkuId })} /></FormField><FormField label="入库数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.targetQuantity} onChange={(event) => updateLine(index, { targetQuantity: event.target.value })} /></FormField><FormField label="目标批号"><Input value={line.targetBatchNo} onChange={(event) => updateLine(index, { targetBatchNo: event.target.value })} placeholder="留空自动生成" /></FormField><FormField label="目标效期"><DatePicker value={line.targetExpiryDate} onValueChange={(value) => updateLine(index, { targetExpiryDate: value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div><FormField label="明细备注" className="xl:col-span-7"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建库存转换单</Button></div>
    </form>
  )
}
