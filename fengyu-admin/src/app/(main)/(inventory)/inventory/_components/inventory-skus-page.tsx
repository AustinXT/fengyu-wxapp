'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Package, Pencil, Plus } from 'lucide-react'
import { createInventorySku, updateInventorySku } from '@/actions/inventory/skus'
import {
  INVENTORY_SKU_SOURCE_TYPES,
  type InventoryLocationRow,
  type InventorySkuInput,
  type InventorySkuRow,
  type InventorySkuSourceType,
} from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

type SkuForm = {
  productCode: string
  productName: string
  specName: string
  supplier: string
  manufacturer: string
  brand: string
  productSeries: string
  purchaseCategory: string
  sourceType: InventorySkuSourceType
  ownerMarketId: string
  retailPrice: string
  accountingPrice: string
  supplyChainPurchasePrice: string
  storePurchasePrice: string
  marketStaffPurchasePrice: string
  marketPurchaseDiscount: string
  itemCompanyPurchasePrice: string
  isReportable: boolean
  isActive: boolean
  remark: string
}

function price(value: number | null | undefined) {
  return value == null ? '-' : value.toFixed(2)
}

function num(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value: string | null | undefined): string {
  return value ?? ''
}

function emptyForm(): SkuForm {
  return {
    productCode: '',
    productName: '',
    specName: '',
    supplier: '',
    manufacturer: '',
    brand: '',
    productSeries: '',
    purchaseCategory: '',
    sourceType: '供应链',
    ownerMarketId: '',
    retailPrice: '',
    accountingPrice: '',
    supplyChainPurchasePrice: '',
    storePurchasePrice: '',
    marketStaffPurchasePrice: '',
    marketPurchaseDiscount: '',
    itemCompanyPurchasePrice: '',
    isReportable: true,
    isActive: true,
    remark: '',
  }
}

function formFromRow(row: InventorySkuRow): SkuForm {
  return {
    productCode: row.productCode,
    productName: row.productName,
    specName: text(row.specName),
    supplier: text(row.supplier),
    manufacturer: text(row.manufacturer),
    brand: text(row.brand),
    productSeries: text(row.productSeries),
    purchaseCategory: text(row.purchaseCategory),
    sourceType: row.sourceType,
    ownerMarketId: text(row.ownerMarketId),
    retailPrice: row.retailPrice == null ? '' : String(row.retailPrice),
    accountingPrice: row.accountingPrice == null ? '' : String(row.accountingPrice),
    supplyChainPurchasePrice: row.supplyChainPurchasePrice == null ? '' : String(row.supplyChainPurchasePrice),
    storePurchasePrice: row.storePurchasePrice == null ? '' : String(row.storePurchasePrice),
    marketStaffPurchasePrice: row.marketStaffPurchasePrice == null ? '' : String(row.marketStaffPurchasePrice),
    marketPurchaseDiscount: row.marketPurchaseDiscount == null ? '' : String(row.marketPurchaseDiscount),
    itemCompanyPurchasePrice: row.itemCompanyPurchasePrice == null ? '' : String(row.itemCompanyPurchasePrice),
    isReportable: row.isReportable,
    isActive: row.isActive,
    remark: text(row.remark),
  }
}

function marketPriceFromAccounting(accountingPrice: string, discount: string): number | null {
  const accounting = num(accountingPrice)
  const rawDiscount = num(discount)
  if (accounting == null || rawDiscount == null) return null
  const ratio = rawDiscount > 1 ? rawDiscount / 100 : rawDiscount
  if (ratio < 0 || ratio > 1) return null
  return Math.round(accounting * ratio * 100) / 100
}

