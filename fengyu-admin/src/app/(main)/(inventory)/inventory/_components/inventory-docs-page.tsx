'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
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
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

  async function approve(id: string) {
    const auditRemark = prompt('审批备注') || ''
    await approveInventoryCoreDoc(id, auditRemark)
    startTransition(() => router.refresh())
  }

  async function reject(id: string) {
    const auditRemark = prompt('驳回原因') || ''
    await rejectInventoryCoreDoc(id, auditRemark)
    startTransition(() => router.refresh())
  }

  async function receive(id: string) {
    const remark = prompt('收货备注') || ''
    await confirmInventoryCoreReceive(id, remark)
    startTransition(() => router.refresh())
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
          <PreserveListContextLink href={`/inventory/docs/${r.id}`}>
            <Button variant="ghost" size="sm">详情</Button>
          </PreserveListContextLink>
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canApprove && r.status === '待审批' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => approve(r.id)}>
                通过
              </Button>
              <Button variant="ghost" size="sm" onClick={() => reject(r.id)}>
                驳回
              </Button>
            </>
          )}
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canReceive && r.status === '待收货' && (
            <Button variant="ghost" size="sm" onClick={() => receive(r.id)}>
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
            <Button onClick={() => setOpen(true)}>
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
          initialDocType={initialDocType}
          allowedDocTypes={allowedCreateDocTypes}
        />
      )}
    </div>
  )
}

function CreateDocDialog({
  open,
  onOpenChange,
  locations,
  skuOptions,
  onSuccess,
  initialDocType,
  allowedDocTypes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: () => void
  initialDocType?: InventoryDocType
  allowedDocTypes?: readonly InventoryDocType[]
}) {
  const availableDocTypes = allowedDocTypes ?? INVENTORY_GENERIC_DOC_TYPES
  const [submitting, setSubmitting] = useState(false)
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
  const lotCacheRef = useRef<Map<string, Promise<InventoryLotRow[]>>>(new Map())
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
      onOpenChange(false)
      onSuccess()
    } catch (err) {
      alert((err as Error).message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-5xl">
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

function DocLotSelect({
  locationId,
  skuId,
  value,
  onChange,
  cache,
  label,
}: {
  locationId: string
  skuId: string
  value: string
  onChange: (lotId: string) => void
  /** 弹窗级 (库位,SKU) → Promise 缓存，见 CreateDocDialog 的 lotCacheRef */
  cache: Map<string, Promise<InventoryLotRow[]>>
  label: string
}) {
  // 用 JSON 数组当 key，避免 ('a:b','c') 与 ('a','b:c') 这类分隔符歧义撞进同一个缓存槽
  const cacheKey = locationId && skuId ? JSON.stringify([locationId, skuId]) : ''
  const [retryToken, setRetryToken] = useState(0)
  const [loaded, setLoaded] = useState<LotLoadState | null>(null)

  useEffect(() => {
    if (!cacheKey) return
    let cancelled = false
    let pending = cache.get(cacheKey)
    if (!pending) {
      pending = listInventoryLotOptions(locationId, skuId)
      cache.set(cacheKey, pending)
    }
    pending
      .then((lots) => {
        if (!cancelled) setLoaded({ key: cacheKey, lots: Array.isArray(lots) ? lots : [] })
      })
      .catch((error) => {
        // 失败的 Promise 不能留在缓存里，否则重试会拿到同一个已 reject 的 Promise
        cache.delete(cacheKey)
        // 失败必须让用户看见：静默吞掉会和「该批次真的没货」长得一模一样
        if (!cancelled) {
          setLoaded({ key: cacheKey, lots: [], failed: true })
          toast.error(actionErrorMessage(error, '加载可用批次失败'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, locationId, skuId, cache, retryToken])

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
          {`${lot.batchNo || '无批号'} · 可用 ${lot.quantityOnHand}${lot.expiryDate ? ` · ${formatDate(lot.expiryDate)}` : ''}`}
        </option>
      ))}
    </Select>
  )
}
