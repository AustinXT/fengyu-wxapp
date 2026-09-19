'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
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
  createPurchaseOrderFromItemCompanyReplenishment,
  createPurchaseOrderFromMarketReplenishment,
  createReturnForRestock,
  createSelfPurchasedReceipt,
  createStoreAllocation,
  createStoreReplenishmentRequest,
  getShipmentReceiptProgress,
  listMarketEmployeeOptions,
  listSupplyChainEmployeeOptions,
  quoteMarketReplenishmentPrices,
  receiveItemCompanyShipment,
  receiveSupplyChainPurchaseOrder,
  receiveStoreAllocation,
  rejectItemCompanyShipmentCancellation,
  rejectReturnForRestock,
  requestItemCompanyShipmentCancellation,
  summarizeStoreReplenishmentRequests,
} from '@/actions/inventory/business'
import type { MarketPromotionQuoteResult } from '@/lib/inventory/business'
import { getInventoryCoreDocById, listInventoryOperationDocs } from '@/actions/inventory/docs'
import { listInventoryLotOptions } from '@/actions/inventory/stocks'
import { actionErrorMessage } from '@/lib/action-error'
import type {
  InventoryDocDetail,
  InventoryDocRow,
  InventoryLocationRow,
  InventoryLotRow,
  InventorySkuRow,
  InventorySupplierRow,
} from '@/lib/inventory/types'
import type { InventoryBusinessLevel } from '@/lib/inventory/business-level'
import type { InventoryOperationId } from '@/lib/inventory/operation-doc-types'
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

interface OperationDefinition {
  id: OperationId
  title: string
  group: '需求与采购' | '发货、收货与退货' | '市场特殊业务'
  icon: typeof Boxes
  tone: string
  approvalOnly?: boolean
  shipmentCancellationAccess?: '申请' | '审批'
  selfPurchaseOnly?: boolean
  level: InventoryBusinessLevel
  href?: string
}