export default function InventorySkusPage({
  rows,
  total,
  markets,
  canCreate,
  canUpdate,
  canViewPrice,
  canManageMarketSkus,
}: {
  rows: InventorySkuRow[]
  total: number
  markets: InventoryLocationRow[]
  canCreate: boolean
  canUpdate: boolean
  canViewPrice: boolean
  canManageMarketSkus: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()
  const [searchInput, setSearchInput] = useState(get('q'))
  const [editing, setEditing] = useState<InventorySkuRow | null | undefined>(undefined)
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const page = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size'))) ? Number(get('size')) : 20

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [debounceRef, setMany])

  const columns: Column<InventorySkuRow>[] = [
    {
      key: 'productName',
      header: '商品',
      cell: (row) => (
        <div>
          <div className="font-medium">{row.productName}</div>
          <div className="font-mono text-xs text-[#888888]">{row.productCode}</div>
        </div>
      ),
    },
    { key: 'specName', header: '规格', cell: (row) => row.specName || '-' },
    { key: 'supplier', header: '供货商', cell: (row) => row.supplier || '-' },
    { key: 'productSeries', header: '系列', cell: (row) => row.productSeries || '-' },
    {
      key: 'sourceType',
      header: '来源',
      cell: (row) => (
        <div className="space-y-1">
          <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-xs text-[var(--primary)]">
            {row.sourceType}
          </span>
          {row.ownerMarketName && <div className="text-xs text-[#888888]">{row.ownerMarketName}</div>}
        </div>
      ),
    },
    ...(canViewPrice
      ? [
          { key: 'supplyChainPurchasePrice', header: '供应链采购价', cell: (row: InventorySkuRow) => price(row.supplyChainPurchasePrice) } as Column<InventorySkuRow>,
          { key: 'marketPurchasePrice', header: '市场进货价', cell: (row: InventorySkuRow) => price(row.marketPurchasePrice) } as Column<InventorySkuRow>,
          { key: 'storePurchasePrice', header: '门店进货价', cell: (row: InventorySkuRow) => price(row.storePurchasePrice) } as Column<InventorySkuRow>,
          { key: 'marketStaffPurchasePrice', header: '市场员工购价', cell: (row: InventorySkuRow) => price(row.marketStaffPurchasePrice) } as Column<InventorySkuRow>,
          { key: 'retailPrice', header: '零售价', cell: (row: InventorySkuRow) => price(row.retailPrice) } as Column<InventorySkuRow>,
        ]
      : []),
    { key: 'isReportable', header: '可报货', cell: (row) => (row.isReportable ? '是' : '否') },
    { key: 'isActive', header: '启用', cell: (row) => (row.isActive ? '是' : '否') },
    ...(canUpdate
      ? [{ key: 'actions', header: '操作', cell: (row: InventorySkuRow) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(row)}
          title={row.sourceType === '供应链' || canManageMarketSkus ? '编辑库存商品' : '缺少市场自采产品资料维护权限'}
          disabled={row.sourceType !== '供应链' && !canManageMarketSkus}
        >
          <Pencil className="size-4" />
        </Button>
      ) } as Column<InventorySkuRow>]
      : []),
  ]

  const dialogOpen = editing !== undefined

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Package className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">库存商品资料</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={get('source')}
            onChange={(event) => setMany({ source: event.target.value, page: '' })}
            className="w-36"
          >
            <option value="">全部来源</option>
            {INVENTORY_SKU_SOURCE_TYPES.map((source) => (
              <option key={source} value={source}>{source}</option>
            ))}
          </Select>
          <Input
            className="w-72"
            placeholder="搜索编号 / 名称 / 规格 / 系列"
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
          <Button variant="outline" onClick={() => setMany({ q: '', source: '', page: '' })}>重置</Button>
          {canCreate && (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 size-4" /> 新建
            </Button>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无库存商品" />
      <Pagination
        total={total}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setMany({ page: String(next) })}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      <SkuFormDialog
        key={editing?.skuId ?? 'create'}
        open={dialogOpen}
        row={editing ?? null}
        markets={markets}
        canViewPrice={canViewPrice}
        canManageMarketSkus={canManageMarketSkus}
        onOpenChange={(open) => { if (!open) setEditing(undefined) }}
        onSuccess={() => startTransition(() => router.refresh())}
      />
    </div>
  )
}

