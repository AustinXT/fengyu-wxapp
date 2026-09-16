'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Package, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createInventorySku, updateInventorySku } from '@/actions/inventory/skus'
import { createInventorySupplier } from '@/actions/inventory/suppliers'
import {
  INVENTORY_SKU_SOURCE_TYPES,
  type InventoryLocationRow,
  type InventorySkuInput,
  type InventorySkuRow,
  type InventorySkuSourceType,
  type InventorySupplierOption,
} from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

type SkuForm = {
  productName: string
  specName: string
  /** 供应商档案 id；空串表示未选（#132，不再收自由文本）。 */
  supplierId: string
  manufacturer: string
  brand: string
  productSeries: string
  purchaseCategory: string
  sourceType: InventorySkuSourceType
  ownerMarketId: string
  retailPrice: string
  accountingPrice: string
  supplyChainPurchasePrice: string
  marketPurchasePrice: string
  marketPurchasePriceMode: '公式' | '手工覆盖'
  marketPurchasePriceOverrideReason: string
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
    productName: '',
    specName: '',
    supplierId: '',
    manufacturer: '',
    brand: '',
    productSeries: '',
    purchaseCategory: '',
    sourceType: '供应链',
    ownerMarketId: '',
    retailPrice: '',
    accountingPrice: '',
    supplyChainPurchasePrice: '',
    marketPurchasePrice: '',
    marketPurchasePriceMode: '公式',
    marketPurchasePriceOverrideReason: '',
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
    productName: row.productName,
    specName: text(row.specName),
    supplierId: text(row.supplierId),
    manufacturer: text(row.manufacturer),
    brand: text(row.brand),
    productSeries: text(row.productSeries),
    purchaseCategory: text(row.purchaseCategory),
    sourceType: row.sourceType,
    ownerMarketId: text(row.ownerMarketId),
    retailPrice: row.retailPrice == null ? '' : String(row.retailPrice),
    accountingPrice: row.accountingPrice == null ? '' : String(row.accountingPrice),
    supplyChainPurchasePrice: row.supplyChainPurchasePrice == null ? '' : String(row.supplyChainPurchasePrice),
    marketPurchasePrice: row.marketPurchasePrice == null ? '' : String(row.marketPurchasePrice),
    marketPurchasePriceMode: row.marketPurchasePriceMode ?? '公式',
    marketPurchasePriceOverrideReason: text(row.marketPurchasePriceOverrideReason),
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
  supplierOptions,
  canCreate,
  canUpdate,
  canCreateSupplier,
  canViewPrice,
  canManageMarketSkus,
  canManageSupplySkus,
}: {
  rows: InventorySkuRow[]
  total: number
  markets: InventoryLocationRow[]
  supplierOptions: InventorySupplierOption[]
  canCreate: boolean
  canUpdate: boolean
  canCreateSupplier: boolean
  canViewPrice: boolean
  canManageMarketSkus: boolean
  canManageSupplySkus: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()
  const [searchInput, setSearchInput] = useState(get('q'))
  const [editing, setEditing] = useState<InventorySkuRow | null | undefined>(undefined)
  // 弹窗内快捷建的供应商。存在父组件而不是弹窗里，是因为弹窗按 key 重建（换一行编辑就丢），
  // 而刚建出来的档案在整页重新 SSR 之前不会出现在 supplierOptions 里。
  const [createdSuppliers, setCreatedSuppliers] = useState<InventorySupplierOption[]>([])
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
    {
      key: 'supplier',
      header: '供货商',
      // 关联上档案就显示档案名（改名后自动跟随）；没关联上的存量文本照常显示，
      // 但标出来 —— 不标的话「关联了」和「只是打了段字」在列表里长得一模一样。
      cell: (row) => row.supplierName
        ? row.supplierName
        : row.supplier
          ? (
            <span className="inline-flex items-center gap-1">
              {row.supplier}
              <span className="rounded bg-[#FDF3E3] px-1 text-xs text-[#D4820A]">未关联档案</span>
            </span>
          )
          : '-',
    },
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
          disabled={row.sourceType === '供应链' ? !canManageSupplySkus : !canManageMarketSkus}
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
        supplierOptions={supplierOptions}
        createdSuppliers={createdSuppliers}
        canViewPrice={canViewPrice}
        canCreateSupplier={canCreateSupplier}
        canManageMarketSkus={canManageMarketSkus}
        canManageSupplySkus={canManageSupplySkus}
        onOpenChange={(open) => { if (!open) setEditing(undefined) }}
        onSupplierCreated={(option) => setCreatedSuppliers((previous) => [...previous, option])}
        onSuccess={() => startTransition(() => router.refresh())}
      />
    </div>
  )
}

