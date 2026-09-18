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
  type InventoryPriceVisibility,
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
  priceVisibility,
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
  priceVisibility: InventoryPriceVisibility
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
  // 服务端重新下发选项（router.refresh 之后）就把本地缓存清掉，一切以服务端为准。
  // 不清的话：本页快捷建了 SUP-X，别处把它改名并停用，refresh 后 supplierOptions 已排除它，
  // 而本地缓存仍留着旧名 —— 下拉里会出现一个看似可用的旧名档案（选中保存才被后端拒），
  // 且因为 Map 里已有这个 id，「当前行关联的停用档案」那条补回逻辑也不会执行，
  // 于是列表显示新名、下拉显示旧名，正是这次要消灭的双名称。
  // supplierOptions 是 server component 传下来的 prop，只有真的重新 SSR 才换引用，
  // 普通重渲染不会触发。
  useEffect(() => {
    setCreatedSuppliers([])
  }, [supplierOptions])
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const page = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size'))) ? Number(get('size')) : 20

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [debounceRef, setMany])

  // 与 engine.ts skuRow() 的三个判定同名同义，便于两侧对照
  const supplyPriceVisible = priceVisibility === 'all' || priceVisibility === 'supply_chain'
  const marketPriceVisible = priceVisibility === 'all' || priceVisibility === 'market'
  const anyPriceVisible = priceVisibility !== 'none'

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
    // 逐列按价格档位裁剪，**与 engine.ts 的 skuRow() 遮蔽口径一一对应**：
    //   supplyChainPurchasePrice → supplyVisible
    //   marketPurchasePrice      → anyPriceVisible
    //   storePurchasePrice       → marketVisible
    //   marketStaffPurchasePrice → marketVisible
    //   retailPrice              → 仅 'all'
    // 之前是一个粗粒度的 canViewPrice 控全部 5 列，于是只有 market_price_view 的
    // 市场财务角色会看到「供应链采购价」列头、底下整列都是「—」（#135 组 5）。
    // 数值遮蔽本来就是对的，这里修的是"渲染了一列永远没有值的空列"。
    // 改任一侧都要同步另一侧，engine.test.ts 有守护。
    ...(supplyPriceVisible
      ? [{ key: 'supplyChainPurchasePrice', header: '供应链采购价', cell: (row: InventorySkuRow) => price(row.supplyChainPurchasePrice) } as Column<InventorySkuRow>]
      : []),
    ...(anyPriceVisible
      ? [{ key: 'marketPurchasePrice', header: '市场进货价', cell: (row: InventorySkuRow) => price(row.marketPurchasePrice) } as Column<InventorySkuRow>]
      : []),
    ...(marketPriceVisible
      ? [
          { key: 'storePurchasePrice', header: '门店进货价', cell: (row: InventorySkuRow) => price(row.storePurchasePrice) } as Column<InventorySkuRow>,
          { key: 'marketStaffPurchasePrice', header: '市场员工购价', cell: (row: InventorySkuRow) => price(row.marketStaffPurchasePrice) } as Column<InventorySkuRow>,
        ]
      : []),
    ...(priceVisibility === 'all'
      ? [{ key: 'retailPrice', header: '零售价', cell: (row: InventorySkuRow) => price(row.retailPrice) } as Column<InventorySkuRow>]
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
  // 用户有没有动过供货商下拉。没有它就分不清「没碰」和「选了档案又改回未指定」——
  // 两者的 form.supplierId 都是 ''，而前者要保住存量旧文本、后者是明确要清空。
  // 不区分的话，未匹配上档案的那段旧文本用户**永远删不掉**（改造前的自由输入框能删）。
  const [supplierTouched, setSupplierTouched] = useState(false)
  const [supplierFormOpen, setSupplierFormOpen] = useState(false)
  const [supplierDraft, setSupplierDraft] = useState({ name: '', contactName: '', phone: '' })
  const [savingSupplier, setSavingSupplier] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(row ? formFromRow(row) : emptyForm())
    // 把弹窗内的其余状态一并重置。
    // ⚠️ 诚实标注：当前**不靠**这几行也能重置 —— 关闭时 editing 变 undefined，
    // `key` 从 skuId 变成 'create'，React 会卸载旧实例、state 自然清空
    //（已做变异测试确认：删掉这几行，「取消后重开不残留清空意图」那条仍绿）。
    // 留着是显式防御：key 策略一旦改动（比如改成固定 key 以避免重挂），
    // 「点了『清空原文本』→ 取消 → 重开 → 直接保存把文本清掉」就会立刻成真。
    setSupplierTouched(false)
    setSupplierFormOpen(false)
    setSupplierDraft({ name: '', contactName: '', phone: '' })
  }, [open, row])

  /**
   * 存量里 supplier 文本没匹配上档案的旧 SKU（migration 0042 匹配不上就留 NULL）。
   *
   * 必须 trim 后再判真值：`btrim` 只吃 ASCII 空格，全角空格 / NBSP 包裹的值会带着
   * `supplier_id IS NULL` 活下来。不 trim 的话它是 truthy → 提交 `undefined` →
   * 两列都不动 → 这段空白**永远删不掉**，而且列表上会渲染成「空名字 + 未关联档案角标」。
   */
  const unlinkedLegacyText = row && row.supplierId === null ? (row.supplier?.trim() || null) : null

  const supplierChoices = useMemo(() => {
    const merged = new Map<string, string>()
    // 顺序是刻意的：**本地新建的先放、服务器的后放**，让服务器值覆盖本地缓存。
    // 反过来的话，在本页快捷建了档案、别处又把它改了名，`router.refresh()` 下发的新名
    // 会被本地缓存的旧名盖掉 —— 列表（走 JOIN）显示新名、下拉显示旧名，而保存时后端
    // 又按 id 派生出新名，界面与实际写入值对不上。
    for (const option of createdSuppliers) merged.set(option.supplierId, option.name)
    for (const option of supplierOptions) merged.set(option.supplierId, option.name)
    // 已关联的档案后来被停用时，它不在「启用中」的选项里。不补进来的话下拉会显示空，
    // 用户一保存就把关联清掉了 —— 这是编辑旧 SKU 最容易丢数据的地方。
    if (row?.supplierId && !merged.has(row.supplierId)) {
      merged.set(row.supplierId, `${row.supplierName ?? row.supplier ?? row.supplierId}（已停用）`)
    }
    // 兜底：表单当前选中的 id 不在选项里时补一条占位。
    // 会发生在「服务端重新下发选项把本地缓存淘汰掉、而表单里还留着刚建的那个 id」——
    // 不补的话原生 <select> 找不到 option 会显示成「未指定」，而保存提交的仍是那个 id，
    // 界面显示值与提交值分裂。
    if (form.supplierId && !merged.has(form.supplierId)) {
      merged.set(form.supplierId, '已选供应商（刷新后可见）')
    }
    return Array.from(merged, ([supplierId, name]) => ({ supplierId, name }))
  }, [supplierOptions, createdSuppliers, row, form.supplierId])

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
      setSupplierTouched(true)
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
    // 也要挡 savingSupplier：快捷建档在途时点「保存」，读到的 form.supplierId 还是旧值
    //（setField 在 await 之后才执行），SKU 会以旧供货商落库并关窗，
    // 随后建档成功 —— 留下一条谁都没关联、当次列表也刷不出来的孤儿档案。
    if (submitting || savingSupplier) return
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
        supplierId: form.supplierId || (unlinkedLegacyText && !supplierTouched ? undefined : null),
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
    // dismissible=false 覆盖「提交在途」：光给按钮加 disabled 拦不住 ESC 与点遮罩
    //（dialog.tsx 的组件注释里写明了这一点）。快捷建档在途时被 ESC 关掉的话，
    // 弹窗按 key 整体卸载，setField('supplierId', ...) 打在已卸载实例上 ——
    // 档案已经落库，用户却只看到「已创建并选中」而找不到选中在哪。
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-4xl"
      dismissible={!submitting && !savingSupplier}
    >
      <DialogHeader>
        <DialogTitle>{row ? '编辑库存商品' : '新建库存商品'}</DialogTitle>
      </DialogHeader>
      <div className="mt-4 max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">基础资料</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/*
              产品编号是只读展示（保存后由系统生成），**没有可聚焦控件可关联** ——
              用 Field 就成了一个包着 <div> 的游离 <label>，读屏念不出对应关系，
              UX 扫描也因此把它记成「label 未与控件关联」。这里的正解不是补 htmlFor
              （没有控件可指），而是让它根本不是 label。视觉沿用 Field 的排版。
            */}
            <div className="grid gap-1.5 text-sm">
              <span className="text-[#666666]">产品编号</span>
              <div className="flex min-h-9 items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 text-sm text-[#666666]">
                {row?.productCode ?? '保存后由系统自动生成'}
              </div>
            </div>
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
                  onChange={(event) => {
                    setSupplierTouched(true)
                    setField('supplierId', event.target.value)
                  }}
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
              {/*
                建供应商档案要 supply_chain_master_data_manage，而建 SKU 只要 market_sku_manage
                也行 —— 市场角色能建自采 SKU 却建不了档案。改造前他们至少能手打一个名字，
                现在下拉里没有就真的没有了；不给出路的话这是一次能力回退。
              */}
              {!canCreateSupplier && supplierChoices.length === 0 && (
                <p className="text-xs text-[#888888]">
                  暂无可选供应商。供应商档案由供应链管理员在「资料配置 → 供应商」维护，请联系其先建档。
                </p>
              )}
              {unlinkedLegacyText && !form.supplierId && (
                <div className="grid gap-1 text-xs text-[#D4820A]">
                  <p>
                    原填写「{unlinkedLegacyText}」未匹配到供应商档案。选择档案即完成关联；
                    保持不动则保留原文本。
                  </p>
                  {/*
                    必须给一个**显式**的清空入口：下拉当前就停在「未指定」，再点一次它
                    不会触发原生 change —— 没有其它可选档案时（比如市场角色、且档案表为空）
                    用户根本没有办法把 supplierTouched 置上，那段旧文本就永远删不掉。
                  */}
                  {!supplierTouched && (
                    <button
                      type="button"
                      className="justify-self-start underline"
                      onClick={() => setSupplierTouched(true)}
                    >
                      清空原文本
                    </button>
                  )}
                  {supplierTouched && <p>保存后将清空该文本。</p>}
                </div>
              )}
              {supplierFormOpen && (
                <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] p-2">
                  <Input
                    aria-label="新供应商名称 *"
                    required
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
              <Field label="供应链采购价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.supplyChainPurchasePrice} onChange={(event) => setField('supplyChainPurchasePrice', event.target.value)} /></Field>
              <Field label="门店进货价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.storePurchasePrice} onChange={(event) => setField('storePurchasePrice', event.target.value)} /></Field>
              <Field label="市场员工购价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.marketStaffPurchasePrice} onChange={(event) => setField('marketStaffPurchasePrice', event.target.value)} /></Field>
              <Field label="顾客零售价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.retailPrice} onChange={(event) => setField('retailPrice', event.target.value)} /></Field>
              <Field label="核算价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.accountingPrice} onChange={(event) => setField('accountingPrice', event.target.value)} /></Field>
              <Field label="市场折扣（25 表示 25%）"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.marketPurchaseDiscount} onChange={(event) => setField('marketPurchaseDiscount', event.target.value)} /></Field>
              <Field label="市场进货价">
                <div className="space-y-1">
                  {form.sourceType === '供应链' && (
                    <Select value={form.marketPurchasePriceMode} onChange={(event) => setField('marketPurchasePriceMode', event.target.value as '公式' | '手工覆盖')}>
                      <option value="公式">按公式计算</option>
                      <option value="手工覆盖">手工覆盖</option>
                    </Select>
                  )}
                  <Input
                    type="number" min="0" step="0.01" max="9999999999.99"
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
              <Field label="自采实际进货价"><Input type="number" min="0" step="0.01" max="9999999999.99" value={form.itemCompanyPurchasePrice} onChange={(event) => setField('itemCompanyPurchasePrice', event.target.value)} /></Field>
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
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting || savingSupplier}>取消</Button>
        <Button onClick={submit} disabled={submitting || savingSupplier}>{submitting ? '保存中...' : '保存'}</Button>
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
