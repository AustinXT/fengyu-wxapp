'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
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
  type InventoryLocationRow,
  type InventorySkuRow,
  type InventoryDocType,
} from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const GENERIC_DOC_TYPE_SET = new Set<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES)

const SOURCE_LOT_DOC_TYPES = new Set<InventoryDocType>([
  '品项公司发货',
  '分院配货',
  '分院调货出库',
  '市场间调货出库',
  '员工购出库',
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
  canViewPrice,
}: {
  rows: InventoryDocRow[]
  total: number
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  canCreate: boolean
  canApprove: boolean
  canViewPrice: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()
  const [searchInput, setSearchInput] = useState(get('q'))
  const [open, setOpen] = useState(false)
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
      key: 'sourceLocationName',
      header: '出库/发起',
      cell: (r) => r.sourceLocationName ?? '—',
    },
    {
      key: 'targetLocationName',
      header: '入库/接收',
      cell: (r) => r.targetLocationName ?? '—',
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
          <Button variant="ghost" size="sm" onClick={() => router.push(`/inventory/docs/${r.id}`)}>
            详情
          </Button>
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
          {GENERIC_DOC_TYPE_SET.has(r.docType) && canCreate && r.status === '待收货' && (
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
        <div className="flex items-center gap-3">
          <ClipboardList className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">库存单据</h1>
        </div>
        <div className="flex items-center gap-2">
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
          <Button variant="outline" onClick={() => setMany({ q: '', docType: '', status: '', page: '' })}>
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

      <CreateDocDialog
        open={open}
        onOpenChange={setOpen}
        locations={locations}
        skuOptions={skuOptions}
        onSuccess={() => startTransition(() => router.refresh())}
      />
    </div>
  )
}

function CreateDocDialog({
  open,
  onOpenChange,
  locations,
  skuOptions,
  onSuccess,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: InventoryLocationRow[]
  skuOptions: InventorySkuRow[]
  onSuccess: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [docType, setDocType] = useState<InventoryDocType>(INVENTORY_GENERIC_DOC_TYPES[0])
  const [sourceLocationId, setSourceLocationId] = useState('')
  const [targetLocationId, setTargetLocationId] = useState('')
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
  const [lotOptionsByKey, setLotOptionsByKey] = useState<Record<string, InventoryLotRow[]>>({})
  const [loadingLotKeys, setLoadingLotKeys] = useState<Record<string, boolean>>({})
  const requiresSourceLot = SOURCE_LOT_DOC_TYPES.has(docType)

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  useEffect(() => {
    if (!requiresSourceLot || !sourceLocationId) return
    const skuIds = Array.from(new Set(items.map((item) => item.skuId).filter(Boolean)))
    let cancelled = false
    for (const skuId of skuIds) {
      const key = `${sourceLocationId}:${skuId}`
      if (lotOptionsByKey[key] || loadingLotKeys[key]) continue
      setLoadingLotKeys((prev) => ({ ...prev, [key]: true }))
      void listInventoryLotOptions(sourceLocationId, skuId)
        .then((lots) => {
          if (!cancelled) setLotOptionsByKey((prev) => ({ ...prev, [key]: lots }))
        })
        .catch(() => {
          if (!cancelled) setLotOptionsByKey((prev) => ({ ...prev, [key]: [] }))
        })
        .finally(() => {
          if (!cancelled) {
            setLoadingLotKeys((prev) => ({ ...prev, [key]: false }))
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [items, loadingLotKeys, lotOptionsByKey, requiresSourceLot, sourceLocationId])

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      const payload: CreateInventoryDocInput = {
        docType,
        sourceLocationId: sourceLocationId || null,
        targetLocationId: targetLocationId || null,
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
          <Select value={docType} onChange={(e) => setDocType(e.target.value as InventoryDocType)}>
            {INVENTORY_GENERIC_DOC_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </Select>
          <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          <Select
            value={sourceLocationId}
            onChange={(e) => {
              setSourceLocationId(e.target.value)
              setItems((prev) => prev.map((item) => ({ ...item, lotId: '' })))
            }}
          >
            <option value="">出库/发起主体</option>
            {locations.map((location) => (
              <option key={location.locationId} value={location.locationId}>
                {location.locationType} · {location.name}
              </option>
            ))}
          </Select>
          <Select value={targetLocationId} onChange={(e) => setTargetLocationId(e.target.value)}>
            <option value="">入库/接收主体</option>
            {locations.map((location) => (
              <option key={location.locationId} value={location.locationId}>
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
              {requiresSourceLot && (() => {
                const key = item.skuId ? `${sourceLocationId}:${item.skuId}` : ''
                const lots = key ? lotOptionsByKey[key] || [] : []
                const isLoadingLots = key ? loadingLotKeys[key] : false
                return (
                  <Select
                    value={item.lotId}
                    disabled={!sourceLocationId || !item.skuId || isLoadingLots}
                    onChange={(e) => updateItem(index, { lotId: e.target.value })}
                  >
                    <option value="">
                      {!sourceLocationId
                        ? '先选择出库主体'
                        : !item.skuId
                          ? '先选择库存 SKU'
                          : isLoadingLots
                            ? '加载库存批次...'
                            : '选择库存批次'}
                    </option>
                    {lots.map((lot) => (
                      <option key={lot.id} value={String(lot.id)}>
                        {`${lot.batchNo || '无批号'} · 可用 ${lot.quantityOnHand}${lot.expiryDate ? ` · ${formatDate(lot.expiryDate)}` : ''}`}
                      </option>
                    ))}
                  </Select>
                )
              })()}
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
              <Input type="date" value={item.expiryDate} onChange={(e) => updateItem(index, { expiryDate: e.target.value })} />
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