function SkuFormDialog({
  open,
  row,
  markets,
  canViewPrice,
  canManageMarketSkus,
  onOpenChange,
  onSuccess,
}: {
  open: boolean
  row: InventorySkuRow | null
  markets: InventoryLocationRow[]
  canViewPrice: boolean
  canManageMarketSkus: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState<SkuForm>(() => row ? formFromRow(row) : emptyForm())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setForm(row ? formFromRow(row) : emptyForm())
  }, [open, row])

  const calculatedMarketPrice = useMemo(
    () => marketPriceFromAccounting(form.accountingPrice, form.marketPurchaseDiscount),
    [form.accountingPrice, form.marketPurchaseDiscount],
  )

  function setField<K extends keyof SkuForm>(key: K, value: SkuForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      const input: InventorySkuInput = {
        productCode: form.productCode,
        productName: form.productName,
        specName: form.specName,
        supplier: form.supplier,
        manufacturer: form.manufacturer,
        brand: form.brand,
        productSeries: form.productSeries,
        purchaseCategory: form.purchaseCategory,
        sourceType: form.sourceType,
        ownerMarketId: form.sourceType === '供应链' ? null : form.ownerMarketId,
        retailPrice: canViewPrice ? num(form.retailPrice) : null,
        accountingPrice: canViewPrice ? num(form.accountingPrice) : null,
        supplyChainPurchasePrice: canViewPrice ? num(form.supplyChainPurchasePrice) : null,
        ...(canViewPrice && calculatedMarketPrice !== null
          ? { marketPurchasePrice: calculatedMarketPrice }
          : {}),
        storePurchasePrice: canViewPrice ? num(form.storePurchasePrice) : null,
        marketStaffPurchasePrice: canViewPrice ? num(form.marketStaffPurchasePrice) : null,
        marketPurchaseDiscount: canViewPrice ? num(form.marketPurchaseDiscount) : null,
        itemCompanyPurchasePrice: canViewPrice ? num(form.itemCompanyPurchasePrice) : null,
        isReportable: form.isReportable,
        isActive: form.isActive,
        remark: form.remark,
      }
      if (row) await updateInventorySku(row.skuId, input)
      else await createInventorySku(input)
      onOpenChange(false)
      onSuccess()
    } catch (error) {
      alert((error as Error).message || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-4xl">
      <DialogHeader>
        <DialogTitle>{row ? '编辑库存商品' : '新建库存商品'}</DialogTitle>
      </DialogHeader>
      <div className="mt-4 max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">基础资料</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="产品编号 *"><Input value={form.productCode} onChange={(event) => setField('productCode', event.target.value)} /></Field>
            <Field label="产品名称 *"><Input value={form.productName} onChange={(event) => setField('productName', event.target.value)} /></Field>
            <Field label="规格"><Input value={form.specName} onChange={(event) => setField('specName', event.target.value)} /></Field>
            <Field label="供货商"><Input value={form.supplier} onChange={(event) => setField('supplier', event.target.value)} /></Field>
            <Field label="生产厂家"><Input value={form.manufacturer} onChange={(event) => setField('manufacturer', event.target.value)} /></Field>
            <Field label="品牌"><Input value={form.brand} onChange={(event) => setField('brand', event.target.value)} /></Field>
            <Field label="产品系列"><Input value={form.productSeries} onChange={(event) => setField('productSeries', event.target.value)} /></Field>
            <Field label="采购分类"><Input value={form.purchaseCategory} onChange={(event) => setField('purchaseCategory', event.target.value)} /></Field>
            <Field label="来源 *">
              <Select value={form.sourceType} disabled={!!row} onChange={(event) => setField('sourceType', event.target.value as InventorySkuSourceType)}>
                {INVENTORY_SKU_SOURCE_TYPES
                  .filter((source) => source === '供应链' || canManageMarketSkus)
                  .map((source) => <option key={source} value={source}>{source}</option>)}
              </Select>
            </Field>
            {form.sourceType !== '供应链' && (
              <Field label="归属市场 *">
                <Select value={form.ownerMarketId} disabled={!!row} onChange={(event) => setField('ownerMarketId', event.target.value)}>
                  <option value="">请选择市场</option>
                  {markets.map((market) => <option key={market.locationId} value={market.locationId}>{market.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
        </section>

        {canViewPrice && (
          <section className="space-y-3 border-t border-[var(--border)] pt-4">
            <h3 className="text-sm font-medium">价格资料</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="供应链采购价"><Input inputMode="decimal" value={form.supplyChainPurchasePrice} onChange={(event) => setField('supplyChainPurchasePrice', event.target.value)} /></Field>
              <Field label="门店进货价"><Input inputMode="decimal" value={form.storePurchasePrice} onChange={(event) => setField('storePurchasePrice', event.target.value)} /></Field>
              <Field label="市场员工购价"><Input inputMode="decimal" value={form.marketStaffPurchasePrice} onChange={(event) => setField('marketStaffPurchasePrice', event.target.value)} /></Field>
              <Field label="顾客零售价"><Input inputMode="decimal" value={form.retailPrice} onChange={(event) => setField('retailPrice', event.target.value)} /></Field>
              <Field label="核算价"><Input inputMode="decimal" value={form.accountingPrice} onChange={(event) => setField('accountingPrice', event.target.value)} /></Field>
              <Field label="市场折扣（25 表示 25%）"><Input inputMode="decimal" value={form.marketPurchaseDiscount} onChange={(event) => setField('marketPurchaseDiscount', event.target.value)} /></Field>
              <Field label="市场进货价">
                <Input
                  inputMode="decimal"
                  value={calculatedMarketPrice == null
                    ? row?.marketPurchasePrice == null ? '' : String(row.marketPurchasePrice)
                    : String(calculatedMarketPrice)}
                  readOnly
                />
              </Field>
              <Field label="自采实际进货价"><Input inputMode="decimal" value={form.itemCompanyPurchasePrice} onChange={(event) => setField('itemCompanyPurchasePrice', event.target.value)} /></Field>
            </div>
          </section>
        )}

        <section className="space-y-3 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">可报货 <Switch checked={form.isReportable} onCheckedChange={(checked) => setField('isReportable', checked)} /></label>
            <label className="flex items-center gap-2 text-sm">启用 <Switch checked={form.isActive} onCheckedChange={(checked) => setField('isActive', checked)} /></label>
          </div>
          <Field label="备注"><Textarea value={form.remark} onChange={(event) => setField('remark', event.target.value)} /></Field>
        </section>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
        <Button onClick={submit} disabled={submitting}>{submitting ? '保存中...' : '保存'}</Button>
      </DialogFooter>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-[#666666]">{label}</span>
      {children}
    </label>
  )
}
