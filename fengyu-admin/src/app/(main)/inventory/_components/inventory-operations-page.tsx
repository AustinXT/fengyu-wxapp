'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
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
  approveReturnForRestock,
  cancelItemCompanyShipment,
  createExternalMarketOutbound,
  createInventoryConversion,
  createItemCompanyShipment,
  createMarketReplenishment,
  createMarketStaffPurchase,
  createPurchaseOrderFromMarketReplenishment,
  createReturnForRestock,
  createSelfPurchasedReceipt,
  createStoreAllocation,
  createStoreReplenishmentRequest,
  getShipmentReceiptProgress,
  quoteMarketReplenishmentPrice,
  receiveItemCompanyShipment,
  receiveStoreAllocation,
  rejectReturnForRestock,
  summarizeStoreReplenishmentRequests,
} from '@/actions/inventory/business'
import { getInventoryCoreDocById } from '@/actions/inventory/docs'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'

type OperationId =
  | 'store-request'
  | 'market-report'
  | 'purchase-order'
  | 'company-shipment'
  | 'market-receipt'
  | 'store-allocation'
  | 'store-receipt'
  | 'return'
  | 'return-approval'
  | 'staff-purchase'
  | 'self-purchase'
  | 'external-outbound'
  | 'conversion'
  | 'shipment-cancel'

interface OperationDefinition {
  id: OperationId
  title: string
  group: '需求与采购' | '发货、收货与退货' | '市场特殊业务'
  icon: typeof Boxes
  tone: string
  approvalOnly?: boolean
}