function SkuFormDialog({
  open,
  row,
  markets,
  supplierOptions,
  createdSuppliers,
  canViewPrice,
  canCreateSupplier,
  canManageMarketSkus,
  canManageSupplySkus,
  onOpenChange,
  onSupplierCreated,
  onSuccess,
}: {
  open: boolean
  row: InventorySkuRow | null
  markets: InventoryLocationRow[]
  supplierOptions: InventorySupplierOption[]
  createdSuppliers: InventorySupplierOption[]
  canViewPrice: boolean
  canCreateSupplier: boolean
  canManageMarketSkus: boolean
  canManageSupplySkus: boolean
  onOpenChange: (open: boolean) => void
  onSupplierCreated: (option: InventorySupplierOption) => void
  onSuccess: () => void
}) {
  const [form, setForm] = useState<SkuForm>(() => row ? formFromRow(row) : emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [supplierFormOpen, setSupplierFormOpen] = useState(false)
  const [supplierDraft, setSupplierDraft] = useState({ name: '', contactName: '', phone: '' })
  const [savingSupplier, setSavingSupplier] = useState(false)

  useEffect(() => {
    if (open) setForm(row ? formFromRow(row) : emptyForm())
  }, [open, row])

  /** 存量里 supplier 文本没匹配上档案的旧 SKU（migration 0041 匹配不上就留 NULL）。 */
  const unlinkedLegacyText = row && row.supplierId === null ? row.supplier : null

  const supplierChoices = useMemo(() => {
    const merged = new Map<string, string>()
    for (const option of supplierOptions) merged.set(option.supplierId, option.name)
    for (const option of createdSuppliers) merged.set(option.supplierId, option.name)
    // 已关联的档案后来被停用时，它不在「启用中」的选项里。不补进来的话下拉会显示空，
    // 用户一保存就把关联清掉了 —— 这是编辑旧 SKU 最容易丢数据的地方。
    if (row?.supplierId && !merged.has(row.supplierId)) {
      merged.set(row.supplierId, `${row.supplierName ?? row.supplier ?? row.supplierId}（已停用）`)
    }
    return Array.from(merged, ([supplierId, name]) => ({ supplierId, name }))
  }, [supplierOptions, createdSuppliers, row])

  const calculatedMarketPrice = useMemo(
    () => marketPriceFromAccounting(form.accountingPrice, form.marketPurchaseDiscount),
    [form.accountingPrice, form.marketPurchaseDiscount],
  )

  function setField<K extends keyof SkuForm>(key: K, value: SkuForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  async function submitSupplier() {
    if (savingSupplier) return
    const name = supplierDraft.name.trim()
    if (!name) {
      toast.error('请输入供应商名称')
      return
    }
    setSavingSupplier(true)
    try {
      const { supplierId } = await createInventorySupplier({
        name,
        contactName: supplierDraft.contactName.trim() || null,
        phone: supplierDraft.phone.trim() || null,
      })
      // 只更新本地选项、不 router.refresh()：refresh 会让 server 重新下发 row，
      // SkuFormDialog 的 useEffect([open, row]) 随即把用户填到一半的表单重置掉。
      onSupplierCreated({ supplierId, name })
      setField('supplierId', supplierId)
      setSupplierDraft({ name: '', contactName: '', phone: '' })
      setSupplierFormOpen(false)
      toast.success('供应商已创建并选中')
    } catch (error) {
      toast.error(actionErrorMessage(error, '创建供应商失败'))
    } finally {
      setSavingSupplier(false)
    }
  }

  async function submit() {
    if (submitting) return
    const hasManualMarketPrice = form.marketPurchasePrice.trim().length > 0
    const manualMarketPrice = num(form.marketPurchasePrice)
    if (hasManualMarketPrice && (manualMarketPrice == null || manualMarketPrice < 0)) {
      toast.error('请输入有效的市场进货价')
      return
    }
    const marketPurchasePrice = hasManualMarketPrice
      ? manualMarketPrice
      : calculatedMarketPrice
    if (form.sourceType === '供应链' && form.marketPurchasePriceMode === '手工覆盖' && !form.marketPurchasePriceOverrideReason.trim()) {
      toast.error('手工覆盖市场进货价时必须填写原因')
      return
    }
    setSubmitting(true)
    try {
      const input: InventorySkuInput = {
        productName: form.productName,
        specName: form.specName,
        // 三态（engine 的 resolveSkuSupplier 按此区分）：
        //   选了档案            → 传 id，后端顺带把档案名写进 supplier 快照
        //   没选，且原本就没关联、只有一段没匹配上的旧文本 → 不传，保住那段文本
        //   其余（含主动清空已有关联）→ null，两列一起清
        supplierId: form.supplierId || (unlinkedLegacyText ? undefined : null),
        manufacturer: form.manufacturer,
        brand: form.brand,
        productSeries: form.productSeries,
        purchaseCategory: form.purchaseCategory,
        sourceType: form.sourceType,
        ownerMarketId: form.sourceType === '供应链' ? null : form.ownerMarketId,
        retailPrice: canViewPrice ? num(form.retailPrice) : null,
        accountingPrice: canViewPrice ? num(form.accountingPrice) : null,
        supplyChainPurchasePrice: canViewPrice ? num(form.supplyChainPurchasePrice) : null,
        marketPurchasePrice: canViewPrice ? marketPurchasePrice : null,
        marketPurchasePriceMode: form.sourceType === '供应链' ? form.marketPurchasePriceMode : null,
        marketPurchasePriceOverrideReason: form.sourceType === '供应链' && form.marketPurchasePriceMode === '手工覆盖'
          ? form.marketPurchasePriceOverrideReason
          : null,
        storePurchasePrice: canViewPrice ? num(form.storePurchasePrice) : null,
        marketStaffPurchasePrice: canViewPrice ? num(form.marketStaffPurchasePrice) : null,
        marketPurchaseDiscount: canViewPrice ? num(form.marketPurchaseDiscount) : null,
        itemCompanyPurchasePrice: canViewPrice ? num(form.itemCompanyPurchasePrice) : null,
        isReportable: form.isReportable,
        isActive: form.isActive,
        remark: form.remark,
      }
      if (row) {
        await updateInventorySku(row.skuId, input)
        toast.success('库存商品已更新')
      } else {
        await createInventorySku(input)
        toast.success('库存商品已创建')
      }
      onOpenChange(false)
      onSuccess()
    } catch (error) {
      toast.error(actionErrorMessage(error, row ? '更新库存商品失败' : '创建库存商品失败'))
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
            <Field label="产品编号">
              <div className="flex min-h-9 items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 text-sm text-[#666666]">
                {row?.productCode ?? '保存后由系统自动生成'}
              </div>
            </Field>
            <Field label="产品名称 *"><Input value={form.productName} onChange={(event) => setField('productName', event.target.value)} /></Field>
            <Field label="规格"><Input value={form.specName} onChange={(event) => setField('specName', event.target.value)} /></Field>
            {/*
              「+ 新建供应商」按钮与提示文字放在 <label> **外面**：Field 会把 children 全裹进
              label，按钮进去既不利于读屏，也会让按 label 文本定位的测试（e2e 的
              /^供货商$/）失配。这里只让 label 裹住 Select 本身。
            */}
            <div className="grid gap-1.5 text-sm">
              <label className="grid gap-1.5 text-sm">
                <span className="text-[#666666]">供货商</span>
                <Select
                  value={form.supplierId}
                  onChange={(event) => setField('supplierId', event.target.value)}
                >
                  <option value="">未指定</option>
                  {supplierChoices.map((option) => (
                    <option key={option.supplierId} value={option.supplierId}>{option.name}</option>
                  ))}
                </Select>
              </label>
              {canCreateSupplier && !supplierFormOpen && (
                <button
                  type="button"
                  className="justify-self-start text-xs text-[var(--primary)] hover:underline"
                  onClick={() => setSupplierFormOpen(true)}
                >
                  + 新建供应商
                </button>
              )}
              {unlinkedLegacyText && !form.supplierId && (
                <p className="text-xs text-[#D4820A]">
                  原填写「{unlinkedLegacyText}」未匹配到供应商档案。选择档案即完成关联；不选则保留原文本。
                </p>
              )}
              {supplierFormOpen && (
                <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-2">
                  <Input
                    aria-label="新供应商名称"
                    placeholder="供应商名称 *"
                    value={supplierDraft.name}
                    onChange={(event) => setSupplierDraft((previous) => ({ ...previous, name: event.target.value }))}
                  />
                  <Input
                    aria-label="新供应商联系人"
                    placeholder="联系人"
                    value={supplierDraft.contactName}
                    onChange={(event) => setSupplierDraft((previous) => ({ ...previous, contactName: event.target.value }))}
                  />
                  <Input
                    aria-label="新供应商联系电话"
                    placeholder="联系电话"
                    value={supplierDraft.phone}
                    onChange={(event) => setSupplierDraft((previous) => ({ ...previous, phone: event.target.value }))}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setSupplierFormOpen(false); setSupplierDraft({ name: '', contactName: '', phone: '' }) }}
                      disabled={savingSupplier}
                    >
                      取消
                    </Button>
                    <Button size="sm" onClick={submitSupplier} loading={savingSupplier}>创建并选中</Button>
                  </div>
                </div>
              )}
            </div>
            <Field label="生产厂家"><Input value={form.manufacturer} onChange={(event) => setField('manufacturer', event.target.value)} /></Field>
            <Field label="品牌"><Input value={form.brand} onChange={(event) => setField('brand', event.target.value)} /></Field>
            <Field label="产品系列"><Input value={form.productSeries} onChange={(event) => setField('productSeries', event.target.value)} /></Field>
            <Field label="采购分类"><Input value={form.purchaseCategory} onChange={(event) => setField('purchaseCategory', event.target.value)} /></Field>
            <Field label="来源 *">
              <Select value={form.sourceType} disabled={!!row} onChange={(event) => setField('sourceType', event.target.value as InventorySkuSourceType)}>
                {INVENTORY_SKU_SOURCE_TYPES
                  .filter((source) => source === '供应链' ? canManageSupplySkus : canManageMarketSkus)
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
                <div className="space-y-1">
                  {form.sourceType === '供应链' && (
                    <Select value={form.marketPurchasePriceMode} onChange={(event) => setField('marketPurchasePriceMode', event.target.value as '公式' | '手工覆盖')}>
                      <option value="公式">按公式计算</option>
                      <option value="手工覆盖">手工覆盖</option>
                    </Select>
                  )}
                  <Input
                    inputMode="decimal"
                    value={form.marketPurchasePrice}
                    placeholder={calculatedMarketPrice == null ? undefined : String(calculatedMarketPrice)}
                    disabled={form.sourceType === '供应链' && form.marketPurchasePriceMode === '公式'}
                    onChange={(event) => setField('marketPurchasePrice', event.target.value)}
                  />
                  <p className="text-xs text-[#888888]">公式价 = 核算价 × 市场折扣；手工覆盖必须留痕原因</p>
                </div>
              </Field>
              {form.sourceType === '供应链' && form.marketPurchasePriceMode === '手工覆盖' && (
                <Field label="手工覆盖原因 *"><Textarea value={form.marketPurchasePriceOverrideReason} onChange={(event) => setField('marketPurchasePriceOverrideReason', event.target.value)} /></Field>
              )}
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