const OPERATIONS: OperationDefinition[] = [
  { id: 'item-company-request', level: 'supply-chain', title: '品项公司报货需求', group: '需求与采购', icon: PackagePlus, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  { id: 'supply-chain-purchase-order', level: 'supply-chain', title: '供应链采购订单', group: '需求与采购', icon: ShoppingCart, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'company-shipment', level: 'supply-chain', title: '品项公司发货', group: '发货、收货与退货', icon: Truck, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'supply-chain-receipt', level: 'supply-chain', title: '供应链采购入库', group: '发货、收货与退货', icon: PackageCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'supply-chain-purchase-cancel', level: 'supply-chain', title: '关闭供应链采购', group: '发货、收货与退货', icon: RefreshCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', approvalOnly: true },
  { id: 'market-return-approval', level: 'supply-chain', title: '审批市场退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D4820A] bg-[#FFF8E6]', approvalOnly: true },
  { id: 'shipment-cancel-approval', level: 'supply-chain', title: '审批品项发货撤回', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', approvalOnly: true, shipmentCancellationAccess: '审批' },
  { id: 'supply-chain-conversion', level: 'supply-chain', title: '供应链库存转换', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'external-outbound', level: 'supply-chain', title: '非凤御市场出库', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
  { id: 'supply-chain-staff-purchase', level: 'supply-chain', title: '供应链员工购', group: '市场特殊业务', icon: UserRoundCheck, tone: 'text-[#8A4B7A] bg-[#FCF1F9]' },
  { id: 'market-report', level: 'market', title: '市场汇总报货', group: '需求与采购', icon: PackageSearch, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  // 采购订单位于流程图供应链泳道（市场报货单汇总 → 采购订单），归供应链办理台；
  // action 权限 inventory:supply_chain_operate 与 business.ts 的总部 scope 校验同源。
  { id: 'purchase-order', level: 'supply-chain', title: '创建采购订单', group: '需求与采购', icon: ShoppingCart, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  { id: 'market-receipt', level: 'market', title: '市场采购入库', group: '发货、收货与退货', icon: PackageCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'store-allocation', level: 'market', title: '分院配货', group: '发货、收货与退货', icon: Send, tone: 'text-[#8B5A2B] bg-[#FFF5E8]' },
  { id: 'store-return-approval', level: 'market', title: '审批门店退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D4820A] bg-[#FFF8E6]', approvalOnly: true },
  { id: 'market-return', level: 'market', title: '市场退货申请', group: '发货、收货与退货', icon: Undo2, tone: 'text-[#D4820A] bg-[#FFF8E6]' },
  { id: 'shipment-cancel', level: 'market', title: '申请撤回品项发货', group: '发货、收货与退货', icon: RefreshCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', shipmentCancellationAccess: '申请' },
  { id: 'staff-purchase', level: 'market', title: '市场员工购', group: '市场特殊业务', icon: UserRoundCheck, tone: 'text-[#8A4B7A] bg-[#FCF1F9]' },
  { id: 'self-purchase', level: 'market', title: '自采产品入库', group: '市场特殊业务', icon: Warehouse, tone: 'text-[#3D8A5A] bg-[#F0F9F2]', selfPurchaseOnly: true },
  { id: 'market-conversion', level: 'market', title: '市场库存转换', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'store-request', level: 'store', title: '门店报货', group: '需求与采购', icon: PackagePlus, tone: 'text-[#C0322A] bg-[#FFF0EE]' },
  { id: 'store-receipt', level: 'store', title: '分院收货入库', group: '发货、收货与退货', icon: ClipboardCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'store-return', level: 'store', title: '门店退货申请', group: '发货、收货与退货', icon: Undo2, tone: 'text-[#D4820A] bg-[#FFF8E6]' },
  { id: 'store-conversion', level: 'store', title: '门店库存转换', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
]

const GENERIC_OPERATIONS: Record<InventoryBusinessLevel, Array<Omit<OperationDefinition, 'id'> & { id: OperationId }>> = {
  'supply-chain': [
    { id: 'supply-chain-conversion', level: 'supply-chain', title: '内部领用', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]', href: '/inventory/docs?create=内部领用' },
  ],
  market: [
    { id: 'market-conversion', level: 'market', title: '市场间调货', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]', href: '/inventory/docs?create=市场间调货出库' },
    { id: 'market-conversion', level: 'market', title: '市场产品报损', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]', href: '/inventory/docs?create=市场产品报损' },
    { id: 'market-conversion', level: 'market', title: '市场库存盘点', group: '市场特殊业务', icon: ClipboardCheck, tone: 'text-[#7B5E2B] bg-[#FFF8E6]', href: '/inventory/docs?create=市场库存盘点' },
    { id: 'market-conversion', level: 'market', title: '市场产品盘溢', group: '市场特殊业务', icon: PackagePlus, tone: 'text-[#3D8A5A] bg-[#F0F9F2]', href: '/inventory/docs?create=市场产品盘溢' },
  ],
  store: [
    { id: 'store-conversion', level: 'store', title: '门店调拨', group: '发货、收货与退货', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]', href: '/inventory/docs?create=分院调货出库' },
    { id: 'store-conversion', level: 'store', title: '顾客产品出库', group: '发货、收货与退货', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]', href: '/inventory/docs?create=院顾客产品出库' },
    { id: 'store-conversion', level: 'store', title: '顾客产品退货', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#3D8A5A] bg-[#F0F9F2]', href: '/inventory/docs?create=院顾客退货' },
    { id: 'store-conversion', level: 'store', title: '门店产品报损', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]', href: '/inventory/docs?create=院产品报损' },
    { id: 'store-conversion', level: 'store', title: '门店库存盘点', group: '市场特殊业务', icon: ClipboardCheck, tone: 'text-[#7B5E2B] bg-[#FFF8E6]', href: '/inventory/docs?create=分院库存盘点' },
  ],
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
  return `${doc.id} · ${doc.docDate.slice(0, 10)} · ${doc.status}`
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
}: {
  label: string
  children: ReactNode
  className?: string
  required?: boolean
}) {
  return (
    <label className={`space-y-1.5 ${className}`}>
      <span className="block text-sm font-medium">
        {label}
        {required && (
          <>
            <span className="ml-0.5 text-[var(--primary)]" aria-hidden="true">*</span>
            <span className="sr-only">（必填）</span>
          </>
        )}
      </span>
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

function OperationHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-[#FFF0EE] text-[var(--primary)]">
          <Boxes className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <Button type="button" variant="outline" onClick={onClose}>
        关闭
      </Button>
    </div>
  )
}

function DocPicker({
  label,
  docs,
  value,
  onChange,
  disabled = false,
  required = false,
}: {
  label: string
  docs: InventoryDocRow[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
}) {
  return (
    <FormField label={label} required={required}>
      <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">请选择</option>
        {docs.map((doc) => (
          <option key={doc.id} value={doc.id}>{formatDoc(doc)}</option>
        ))}
      </Select>
    </FormField>
  )
}

function SkuPicker({
  value,
  onChange,
  skus,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  skus: InventorySkuRow[]
  disabled?: boolean
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">选择库存商品</option>
      {skus.map((sku) => (
        <option key={sku.skuId} value={sku.skuId}>
          {sku.productName}{sku.specName ? ` · ${sku.specName}` : ''} · {sku.productCode}
        </option>
      ))}
    </Select>
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
  skuOptions,
  suppliers,
  workflowDocs,
  canCreate,
  canApprove,
  canSelfPurchase,
  canRequestShipmentCancellation,
  canApproveShipmentCancellation,
  canViewPrice,
}: {
  level: InventoryBusinessLevel
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canCreate: boolean
  canApprove: boolean
  canSelfPurchase: boolean
  canRequestShipmentCancellation: boolean
  canApproveShipmentCancellation: boolean
  canViewPrice: boolean
}) {
  const router = useRouter()
  const [activeOperation, setActiveOperation] = useState<OperationId | null>(null)
  const levelOperations = useMemo(
    () => [...OPERATIONS.filter((operation) => operation.level === level), ...GENERIC_OPERATIONS[level]],
    [level],
  )
  const active = OPERATIONS.find((operation) => operation.level === level && operation.id === activeOperation) ?? null
  const groups = useMemo(() => Array.from(new Set(levelOperations.map((operation) => operation.group))), [levelOperations])
  const levelMeta = {
    'supply-chain': { title: '供应链库存业务', description: '处理品项公司需求、采购、发货、退货审批和总部库存。' },
    market: { title: '市场库存业务', description: '处理市场采购、门店配货、退货审批及市场特殊库存业务。' },
    store: { title: '门店库存业务', description: '处理门店报货、收货、退货、调拨和日常库存业务。' },
  }[level]

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
                const hasShipmentCancellationAccess = operation.shipmentCancellationAccess === '申请'
                  ? canRequestShipmentCancellation
                  : operation.shipmentCancellationAccess === '审批'
                    ? canApproveShipmentCancellation
                    : true
                const hasSelfPurchaseAccess = !operation.selfPurchaseOnly || canSelfPurchase
                const enabled = (operation.approvalOnly ? canApprove : canCreate)
                  && hasShipmentCancellationAccess
                  && hasSelfPurchaseAccess
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
                if (operation.href) {
                  return (
                    <Link
                      key={operation.href}
                      href={operation.href}
                      className="flex min-h-24 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-sm transition-colors hover:border-[var(--primary)] hover:bg-[#FFFDFC]"
                    >
                      {content}
                    </Link>
                  )
                }
                return (
                  <button
                    key={operation.id}
                    type="button"
                    disabled={!enabled}
                    onClick={() => setActiveOperation(operation.id)}
                    className="flex min-h-24 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-sm transition-colors hover:border-[var(--primary)] hover:bg-[#FFFDFC] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {content}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {active && (
        <Card>
          <CardContent className="p-5">
            <OperationWorkspace
              operation={active.id}
              title={active.title}
              locations={locations}
              skuOptions={skuOptions}
              suppliers={suppliers}
              workflowDocs={workflowDocs}
              canViewPrice={canViewPrice}
              onClose={() => setActiveOperation(null)}
              onSuccess={afterSuccess}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function OperationWorkspace({
  operation,
  title,
  locations,
  skuOptions,
  suppliers,
  workflowDocs,
  canViewPrice,
  onClose,
  onSuccess,
}: {
  operation: OperationId
  title: string
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onClose: () => void
  onSuccess: (message: string) => void
}) {
  return (
    <div className="space-y-5">
      <OperationHeader title={title} onClose={onClose} />
      {/*
        * key：`activeOperation` A→B 时父层元素类型与位置不变，React 原地更新、不重挂，
        * Tabs 的 uncontrolled state 会把「单据」选中态带到下一个业务 ——
        * 点开 B 直接落在 B 的单据页、填报表单被藏起来。加 key 强制重建。
        */}
      <Tabs key={operation} defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">填报表单</TabsTrigger>
          <TabsTrigger value="docs">单据</TabsTrigger>
        </TabsList>
        {/*
          * keepMounted：表单面板切走时只隐藏不卸载。默认的卸载语义会把填了一半的
          * 明细行、选好的批次连同 useState 一起丢掉，用户去「单据」看一眼回来就得重填。
          */}
        <TabsContent value="form" keepMounted className="space-y-5">
          {operation === 'store-request' && <StoreRequestForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
          {operation === 'market-report' && <MarketReportForm locations={locations} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'item-company-request' && <ItemCompanyReplenishmentForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
          {operation === 'purchase-order' && <PurchaseOrderForm locations={locations} suppliers={suppliers} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'supply-chain-purchase-order' && <SupplyChainPurchaseOrderForm locations={locations} suppliers={suppliers} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'company-shipment' && <CompanyShipmentForm locations={locations} workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'market-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="market" onSuccess={onSuccess} />}
          {operation === 'supply-chain-receipt' && <SupplyChainPurchaseReceiptForm locations={locations} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'supply-chain-purchase-cancel' && <SupplyChainPurchaseCancelForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'store-allocation' && <StoreAllocationForm locations={locations} skuOptions={skuOptions} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'store-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="store" onSuccess={onSuccess} />}
          {operation === 'store-return' && <ReturnForm locations={locations} skuOptions={skuOptions} sourceType="门店" onSuccess={onSuccess} />}
          {operation === 'market-return' && <ReturnForm locations={locations} skuOptions={skuOptions} sourceType="市场" onSuccess={onSuccess} />}
          {operation === 'store-return-approval' && <ReturnApprovalForm workflowDocs={workflowDocs} docType="院退货" onSuccess={onSuccess} />}
          {operation === 'market-return-approval' && <ReturnApprovalForm workflowDocs={workflowDocs} docType="市场退货" onSuccess={onSuccess} />}
          {operation === 'shipment-cancel' && <ShipmentCancellationRequestForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'shipment-cancel-approval' && <ShipmentCancellationApprovalForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
          {operation === 'staff-purchase' && <MarketStaffPurchaseForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
          {operation === 'supply-chain-staff-purchase' && <SupplyChainStaffPurchaseForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
          {operation === 'self-purchase' && <SelfPurchaseForm locations={locations} skuOptions={skuOptions} suppliers={suppliers} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
          {operation === 'external-outbound' && <ExternalOutboundForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
          {operation === 'supply-chain-conversion' && <ConversionForm locations={locations} skuOptions={skuOptions} locationType="总部" onSuccess={onSuccess} />}
          {operation === 'market-conversion' && <ConversionForm locations={locations} skuOptions={skuOptions} locationType="市场" onSuccess={onSuccess} />}
          {operation === 'store-conversion' && <ConversionForm locations={locations} skuOptions={skuOptions} locationType="门店" onSuccess={onSuccess} />}
        </TabsContent>
        <TabsContent value="docs">
          <OperationDocsTab operation={operation} canViewPrice={canViewPrice} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

const OPERATION_DOCS_PAGE_SIZE = 20

/**
 * 业务工作区的「单据」Tab（#190）：显示**本业务产出的**、当前账号可见的单据。
 *
 * 单据类型 / 状态 / 层级的收窄规则在服务端按 operationId 查映射表解析
 * （`listInventoryOperationDocs`），这里只管展示与翻页。
 */
function OperationDocsTab({
  operation,
  canViewPrice,
}: {
  operation: OperationId
  canViewPrice: boolean
}) {
  const [rows, setRows] = useState<InventoryDocRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(OPERATION_DOCS_PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [priceVisible, setPriceVisible] = useState(canViewPrice)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    listInventoryOperationDocs({ operationId: operation, page, pageSize: OPERATION_DOCS_PAGE_SIZE })
      .then((result) => {
        if (cancelled) return
        setRows(result.data)
        setTotal(result.total)
        // 服务端会把非白名单页长夹成 20，按它返回的实际值渲染分页器，
        // 否则前端按自己那份 pageSize 算总页数，最后几页会翻不到。
        setPageSize(result.pageSize)
        setPriceVisible(result.canViewPrice)
      })
      .catch((error) => {
        if (cancelled) return
        // 刻意**不清零 total**：清了会让 Pagination 算出 totalPages=1，
        // 越界自纠 effect 把用户从第 3 页静默弹回第 1 页并再发一次请求 ——
        // 一次瞬时失败被放大成「跳页 + 重复请求 + 第二条 toast」。
        setRows([])
        // 失败态与空态必须分开：都渲染成「暂无单据」会让人以为这个业务真的没单，
        // 而实际上是这次没取到。
        setFailed(true)
        toast.error(actionErrorMessage(error, '加载单据失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [operation, page])

  const columns: Column<InventoryDocRow>[] = [
    {
      key: 'id',
      header: '单据号',
      /*
       * 新标签打开，且**不做整行点击**：keepMounted 的全部意义就是「去单据 Tab 看一眼
       * 回来表单还在」，行内 router.push 会把整个办理台连同填了一半的明细一起卸载，
       * 而 returnTo 那套只能恢复 URL、恢复不了 React state。
       */
      cell: (row) => (
        <a
          href={`/inventory/docs/${row.id}`}
          target="_blank"
          rel="noopener noreferrer"
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
     * 代价是有 12 个业务（退货 / 转换 / 发货 / 报货）产出的单据本就不带金额，会多一列全是「—」；
     * 那要靠「docType → 有无金额语义」的单源来治（engine 侧同样缺，见 PR 的 follow-up）。
     */
    ...(priceVisible
      ? [{ key: 'totalAmount', header: '金额', cell: (row: InventoryDocRow) => row.totalAmount ?? '—' } as Column<InventoryDocRow>]
      : []),
    {
      key: 'status',
      header: '状态',
      cell: (row) => (
        <span className={row.status === '已完成' ? 'text-[#3D8A5A]' : row.status === '已驳回' ? 'text-[#888888]' : 'text-[#D4820A]'}>
          {row.status}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        data={rows}
        loading={loading}
        emptyText={failed ? '单据加载失败，请切换 Tab 或稍后重试' : '暂无单据'}
      />
      <Pagination total={total} page={page} pageSize={pageSize} onPageChange={setPage} />
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
  skuOptions,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
    setMarketId(store?.parentLocationId ?? '')
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
          <Select value={storeId} onChange={(event) => selectStore(event.target.value)}>
            <option value="">请选择门店</option>
            {stores.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="所属市场" required>
          <Select value={marketId} onChange={(event) => setMarketId(event.target.value)}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
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
            <FormField label="商品" required>
              <SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId })} skus={skuOptions} />
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
  skuOptions,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const supplyChainSkus = skuOptions.filter((sku) => sku.sourceType === '供应链')
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
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
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
            <FormField label="供应链商品" required><SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId })} skus={supplyChainSkus} /></FormField>
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
          <Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines([]); setQuoteResult(null) }}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="供应链库存主体" required>
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
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
                  return (
                    <tr key={line.skuId} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2"><input type="checkbox" checked={line.selected} onChange={(event) => updateLine(index, { selected: event.target.checked })} /></td>
                      <td className="px-3 py-2"><div className="font-medium">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || line.skuId}</div></td>
                      <td className="px-3 py-2">{line.requestQuantity}</td>
                      <td className="px-3 py-2">{line.availableQuantity}</td>
                      <td className="px-3 py-2">{line.suggestedPurchaseQuantity}</td>
                      <td className="px-3 py-2"><Input className="w-24" type="number" min="0" step="0.01" max="9999999999.99" value={line.purchaseQuantity} onChange={(event) => updateLine(index, { purchaseQuantity: event.target.value })} disabled={!line.selected} /></td>
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
                                <Select
                                  value={currentQuote.promotionPlanId ?? ''}
                                  onChange={(event) => void selectPromotion(line.skuId, event.target.value)}
                                  disabled={quoting}
                                  aria-label={`${line.skuName}福利方案`}
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

function PurchaseOrderForm({
  locations,
  suppliers,
  workflowDocs,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [supplierId, setSupplierId] = useState('')
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<DocumentQuantityLine[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSupplyChainLocationId(doc.targetOrgNodeId ?? '')
    setLines(doc.items.filter(hasAvailableQuantity).map((item) => ({
      sourceItemId: item.id,
      skuName: item.skuName,
      specName: item.specName,
      quantity: String(Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))),
    })))
  }, [doc])

  function updateLine(index: number, patch: Partial<DocumentQuantityLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !supplierId || !supplyChainLocationId) {
      toast.error('请选择市场报货单、供应商和供应链库存主体')
      return
    }
    const items = lines.map((line) => ({
      marketReportItemId: line.sourceItemId,
      quantity: positiveNumber(line.quantity),
    })).filter((line) => line.quantity !== null)
    if (items.length === 0) {
      toast.error('请填写至少一条采购数量')
      return
    }
    setSaving(true)
    try {
      const result = await createPurchaseOrderFromMarketReplenishment({
        marketReportId: doc.id,
        supplierId,
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`采购订单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建采购订单失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, '市场报货')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="市场报货单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="供应商" required>
          <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">请选择供应商</option>
            {suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}
          </Select>
        </FormField>
        <FormField label="供应链库存主体" required>
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="订单日期">
          <DatePicker value={docDate} onValueChange={setDocDate} />
        </FormField>
      </div>

      {loading && <div className="text-sm text-[#666666]">正在加载市场报货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">本次下单数量</h3>
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={line.sourceItemId} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_10rem]">
                <div><div className="font-medium text-sm">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || `明细 #${line.sourceItemId}`}</div></div>
                <FormField label="采购数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              </div>
            ))}
          </div>
        </div>
      )}

      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>创建采购订单</Button></div>
    </form>
  )
}

function SupplyChainPurchaseOrderForm({
  locations,
  suppliers,
  workflowDocs,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [supplierId, setSupplierId] = useState('')
  const [supplyChainLocationId, setSupplyChainLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<DocumentQuantityLine[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSupplyChainLocationId(doc.targetOrgNodeId ?? '')
    setLines(doc.items.filter(hasAvailableQuantity).map((item) => ({
      sourceItemId: item.id,
      skuName: item.skuName,
      specName: item.specName,
      quantity: String(Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))),
    })))
  }, [doc])

  function updateLine(index: number, patch: Partial<DocumentQuantityLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !supplierId || !supplyChainLocationId) {
      toast.error('请选择品项公司报货需求、供应商和供应链库存主体')
      return
    }
    const items = lines.map((line) => ({
      companyRequestItemId: line.sourceItemId,
      quantity: positiveNumber(line.quantity),
    })).filter((line) => line.quantity !== null)
    if (items.length === 0) {
      toast.error('请填写至少一条采购数量')
      return
    }
    setSaving(true)
    try {
      const result = await createPurchaseOrderFromItemCompanyReplenishment({
        companyRequestId: doc.id,
        supplierId,
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`供应链采购订单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建供应链采购订单失败'))
    } finally {
      setSaving(false)
    }
  }

  const candidates = docCandidates(workflowDocs, '品项公司报货需求')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="品项公司报货需求" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="供应商" required>
          <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">请选择供应商</option>
            {suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}
          </Select>
        </FormField>
        <FormField label="供应链库存主体" required>
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="订单日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载品项公司报货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">本次下单数量</h3>
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={line.sourceItemId} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_10rem]">
                <div><div className="font-medium text-sm">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || `明细 #${line.sourceItemId}`}</div></div>
                <FormField label="采购数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              </div>
            ))}
          </div>
        </div>
      )}
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>创建供应链采购订单</Button></div>
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
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSourceOrgNodeId(doc.targetOrgNodeId ?? '')
    setLines(doc.items.map((item) => {
      const remaining = remainingQuantity(item)
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
  }, [doc])

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
        <DocPicker label="采购订单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="发货总部" required>
          <Select value={sourceOrgNodeId} onChange={(event) => setSourceOrgNodeId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.filter((location) => location.orgNodeId).map((location) => <option key={location.orgNodeId!} value={location.orgNodeId!}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="发货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
        <FormField label="物流公司"><Input value={logisticsCompany} onChange={(event) => setLogisticsCompany(event.target.value)} /></FormField>
        <FormField label="物流单号"><Input value={trackingNo} onChange={(event) => setTrackingNo(event.target.value)} /></FormField>
      </div>

      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
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
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  kind: 'market' | 'store'
  onSuccess: (message: string) => void
}) {
  const docType = kind === 'market' ? '品项公司发货' : '分院配货'
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
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
        <DocPicker label={kind === 'market' ? '品项公司发货单' : '分院配货单'} docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} required />
        <FormField label="收货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {(loading || loadingProgress) && <div className="text-sm text-[#666666]">正在加载待收货明细</div>}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]"><tr><th className="px-3 py-2 font-medium">商品</th><th className="px-3 py-2 font-medium">发货</th><th className="px-3 py-2 font-medium">已收</th><th className="px-3 py-2 font-medium">待收</th><th className="px-3 py-2 font-medium">本次实收</th><th className="px-3 py-2 font-medium">明细备注</th></tr></thead>
            <tbody>{lines.map((line, index) => <tr key={line.shipmentItemId} className="border-t border-[var(--border)]"><td className="px-3 py-2"><div className="font-medium">{line.skuName}</div>{line.isGift && <Badge variant="outline" className="mt-1 text-[10px]">赠送</Badge>}</td><td className="px-3 py-2">{line.shippedQuantity}</td><td className="px-3 py-2">{line.receivedQuantity}</td><td className="px-3 py-2">{line.outstandingQuantity}</td><td className="px-3 py-2"><Input className="w-24" type="number" min="0" step="0.01" max="9999999999.99" value={line.receivedInput} onChange={(event) => updateLine(index, { receivedInput: event.target.value })} /></td><td className="px-3 py-2"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></td></tr>)}</tbody>
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
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  workflowDocs: InventoryDocRow[]
  canViewPrice: boolean
  onSuccess: (message: string) => void
}) {
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
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
      toast.error('请选择待收货的供应链采购订单')
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

  const candidates = docCandidates(workflowDocs, '供应链采购订单', '待收货')
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DocPicker label="供应链采购订单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="供应链库存主体" required>
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)} disabled={Boolean(doc)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="入库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载供应链采购订单明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">本次实收入库</h3>
          {lines.map((line, index) => (
            <div key={line.purchaseOrderItemId} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-5">
              <div><div className="font-medium text-sm">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || `明细 #${line.purchaseOrderItemId}`}</div></div>
              <FormField label="实收数量"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              <FormField label="批号"><Input value={line.batchNo} onChange={(event) => updateLine(index, { batchNo: event.target.value })} /></FormField>
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
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = docCandidates(workflowDocs, '供应链采购订单', '待收货')

  async function submit() {
    if (saving) return
    if (!doc || !reason.trim()) {
      toast.error('请选择待收货的供应链采购订单并填写关闭原因')
      return
    }
    setSaving(true)
    try {
      await cancelSupplyChainPurchaseOrder({
        purchaseOrderId: doc.id,
        cancellationReason: reason.trim(),
      })
      onSuccess('供应链采购订单已关闭，未收数量已释放')
    } catch (error) {
      toast.error(actionErrorMessage(error, '关闭供应链采购订单失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <DocPicker label="待收货供应链采购订单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <FormField label="关闭原因" required><Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>
      <div className="flex justify-end">
        <Button type="button" variant="destructive" loading={saving} onClick={() => void submit()} disabled={!doc}>关闭供应链采购订单</Button>
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
  skuOptions,
  workflowDocs,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
  const skuById = useMemo(() => new Map(skuOptions.map((sku) => [sku.skuId, sku])), [skuOptions])

  useEffect(() => {
    if (!doc) {
      setLines([])
      return
    }
    setSourceMarketId(doc.marketId ?? doc.targetOrgNodeId ?? '')
    setLines(doc.items.map((item) => {
      const sku = skuById.get(item.skuId)
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
    }))
  }, [doc, skuById])

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
        <DocPicker label="门店报货单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="配货市场" required>
          <Select value={sourceMarketId} onChange={(event) => setSourceMarketId(event.target.value)}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
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
  skuOptions,
  sourceType,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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

  const targets = source?.locationType === '门店'
    ? locations.filter((location) => location.orgNodeId === source.parentLocationId)
    : headquarters
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="退货主体" required>
          <Select value={sourceOrgNodeId} onChange={(event) => selectSource(event.target.value)}>
            <option value="">请选择{sourceType}</option>
            {sourceLocations.filter((location) => location.orgNodeId).map((location) => <option key={location.orgNodeId!} value={location.orgNodeId!}>{location.locationType} · {location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="回库主体" required>
          <Select value={targetOrgNodeId} onChange={(event) => setTargetOrgNodeId(event.target.value)}>
            <option value="">请选择回库主体</option>
            {targets.filter((location) => location.orgNodeId).map((location) => <option key={location.orgNodeId!} value={location.orgNodeId!}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="退货日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">退货批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem]">
            <FormField label="商品" required><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField>
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待审批退货单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} /></div>
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待收货品项公司发货单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} /></div>
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
        <DocPicker label="待审批品项公司发货单" required docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
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
  skuOptions,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
      if (employeeRequestRef.current === requestId) {
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
        <FormField label="供应链总部" required><Select value={locationId} onChange={(event) => void selectLocation(event.target.value)}><option value="">请选择供应链总部</option>{headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField>
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
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="供应链批次" required><LotPicker locationId={locationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建供应链员工购出库单</Button></div>
    </form>
  )
}

function MarketStaffPurchaseForm({
  locations,
  skuOptions,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
      if (employeeRequestRef.current === requestId) {
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
        <FormField label="市场" required><Select value={marketId} onChange={(event) => void selectMarket(event.target.value)}><option value="">请选择市场</option>{markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField>
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
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="市场批次" required><LotPicker locationId={marketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
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
  skuOptions,
  suppliers,
  canViewPrice,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
  const eligibleSkus = skuOptions.filter((sku) => !marketId || (sku.sourceType !== '供应链' && sku.ownerMarketId === marketId))

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
        <FormField label="入库市场" required><Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, skuId: '' }))) }}><option value="">请选择市场</option>{markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField>
        <FormField label="供应商" required><Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">请选择供应商</option>{suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}</Select></FormField>
        <FormField label="入库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
        <FormField label="收据附件地址" className="md:col-span-2"><Input value={receiptAttachmentUrl} onChange={(event) => setReceiptAttachmentUrl(event.target.value)} placeholder="填写附件地址" /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">自采入库明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', quantity: '1', batchNo: '', expiryDate: '', isGift: false, marketActualUnitPrice: '', storeUnitDiscount: '0', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className={`grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 ${canViewPrice ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}><FormField label="自采商品" required><SkuPicker value={line.skuId} skus={eligibleSkus} onChange={(skuId) => updateLine(index, { skuId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="批号"><Input value={line.batchNo} onChange={(event) => updateLine(index, { batchNo: event.target.value })} /></FormField><FormField label="效期"><DatePicker value={line.expiryDate} onValueChange={(value) => updateLine(index, { expiryDate: value })} /></FormField><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={line.isGift} onChange={(event) => updateLine(index, { isGift: event.target.checked })} />赠送</label>{canViewPrice && <><FormField label="实际采购单价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.marketActualUnitPrice} onChange={(event) => updateLine(index, { marketActualUnitPrice: event.target.value })} placeholder="资料价或本次价格" /></FormField><FormField label="门店单价优惠"><Input type="number" min="0" step="0.01" max="9999999999.99" value={line.storeUnitDiscount} onChange={(event) => updateLine(index, { storeUnitDiscount: event.target.value })} /></FormField></>}<FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建自采产品入库单</Button></div>
    </form>
  )
}

function ExternalOutboundForm({
  locations,
  skuOptions,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3"><FormField label="供应链库存主体" required><Select value={locationId} onChange={(event) => { setLocationId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, lotId: '' }))) }}><option value="">请选择供应链库存主体</option>{headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField><FormField label="外部对象" required><Input value={externalPartyName} onChange={(event) => setExternalPartyName(event.target.value)} /></FormField><FormField label="出库日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField></div>
      <div className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">出库批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>{lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品" required><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="供应链批次" required><LotPicker locationId={locationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}</div>
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
  skuOptions,
  locationType,
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  locationType: InventoryLocationRow['locationType']
  onSuccess: (message: string) => void
}) {
  const availableLocations = locations.filter((location) => location.locationType === locationType && location.isActive)
  const [locationId, setLocationId] = useState('')
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
        <FormField label="转换库存主体" required><Select value={locationId} onChange={(event) => { setLocationId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, sourceLotId: '' }))) }}><option value="">请选择{locationType}</option>{availableLocations.map((location) => <option key={location.locationId} value={location.locationId}>{location.locationType} · {location.name}</option>)}</Select></FormField>
        <FormField label="转换日期"><DatePicker value={docDate} onValueChange={setDocDate} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">转换明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { sourceSkuId: '', sourceLotId: '', sourceQuantity: '1', targetSkuId: '', targetQuantity: '1', targetBatchNo: '', targetExpiryDate: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 xl:grid-cols-8"><FormField label="来源商品" required><SkuPicker value={line.sourceSkuId} skus={skuOptions} onChange={(sourceSkuId) => updateLine(index, { sourceSkuId, sourceLotId: '' })} /></FormField><FormField label="来源批次" required><LotPicker locationId={locationId} skuId={line.sourceSkuId} value={line.sourceLotId} onChange={(sourceLotId) => updateLine(index, { sourceLotId })} /></FormField><FormField label="出库数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.sourceQuantity} onChange={(event) => updateLine(index, { sourceQuantity: event.target.value })} /></FormField><FormField label="目标商品" required><SkuPicker value={line.targetSkuId} skus={skuOptions} onChange={(targetSkuId) => updateLine(index, { targetSkuId })} /></FormField><FormField label="入库数量" required><Input type="number" min="0.01" step="0.01" max="9999999999.99" value={line.targetQuantity} onChange={(event) => updateLine(index, { targetQuantity: event.target.value })} /></FormField><FormField label="目标批号"><Input value={line.targetBatchNo} onChange={(event) => updateLine(index, { targetBatchNo: event.target.value })} /></FormField><FormField label="目标效期"><DatePicker value={line.targetExpiryDate} onValueChange={(value) => updateLine(index, { targetExpiryDate: value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div><FormField label="明细备注" className="xl:col-span-7"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建库存转换单</Button></div>
    </form>
  )
}