const OPERATIONS: OperationDefinition[] = [
  { id: 'store-request', title: '门店报货', group: '需求与采购', icon: PackagePlus, tone: 'text-[#C0322A] bg-[#FFF0EE]' },
  { id: 'market-report', title: '市场汇总报货', group: '需求与采购', icon: PackageSearch, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'purchase-order', title: '创建采购订单', group: '需求与采购', icon: ShoppingCart, tone: 'text-[#7B5E2B] bg-[#FFF8E6]' },
  { id: 'company-shipment', title: '品项公司发货', group: '发货、收货与退货', icon: Truck, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
  { id: 'market-receipt', title: '市场采购入库', group: '发货、收货与退货', icon: PackageCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'store-allocation', title: '分院配货', group: '发货、收货与退货', icon: Send, tone: 'text-[#8B5A2B] bg-[#FFF5E8]' },
  { id: 'store-receipt', title: '分院收货入库', group: '发货、收货与退货', icon: ClipboardCheck, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'return', title: '创建退货申请', group: '发货、收货与退货', icon: Undo2, tone: 'text-[#D4820A] bg-[#FFF8E6]' },
  { id: 'return-approval', title: '退货审批回库', group: '发货、收货与退货', icon: RotateCcw, tone: 'text-[#D4820A] bg-[#FFF8E6]', approvalOnly: true },
  { id: 'shipment-cancel', title: '撤回品项发货', group: '发货、收货与退货', icon: RefreshCcw, tone: 'text-[#D94040] bg-[#FFF0F0]', approvalOnly: true },
  { id: 'staff-purchase', title: '市场员工购', group: '市场特殊业务', icon: UserRoundCheck, tone: 'text-[#8A4B7A] bg-[#FCF1F9]' },
  { id: 'self-purchase', title: '自采产品入库', group: '市场特殊业务', icon: Warehouse, tone: 'text-[#3D8A5A] bg-[#F0F9F2]' },
  { id: 'external-outbound', title: '非凤御市场出库', group: '市场特殊业务', icon: PackageX, tone: 'text-[#D94040] bg-[#FFF0F0]' },
  { id: 'conversion', title: '库存转换', group: '市场特殊业务', icon: ArrowLeftRight, tone: 'text-[#5E8BB3] bg-[#F0F5FA]' },
]

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
  return item.quantity - (item.fulfilledQuantity ?? 0) > 0.000001
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

function FormField({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`space-y-1.5 ${className}`}>
      <span className="block text-sm font-medium">{label}</span>
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
}: {
  label: string
  docs: InventoryDocRow[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <FormField label={label}>
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
  locations,
  skuOptions,
  suppliers,
  workflowDocs,
  canCreate,
  canApprove,
  canViewPrice,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  suppliers: InventorySupplierRow[]
  workflowDocs: InventoryDocRow[]
  canCreate: boolean
  canApprove: boolean
  canViewPrice: boolean
}) {
  const router = useRouter()
  const [activeOperation, setActiveOperation] = useState<OperationId | null>(null)
  const active = OPERATIONS.find((operation) => operation.id === activeOperation) ?? null
  const groups = useMemo(() => Array.from(new Set(OPERATIONS.map((operation) => operation.group))), [])

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
            <h1 className="text-xl font-medium">库存业务流程</h1>
            <p className="mt-1 text-sm text-[#666666]">按业务单据关系完成报货、发货、收货、配货和库存调整。</p>
          </div>
        </div>
        <Button type="button" variant="outline" onClick={() => router.push('/inventory/docs')}>
          查看库存单据
        </Button>
      </div>

      {!canCreate && !canApprove && (
        <div className="border border-[#F2D7D4] bg-[#FFF8F7] px-4 py-3 text-sm text-[#9F2D27]">
          当前账号没有库存操作权限。
        </div>
      )}

      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group} className="space-y-3">
            <h2 className="text-sm font-medium text-[#555555]">{group}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {OPERATIONS.filter((operation) => operation.group === group).map((operation) => {
                const Icon = operation.icon
                const enabled = operation.approvalOnly ? canApprove : canCreate
                return (
                  <button
                    key={operation.id}
                    type="button"
                    disabled={!enabled}
                    onClick={() => setActiveOperation(operation.id)}
                    className="flex min-h-24 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-sm transition-colors hover:border-[var(--primary)] hover:bg-[#FFFDFC] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className={`flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] ${operation.tone}`}>
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{operation.title}</span>
                      {operation.approvalOnly && <Badge variant="outline" className="mt-1 text-[10px]">审批权限</Badge>}
                    </span>
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
      {operation === 'store-request' && <StoreRequestForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
      {operation === 'market-report' && <MarketReportForm locations={locations} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
      {operation === 'purchase-order' && <PurchaseOrderForm locations={locations} suppliers={suppliers} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
      {operation === 'company-shipment' && <CompanyShipmentForm locations={locations} workflowDocs={workflowDocs} onSuccess={onSuccess} />}
      {operation === 'market-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="market" onSuccess={onSuccess} />}
      {operation === 'store-allocation' && <StoreAllocationForm locations={locations} workflowDocs={workflowDocs} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
      {operation === 'store-receipt' && <ShipmentReceiptForm workflowDocs={workflowDocs} kind="store" onSuccess={onSuccess} />}
      {operation === 'return' && <ReturnForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
      {operation === 'return-approval' && <ReturnApprovalForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
      {operation === 'shipment-cancel' && <ShipmentCancelForm workflowDocs={workflowDocs} onSuccess={onSuccess} />}
      {operation === 'staff-purchase' && <MarketStaffPurchaseForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
      {operation === 'self-purchase' && <SelfPurchaseForm locations={locations} skuOptions={skuOptions} suppliers={suppliers} canViewPrice={canViewPrice} onSuccess={onSuccess} />}
      {operation === 'external-outbound' && <ExternalOutboundForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
      {operation === 'conversion' && <ConversionForm locations={locations} skuOptions={skuOptions} onSuccess={onSuccess} />}
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
        <FormField label="报货门店">
          <Select value={storeId} onChange={(event) => selectStore(event.target.value)}>
            <option value="">请选择门店</option>
            {stores.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="所属市场">
          <Select value={marketId} onChange={(event) => setMarketId(event.target.value)}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="报货日期">
          <Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} />
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
            <FormField label="商品">
              <SkuPicker value={line.skuId} onChange={(skuId) => updateLine(index, { skuId })} skus={skuOptions} />
            </FormField>
            <FormField label="数量">
              <Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} />
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
  const [quotes, setQuotes] = useState<Record<string, { standard: number; discount: number; actual: number; plan: string | null }>>({})
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<MarketReportLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

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
      setQuotes({})
      setLines(summary.items.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        specName: item.specName,
        requestItemIds: item.requestItemIds,
        requestQuantity: item.outstandingQuantity,
        availableQuantity: item.availableQuantity,
        suggestedPurchaseQuantity: item.suggestedPurchaseQuantity,
        selected: true,
        purchaseQuantity: String(item.suggestedPurchaseQuantity || item.outstandingQuantity),
      })))
      if (summary.items.length === 0) toast.info('当前没有待汇总的门店报货明细')
    } catch (error) {
      toast.error(actionErrorMessage(error, '汇总门店报货失败'))
    } finally {
      setLoadingSummary(false)
    }
  }

  async function quote(index: number) {
    const line = lines[index]
    const quantity = positiveNumber(line.purchaseQuantity)
    if (!quantity || !marketId) {
      toast.error('请先填写实际采购数量')
      return
    }
    try {
      const result = await quoteMarketReplenishmentPrice({ marketId, skuId: line.skuId, quantity, docDate: optionalText(docDate) })
      setQuotes((previous) => ({
        ...previous,
        [line.skuId]: {
          standard: result.marketStandardUnitPrice,
          discount: result.marketUnitDiscount,
          actual: result.marketActualUnitPrice,
          plan: result.promotionPlanNo ? `${result.promotionPlanNo}${result.promotionName ? ` · ${result.promotionName}` : ''}` : null,
        },
      }))
    } catch (error) {
      toast.error(actionErrorMessage(error, '获取福利报价失败'))
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
    setSaving(true)
    try {
      const result = await createMarketReplenishment({
        marketId,
        supplyChainLocationId,
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, purchaseQuantity: item.purchaseQuantity! })),
      })
      onSuccess(`市场报货单已创建：${result.id}`)
      setLines([])
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建市场报货失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <FormField label="市场">
          <Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines([]); setQuotes({}) }}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="供应链库存主体">
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="汇总开始日期">
          <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </FormField>
        <FormField label="汇总结束日期">
          <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </FormField>
        <div className="flex items-end">
          <Button type="button" variant="outline" loading={loadingSummary} onClick={loadSummary} className="w-full">汇总门店报货</Button>
        </div>
      </div>
      <FormField label="报货日期" className="max-w-xs">
        <Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} />
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
                  const currentQuote = quotes[line.skuId]
                  return (
                    <tr key={line.skuId} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2"><input type="checkbox" checked={line.selected} onChange={(event) => updateLine(index, { selected: event.target.checked })} /></td>
                      <td className="px-3 py-2"><div className="font-medium">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || line.skuId}</div></td>
                      <td className="px-3 py-2">{line.requestQuantity}</td>
                      <td className="px-3 py-2">{line.availableQuantity}</td>
                      <td className="px-3 py-2">{line.suggestedPurchaseQuantity}</td>
                      <td className="px-3 py-2"><Input className="w-24" inputMode="decimal" value={line.purchaseQuantity} onChange={(event) => updateLine(index, { purchaseQuantity: event.target.value })} disabled={!line.selected} /></td>
                      {canViewPrice && (
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => void quote(index)} disabled={!line.selected}>取价</Button>
                            {currentQuote && <span className="text-xs text-[#666666]">{currentQuote.standard} - {currentQuote.discount} = {currentQuote.actual}{currentQuote.plan ? ` · ${currentQuote.plan}` : ''}</span>}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
    setSupplyChainLocationId(doc.targetLocationId ?? '')
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
        <DocPicker label="市场报货单" docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="供应商">
          <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">请选择供应商</option>
            {suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}
          </Select>
        </FormField>
        <FormField label="供应链库存主体">
          <Select value={supplyChainLocationId} onChange={(event) => setSupplyChainLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="订单日期">
          <Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} />
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
                <FormField label="采购数量"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
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

interface ShipmentDraftLine {
  purchaseOrderItemId: number
  skuId: string
  skuName: string
  specName: string | null
  lotId: string
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
  const [sourceLocationId, setSourceLocationId] = useState('')
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
    setSourceLocationId(doc.targetLocationId ?? '')
    setLines(doc.items.filter(hasAvailableQuantity).map((item) => ({
      purchaseOrderItemId: item.id,
      skuId: item.skuId,
      skuName: item.skuName,
      specName: item.specName,
      lotId: '',
      quantity: String(Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))),
      giftQuantity: '0',
      remark: '',
    })))
  }, [doc])

  function updateLine(index: number, patch: Partial<ShipmentDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!doc || !sourceLocationId) {
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
        sourceLocationId,
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
        <DocPicker label="采购订单" docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="发货总部">
          <Select value={sourceLocationId} onChange={(event) => setSourceLocationId(event.target.value)}>
            <option value="">请选择总部</option>
            {headquarters.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="发货日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
        <FormField label="物流公司"><Input value={logisticsCompany} onChange={(event) => setLogisticsCompany(event.target.value)} /></FormField>
        <FormField label="物流单号"><Input value={trackingNo} onChange={(event) => setTrackingNo(event.target.value)} /></FormField>
      </div>

      {loading && <div className="text-sm text-[#666666]">正在加载采购订单明细</div>}
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">发货批次与数量</h3>
          {lines.map((line, index) => (
            <div key={line.purchaseOrderItemId} className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-5">
              <div><div className="text-sm font-medium">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || line.skuId}</div></div>
              <FormField label="发货批次"><LotPicker locationId={sourceLocationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
              <FormField label="正常发货"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              <FormField label="赠送数量"><Input inputMode="decimal" value={line.giftQuantity} onChange={(event) => updateLine(index, { giftQuantity: event.target.value })} /></FormField>
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
        <DocPicker label={kind === 'market' ? '品项公司发货单' : '分院配货单'} docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="收货日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
      </div>
      {(loading || loadingProgress) && <div className="text-sm text-[#666666]">正在加载待收货明细</div>}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]"><tr><th className="px-3 py-2 font-medium">商品</th><th className="px-3 py-2 font-medium">发货</th><th className="px-3 py-2 font-medium">已收</th><th className="px-3 py-2 font-medium">待收</th><th className="px-3 py-2 font-medium">本次实收</th><th className="px-3 py-2 font-medium">明细备注</th></tr></thead>
            <tbody>{lines.map((line, index) => <tr key={line.shipmentItemId} className="border-t border-[var(--border)]"><td className="px-3 py-2"><div className="font-medium">{line.skuName}</div>{line.isGift && <Badge variant="outline" className="mt-1 text-[10px]">赠送</Badge>}</td><td className="px-3 py-2">{line.shippedQuantity}</td><td className="px-3 py-2">{line.receivedQuantity}</td><td className="px-3 py-2">{line.outstandingQuantity}</td><td className="px-3 py-2"><Input className="w-24" inputMode="decimal" value={line.receivedInput} onChange={(event) => updateLine(index, { receivedInput: event.target.value })} /></td><td className="px-3 py-2"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></td></tr>)}</tbody>
          </table>
        </div>
      )}
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving} disabled={!doc || lines.length === 0}>登记本次实收</Button></div>
    </form>
  )
}

interface StoreAllocationDraftLine {
  requestItemId: number
  skuId: string
  skuName: string
  specName: string | null
  lotId: string
  quantity: string
  giftQuantity: string
  storeUnitDiscount: string
  remark: string
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
    setSourceMarketId(doc.marketId ?? doc.targetLocationId ?? '')
    setLines(doc.items.filter(hasAvailableQuantity).map((item) => ({
      requestItemId: item.id,
      skuId: item.skuId,
      skuName: item.skuName,
      specName: item.specName,
      lotId: '',
      quantity: String(Math.max(0, item.quantity - (item.fulfilledQuantity ?? 0))),
      giftQuantity: '0',
      storeUnitDiscount: '0',
      remark: '',
    })))
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
        <DocPicker label="门店报货单" docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} />
        <FormField label="配货市场">
          <Select value={sourceMarketId} onChange={(event) => setSourceMarketId(event.target.value)}>
            <option value="">请选择市场</option>
            {markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="配货日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
      </div>
      {loading && <div className="text-sm text-[#666666]">正在加载门店报货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={canViewPrice} />
      {lines.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">配货批次与数量</h3>
          {lines.map((line, index) => (
            <div key={line.requestItemId} className={`grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3 ${canViewPrice ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}>
              <div><div className="text-sm font-medium">{line.skuName}</div><div className="text-xs text-[#888888]">{line.specName || line.skuId}</div></div>
              <FormField label="市场批次"><LotPicker locationId={sourceMarketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
              <FormField label="正常配货"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
              <FormField label="赠送数量"><Input inputMode="decimal" value={line.giftQuantity} onChange={(event) => updateLine(index, { giftQuantity: event.target.value })} /></FormField>
              {canViewPrice && <FormField label="门店单价优惠"><Input inputMode="decimal" value={line.storeUnitDiscount} onChange={(event) => updateLine(index, { storeUnitDiscount: event.target.value })} /></FormField>}
              <FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField>
            </div>
          ))}
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
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: (message: string) => void
}) {
  const sourceLocations = locations.filter((location) => (location.locationType === '门店' || location.locationType === '市场') && location.isActive)
  const headquarters = locations.filter((location) => location.locationType === '总部' && location.isActive)
  const [sourceLocationId, setSourceLocationId] = useState('')
  const [targetLocationId, setTargetLocationId] = useState('')
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)
  const source = sourceLocations.find((location) => location.locationId === sourceLocationId)

  function selectSource(nextSourceId: string) {
    setSourceLocationId(nextSourceId)
    const nextSource = sourceLocations.find((location) => location.locationId === nextSourceId)
    if (nextSource?.locationType === '门店') setTargetLocationId(nextSource.parentLocationId ?? '')
    if (nextSource?.locationType === '市场') setTargetLocationId(headquarters[0]?.locationId ?? '')
    setLines((previous) => previous.map((line) => ({ ...line, lotId: '' })))
  }

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!sourceLocationId || !targetLocationId) {
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
        sourceLocationId,
        targetLocationId,
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
    ? locations.filter((location) => location.locationId === source.parentLocationId)
    : headquarters
  return (
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FormField label="退货主体">
          <Select value={sourceLocationId} onChange={(event) => selectSource(event.target.value)}>
            <option value="">请选择门店或市场</option>
            {sourceLocations.map((location) => <option key={location.locationId} value={location.locationId}>{location.locationType} · {location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="回库主体">
          <Select value={targetLocationId} onChange={(event) => setTargetLocationId(event.target.value)}>
            <option value="">请选择回库主体</option>
            {targets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}
          </Select>
        </FormField>
        <FormField label="退货日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">退货批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem]">
            <FormField label="商品"><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField>
            <FormField label="来源批次"><LotPicker locationId={sourceLocationId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField>
            <FormField label="数量"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField>
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
  onSuccess,
}: {
  workflowDocs: InventoryDocRow[]
  onSuccess: (message: string) => void
}) {
  const { docId, doc, loading, selectDocument } = useLoadedDocument()
  const [auditRemark, setAuditRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const candidates = workflowDocs.filter((row) => (row.docType === '院退货' || row.docType === '市场退货') && row.status === '待审批')

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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待审批退货单" docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} /></div>
      {loading && <div className="text-sm text-[#666666]">正在加载退货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <RemarkField value={auditRemark} onChange={setAuditRemark} />
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" loading={saving} onClick={() => void reject()} disabled={!doc}>驳回退货</Button><Button type="button" loading={saving} onClick={() => void approve()} disabled={!doc}>审批并回库</Button></div>
    </div>
  )
}

function ShipmentCancelForm({
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
      await cancelItemCompanyShipment({ shipmentId: doc.id, cancellationReason: reason.trim() })
      onSuccess('品项公司发货单已撤回')
    } catch (error) {
      toast.error(actionErrorMessage(error, '撤回品项公司发货失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><DocPicker label="待收货品项公司发货单" docs={candidates} value={docId} onChange={(id) => void selectDocument(id)} /></div>
      {loading && <div className="text-sm text-[#666666]">正在加载发货明细</div>}
      <SourceDocumentItems doc={doc} canViewPrice={false} />
      <FormField label="撤回原因"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></FormField>
      <div className="flex justify-end"><Button type="button" variant="destructive" loading={saving} onClick={() => void submit()} disabled={!doc}>撤回品项公司发货</Button></div>
    </div>
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
  const [docDate, setDocDate] = useState(today)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<LotDraftLine[]>([{ skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])
  const [saving, setSaving] = useState(false)

  function updateLine(index: number, patch: Partial<LotDraftLine>) {
    setLines((previous) => previous.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line))
  }

  async function submit() {
    if (saving) return
    if (!marketId || !employeeId.trim()) {
      toast.error('请选择市场并填写购买员工 ID')
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
        employeeId: employeeId.trim(),
        docDate: optionalText(docDate),
        remark: optionalText(remark),
        items: items.map((item) => ({ ...item, quantity: item.quantity! })),
      })
      onSuccess(`市场员工购出库单已创建：${result.id}`)
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
        <FormField label="市场"><Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, lotId: '' }))) }}><option value="">请选择市场</option>{markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField>
        <FormField label="购买员工 ID"><Input value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="输入员工 ID" /></FormField>
        <FormField label="出库日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">员工购批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品"><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="市场批次"><LotPicker locationId={marketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
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
  const [supplierName, setSupplierName] = useState('')
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
    if (!marketId || (!supplierId && !supplierName.trim())) {
      toast.error('请选择市场并填写自采供应商')
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
        supplierId: optionalText(supplierId),
        supplierName: supplierId ? null : optionalText(supplierName),
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
        <FormField label="入库市场"><Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, skuId: '' }))) }}><option value="">请选择市场</option>{markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField>
        <FormField label="供应商"><Select value={supplierId} onChange={(event) => { setSupplierId(event.target.value); if (event.target.value) setSupplierName('') }}><option value="">手填供应商</option>{suppliers.map((supplier) => <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.name}</option>)}</Select></FormField>
        {!supplierId && <FormField label="自采供应商名称"><Input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /></FormField>}
        <FormField label="入库日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
        <FormField label="收据附件地址" className="md:col-span-2"><Input value={receiptAttachmentUrl} onChange={(event) => setReceiptAttachmentUrl(event.target.value)} placeholder="填写附件地址" /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">自采入库明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', quantity: '1', batchNo: '', expiryDate: '', isGift: false, marketActualUnitPrice: '', storeUnitDiscount: '0', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className={`grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 ${canViewPrice ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}><FormField label="自采商品"><SkuPicker value={line.skuId} skus={eligibleSkus} onChange={(skuId) => updateLine(index, { skuId })} /></FormField><FormField label="数量"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="批号"><Input value={line.batchNo} onChange={(event) => updateLine(index, { batchNo: event.target.value })} /></FormField><FormField label="效期"><Input type="date" value={line.expiryDate} onChange={(event) => updateLine(index, { expiryDate: event.target.value })} /></FormField><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={line.isGift} onChange={(event) => updateLine(index, { isGift: event.target.checked })} />赠送</label>{canViewPrice && <><FormField label="实际采购单价"><Input inputMode="decimal" value={line.marketActualUnitPrice} onChange={(event) => updateLine(index, { marketActualUnitPrice: event.target.value })} placeholder="资料价或本次价格" /></FormField><FormField label="门店单价优惠"><Input inputMode="decimal" value={line.storeUnitDiscount} onChange={(event) => updateLine(index, { storeUnitDiscount: event.target.value })} /></FormField></>}<FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}
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
  const markets = locations.filter((location) => location.locationType === '市场' && location.isActive)
  const [marketId, setMarketId] = useState('')
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
    if (!marketId || !externalPartyName.trim()) {
      toast.error('请选择市场并填写外部对象')
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
        marketId,
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
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3"><FormField label="市场"><Select value={marketId} onChange={(event) => { setMarketId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, lotId: '' }))) }}><option value="">请选择市场</option>{markets.map((location) => <option key={location.locationId} value={location.locationId}>{location.name}</option>)}</Select></FormField><FormField label="外部对象"><Input value={externalPartyName} onChange={(event) => setExternalPartyName(event.target.value)} /></FormField><FormField label="出库日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField></div>
      <div className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">出库批次</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { skuId: '', lotId: '', quantity: '1', reason: '', remark: '' }])}>添加明细</Button></div>{lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_minmax(0,1fr)_2.5rem]"><FormField label="商品"><SkuPicker value={line.skuId} skus={skuOptions} onChange={(skuId) => updateLine(index, { skuId, lotId: '' })} /></FormField><FormField label="市场批次"><LotPicker locationId={marketId} skuId={line.skuId} value={line.lotId} onChange={(lotId) => updateLine(index, { lotId })} /></FormField><FormField label="数量"><Input inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></FormField><FormField label="明细备注"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div></div>)}</div>
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
  onSuccess,
}: {
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: (message: string) => void
}) {
  const availableLocations = locations.filter((location) => location.isActive)
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
        <FormField label="转换库存主体"><Select value={locationId} onChange={(event) => { setLocationId(event.target.value); setLines((previous) => previous.map((line) => ({ ...line, sourceLotId: '' }))) }}><option value="">请选择总部、市场或门店</option>{availableLocations.map((location) => <option key={location.locationId} value={location.locationId}>{location.locationType} · {location.name}</option>)}</Select></FormField>
        <FormField label="转换日期"><Input type="date" value={docDate} onChange={(event) => setDocDate(event.target.value)} /></FormField>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">转换明细</h3><Button type="button" variant="outline" size="sm" onClick={() => setLines((previous) => [...previous, { sourceSkuId: '', sourceLotId: '', sourceQuantity: '1', targetSkuId: '', targetQuantity: '1', targetBatchNo: '', targetExpiryDate: '', remark: '' }])}>添加明细</Button></div>
        {lines.map((line, index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-[var(--border)] p-3 xl:grid-cols-8"><FormField label="来源商品"><SkuPicker value={line.sourceSkuId} skus={skuOptions} onChange={(sourceSkuId) => updateLine(index, { sourceSkuId, sourceLotId: '' })} /></FormField><FormField label="来源批次"><LotPicker locationId={locationId} skuId={line.sourceSkuId} value={line.sourceLotId} onChange={(sourceLotId) => updateLine(index, { sourceLotId })} /></FormField><FormField label="出库数量"><Input inputMode="decimal" value={line.sourceQuantity} onChange={(event) => updateLine(index, { sourceQuantity: event.target.value })} /></FormField><FormField label="目标商品"><SkuPicker value={line.targetSkuId} skus={skuOptions} onChange={(targetSkuId) => updateLine(index, { targetSkuId })} /></FormField><FormField label="入库数量"><Input inputMode="decimal" value={line.targetQuantity} onChange={(event) => updateLine(index, { targetQuantity: event.target.value })} /></FormField><FormField label="目标批号"><Input value={line.targetBatchNo} onChange={(event) => updateLine(index, { targetBatchNo: event.target.value })} /></FormField><FormField label="目标效期"><Input type="date" value={line.targetExpiryDate} onChange={(event) => updateLine(index, { targetExpiryDate: event.target.value })} /></FormField><div className="flex items-end justify-end"><SmallIconButton label="删除明细" onClick={() => setLines((previous) => previous.length > 1 ? previous.filter((_, lineIndex) => lineIndex !== index) : previous)} disabled={lines.length === 1} /></div><FormField label="明细备注" className="xl:col-span-7"><Input value={line.remark} onChange={(event) => updateLine(index, { remark: event.target.value })} /></FormField></div>)}
      </div>
      <RemarkField value={remark} onChange={setRemark} />
      <div className="flex justify-end"><Button type="submit" loading={saving}>创建库存转换单</Button></div>
    </form>
  )
}
