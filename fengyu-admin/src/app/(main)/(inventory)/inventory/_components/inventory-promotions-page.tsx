'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, CalendarRange, Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createInventoryPromotionPlan,
  disableInventoryPromotionPlan,
  updateInventoryPromotionPlan,
} from '@/actions/inventory/promotions'
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type {
  InventoryPromotionPlanInput,
  InventoryPromotionPlanRow,
} from '@/lib/inventory/types'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { InventorySkuSearchSelect } from './inventory-sku-search-select'
import { Textarea } from '@/components/ui/textarea'
import { normalizePage } from '@/lib/paging'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

type EditorMode = 'create' | 'edit' | 'view' | null

interface MarketOption {
  locationId: string
  name: string
}

interface PromotionDraftItem {
  key: string
  skuId: string
  /** 编辑已有方案时带回的商品名，给选择器回显兜底（该商品可能已停用、搜不出来）。换商品时清掉。 */
  skuLabel?: string
  marketUnitDiscount: string
  reportMinQuantity: string
  reportMaxQuantity: string
  remark: string
}

interface PromotionForm {
  name: string
  ruleType: '单品阶梯' | '组合'
  startsAt: string
  endsAt: string
  scopeMarketId: string
  status: '启用' | '停用'
  remark: string
  items: PromotionDraftItem[]
}

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function newDraftItem(): PromotionDraftItem {
  return {
    key: `${Date.now()}-${Math.random()}`,
    skuId: '',
    marketUnitDiscount: '0',
    reportMinQuantity: '',
    reportMaxQuantity: '',
    remark: '',
  }
}

function emptyForm(defaultMarketId = ''): PromotionForm {
  const today = todayYmd()
  return {
    name: '',
    ruleType: '单品阶梯',
    startsAt: today,
    endsAt: today,
    scopeMarketId: defaultMarketId,
    status: '启用',
    remark: '',
    items: [newDraftItem()],
  }
}

function toForm(row: InventoryPromotionPlanRow): PromotionForm {
  return {
    name: row.name,
    ruleType: row.ruleType,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    scopeMarketId: row.scopeMarketId ?? '',
    status: row.status,
    remark: row.remark ?? '',
    items: row.items.map((item) => ({
      key: String(item.id),
      skuId: item.skuId,
      skuLabel: item.skuName,
      marketUnitDiscount: String(item.marketUnitDiscount),
      reportMinQuantity: item.reportMinQuantity == null ? '' : String(item.reportMinQuantity),
      reportMaxQuantity: item.reportMaxQuantity == null ? '' : String(item.reportMaxQuantity),
      remark: item.remark ?? '',
    })),
  }
}

function optionalText(value: string): string | null {
  return value.trim() || null
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatDateRange(startsAt: string, endsAt: string) {
  const start = startsAt.slice(0, 10)
  const end = endsAt.slice(0, 10)
  return start === end ? start : `${start} 至 ${end}`
}

function formatQuantityRange(min: number | null | undefined, max: number | null | undefined) {
  if (min == null && max == null) return '不限数量'
  if (min == null) return `不高于 ${max}`
  if (max == null) return `${min} 起`
  return `${min} - ${max}`
}

export default function InventoryPromotionsPage({
  rows,
  marketOptions,
  canCreate,
  canUpdate,
  canViewPrice,
  canManageGlobal,
}: {
  rows: InventoryPromotionPlanRow[]
  marketOptions: MarketOption[]
  canCreate: boolean
  canUpdate: boolean
  canViewPrice: boolean
  canManageGlobal: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get('q'))
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mode, setMode] = useState<EditorMode>(null)
  const [selectedPlan, setSelectedPlan] = useState<InventoryPromotionPlanRow | null>(null)
  const [form, setForm] = useState<PromotionForm>(() => emptyForm())
  const [saving, setSaving] = useState(false)
  const [disableTarget, setDisableTarget] = useState<InventoryPromotionPlanRow | null>(null)
  const [disabling, setDisabling] = useState(false)

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [setMany])

  const filteredRows = useMemo(() => {
    const keyword = searchInput.trim().toLowerCase()
    const marketId = get('market')
    const status = get('status')
    return rows.filter((row) => {
      if (marketId && row.scopeMarketId !== marketId) return false
      if (status && row.status !== status) return false
      if (!keyword) return true
      return [row.planNo, row.name, row.scopeMarketName, row.remark]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(keyword))
    })
  }, [get, rows, searchInput])

  // 分页在**筛选之后**做：本页三个筛选都在上面的 useMemo 里，
  // 若先切页再筛，用户只会筛到当前页那一屏的匹配项。
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size'))) ? Number(get('size')) : 20
  const rawPage = normalizePage(get('page', '1'))
  // searchInput 是本地 state，打字时 filteredRows 立刻变短，而重置 page 的 setMany
  // 要等 300ms debounce —— 这中间 page 会越界，不夹一下会闪一屏空列表。
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const page = Math.min(rawPage, totalPages)
  const pagedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize)

  // 夹取只解决了「渲染出空列表」，URL 里的越界页码还在：Pagination 收到的是夹取**后**的
  // page，它自己的越界自纠 effect 就永远不触发。残留的 `?page=99` 会在用户清掉筛选、
  // 结果变多时把人莫名带到第 99 页。这里主动清掉。
  // 条件守卫保证只在越界时执行一次：setMany 之后 rawPage 变回 1，条件不再成立，不会自循环
  // （本仓库在 inventory-docs-page 有过 useEffect 自循环把下拉卡死的 P0，这里刻意写严）。
  useEffect(() => {
    if (rawPage > totalPages) setMany({ page: '' })
  }, [rawPage, totalPages, setMany])

  const canCreatePlan = canCreate && (canManageGlobal || marketOptions.length > 0)
  const readOnly = mode === 'view'

  function closeEditor(open: boolean) {
    if (open) return
    setMode(null)
    setSelectedPlan(null)
  }

  function openCreate() {
    setSelectedPlan(null)
    setForm(emptyForm(marketOptions.length === 1 ? marketOptions[0].locationId : ''))
    setMode('create')
  }

  function openPlan(row: InventoryPromotionPlanRow, nextMode: Exclude<EditorMode, 'create' | null>) {
    setSelectedPlan(row)
    setForm(toForm(row))
    setMode(nextMode)
  }

  function setField<K extends Exclude<keyof PromotionForm, 'items'>>(key: K, value: PromotionForm[K]) {
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  function updateItem(index: number, patch: Partial<PromotionDraftItem>) {
    setForm((previous) => ({
      ...previous,
      items: previous.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }

  function removeItem(index: number) {
    setForm((previous) => ({
      ...previous,
      items: previous.items.filter((_, itemIndex) => itemIndex !== index),
    }))
  }

  function validateAndBuildInput(): InventoryPromotionPlanInput | null {
    const name = form.name.trim()
    if (!name) {
      toast.error('请填写方案名称')
      return null
    }
    if (!form.startsAt || !form.endsAt) {
      toast.error('请选择福利有效期')
      return null
    }
    if (form.endsAt < form.startsAt) {
      toast.error('结束日期不能早于开始日期')
      return null
    }
    if (form.items.length === 0) {
      toast.error('至少需要一条福利产品明细')
      return null
    }
    if (form.ruleType === '组合' && form.items.length < 2) {
      toast.error('组合福利至少需要两条不同产品明细')
      return null
    }

    const seenSkuIds = new Set<string>()

    for (const [index, item] of form.items.entries()) {
      const itemNumber = index + 1
      const discount = numberOrNull(item.marketUnitDiscount)
      const minQuantity = numberOrNull(item.reportMinQuantity)
      const maxQuantity = numberOrNull(item.reportMaxQuantity)
      if (!item.skuId) {
        toast.error(`请选择第 ${itemNumber} 条福利产品`)
        return null
      }
      if (form.ruleType === '组合' && seenSkuIds.has(item.skuId)) {
        toast.error('组合福利中同一产品只能出现一次')
        return null
      }
      seenSkuIds.add(item.skuId)
      if (discount == null || discount < 0) {
        toast.error(`第 ${itemNumber} 条单价优惠必须是非负数字`)
        return null
      }
      if (minQuantity !== null && minQuantity <= 0) {
        toast.error(`第 ${itemNumber} 条数量下限必须大于 0`)
        return null
      }
      if (form.ruleType === '组合' && minQuantity === null) {
        toast.error(`请填写第 ${itemNumber} 条组合产品的数量下限`)
        return null
      }
      if (maxQuantity !== null && maxQuantity <= 0) {
        toast.error(`第 ${itemNumber} 条数量上限必须大于 0`)
        return null
      }
      if (minQuantity !== null && maxQuantity !== null && maxQuantity < minQuantity) {
        toast.error(`第 ${itemNumber} 条数量上限不能小于下限`)
        return null
      }
    }

    return {
      name,
      ruleType: form.ruleType,
      startsAt: form.startsAt,
      endsAt: form.endsAt,
      scopeMarketId: form.scopeMarketId || null,
      status: form.status,
      remark: optionalText(form.remark),
      items: form.items.map((item) => ({
        skuId: item.skuId,
        marketUnitDiscount: numberOrNull(item.marketUnitDiscount) ?? 0,
        reportMinQuantity: numberOrNull(item.reportMinQuantity),
        reportMaxQuantity: numberOrNull(item.reportMaxQuantity),
        remark: optionalText(item.remark),
      })),
    }
  }

  async function save() {
    if (mode !== 'create' && mode !== 'edit') return
    const input = validateAndBuildInput()
    if (!input) return
    setSaving(true)
    try {
      if (mode === 'edit' && selectedPlan) {
        await updateInventoryPromotionPlan(selectedPlan.id, input)
        toast.success('福利方案已更新')
      } else {
        await createInventoryPromotionPlan(input)
        toast.success('福利方案已创建')
      }
      closeEditor(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, mode === 'edit' ? '更新福利方案失败' : '创建福利方案失败'))
    } finally {
      setSaving(false)
    }
  }

  async function disable() {
    if (!disableTarget) return
    setDisabling(true)
    try {
      await disableInventoryPromotionPlan(disableTarget.id)
      toast.success('福利方案已停用')
      setDisableTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '停用福利方案失败'))
    } finally {
      setDisabling(false)
    }
  }

  const columns: Column<InventoryPromotionPlanRow>[] = [
    {
      key: 'planNo',
      header: '方案编号',
      cell: (row) => <span className="font-mono text-xs">{row.planNo}</span>,
    },
    {
      key: 'name',
      header: '方案名称',
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: 'ruleType',
      header: '规则',
      cell: (row) => row.ruleType,
    },
    {
      key: 'scopeMarketName',
      header: '适用市场',
      cell: (row) => row.scopeMarketName ?? '全部市场',
    },
    {
      key: 'dateRange',
      header: '有效期',
      cell: (row) => formatDateRange(row.startsAt, row.endsAt),
    },
    {
      key: 'itemCount',
      header: '福利产品',
      cell: (row) => `${row.itemCount} 项`,
    },
    {
      key: 'status',
      header: '状态',
      cell: (row) => (
        <Badge
          variant="outline"
          className={row.status === '启用'
            ? 'border-[#3D8A5A] bg-[#F0F9F2] text-[#3D8A5A]'
            : 'border-[#888888] bg-[#F5F5F5] text-[#888888]'}
        >
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => {
        const canEditRow = canUpdate && (row.scopeMarketId !== null || canManageGlobal)
        return (
          <div className="flex items-center gap-1">
            <Button variant="link" size="sm" className="h-auto px-1" onClick={() => openPlan(row, 'view')}>
              <Eye /> 查看
            </Button>
            {canEditRow && (
              <Button variant="link" size="sm" className="h-auto px-1" onClick={() => openPlan(row, 'edit')}>
                <Pencil /> 编辑
              </Button>
            )}
            {canEditRow && row.status === '启用' && (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-1 text-[var(--destructive)]"
                onClick={() => setDisableTarget(row)}
              >
                <Ban /> 停用
              </Button>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <CalendarRange className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">市场报货福利方案</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={get('market')}
            onChange={(event) => setMany({ market: event.target.value, page: '' })}
            className="w-36"
            aria-label="适用市场筛选"
          >
            <option value="">全部市场</option>
            {marketOptions.map((market) => (
              <option key={market.locationId} value={market.locationId}>{market.name}</option>
            ))}
          </Select>
          <Select
            value={get('status')}
            onChange={(event) => setMany({ status: event.target.value, page: '' })}
            className="w-28"
            aria-label="福利方案状态筛选"
          >
            <option value="">全部状态</option>
            <option value="启用">启用</option>
            <option value="停用">停用</option>
          </Select>
          <Input
            className="w-60"
            placeholder="搜索方案编号、名称"
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
          <Button variant="outline" onClick={() => {
            setSearchInput('')
            setMany({ q: '', market: '', status: '', page: '' })
          }}>
            重置
          </Button>
          {canCreatePlan && (
            <Button onClick={openCreate}>
              <Plus /> 新建方案
            </Button>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={pagedRows} emptyText="暂无市场报货福利方案" />
      <Pagination
        total={filteredRows.length}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setMany({ page: String(next) })}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      <Dialog open={mode !== null} onOpenChange={closeEditor} className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新建市场报货福利方案' : mode === 'edit' ? '编辑市场报货福利方案' : '福利方案详情'}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 max-h-[68vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <span className="block text-sm font-medium text-[#666666]">方案编号</span>
              <div className="flex min-h-9 items-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)] px-3 text-sm text-[#666666]">
                {selectedPlan?.planNo ?? '保存后由系统自动生成'}
              </div>
            </div>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">方案名称 *</span>
              <Input value={form.name} readOnly={readOnly} disabled={saving} onChange={(event) => setField('name', event.target.value)} />
            </label>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">规则类型</span>
              <Select value={form.ruleType} disabled={readOnly || saving} onChange={(event) => setField('ruleType', event.target.value as PromotionForm['ruleType'])}>
                <option value="单品阶梯">单品阶梯</option>
                <option value="组合">组合</option>
              </Select>
            </label>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">适用市场</span>
              <Select
                value={form.scopeMarketId}
                disabled={readOnly || saving}
                onChange={(event) => setField('scopeMarketId', event.target.value)}
              >
                {(canManageGlobal || form.scopeMarketId === '') && <option value="">全部市场</option>}
                {marketOptions.map((market) => (
                  <option key={market.locationId} value={market.locationId}>{market.name}</option>
                ))}
              </Select>
            </label>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">开始日期 *</span>
              <DatePicker value={form.startsAt} disabled={readOnly || saving} onValueChange={(value) => setField('startsAt', value)} aria-label="开始日期" />
            </label>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">结束日期 *</span>
              <DatePicker value={form.endsAt} disabled={readOnly || saving} onValueChange={(value) => setField('endsAt', value)} aria-label="结束日期" />
            </label>
            <label className="block space-y-2">
              <span className="block text-sm font-medium">状态</span>
              <Select value={form.status} disabled={readOnly || saving} onChange={(event) => setField('status', event.target.value as '启用' | '停用')}>
                <option value="启用">启用</option>
                <option value="停用">停用</option>
              </Select>
            </label>
            <label className="block space-y-2 sm:col-span-2 lg:col-span-3">
              <span className="block text-sm font-medium">备注</span>
              <Textarea value={form.remark} readOnly={readOnly} disabled={saving} onChange={(event) => setField('remark', event.target.value)} />
            </label>
          </div>

          <div className="space-y-3 border-t border-[var(--border)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">福利产品明细</h2>
                <p className="mt-1 text-xs text-[#666666]">市场报货时，真实单价固定按商品资料的市场进货价减单价优惠计算。</p>
              </div>
              {!readOnly && (
                <Button variant="outline" size="sm" onClick={() => setForm((previous) => ({ ...previous, items: [...previous.items, newDraftItem()] }))} disabled={saving}>
                  <Plus /> 新增明细
                </Button>
              )}
            </div>

            {form.items.map((item, index) => {
              return (
                <div key={item.key} className="space-y-3 border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">明细 {index + 1}</span>
                    {!readOnly && form.items.length > 1 && (
                      <Button variant="ghost" size="sm" className="text-[var(--destructive)]" onClick={() => removeItem(index)} disabled={saving}>
                        <Trash2 /> 删除
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="block space-y-2 sm:col-span-2">
                      <span className="block text-sm font-medium">库存商品 *</span>
                      <InventorySkuSearchSelect
                        value={item.skuId}
                        disabled={readOnly || saving}
                        onChange={(skuId) => updateItem(index, { skuId, skuLabel: undefined })}
                        placeholder="请选择库存商品"
                        ariaLabel={`明细 ${index + 1} 库存商品`}
                        selectedLabel={item.skuLabel}
                      />
                    </label>
                    <label className="block space-y-2">
                      <span className="block text-sm font-medium">{form.ruleType === '组合' ? '组合数量下限 *' : '数量下限'}</span>
                      <Input type="number" min="0" step="1" max="9999999999.99" placeholder={form.ruleType === '组合' ? '必填' : '留空不限'} value={item.reportMinQuantity} readOnly={readOnly} disabled={saving} onChange={(event) => updateItem(index, { reportMinQuantity: event.target.value })} />
                    </label>
                    <label className="block space-y-2">
                      <span className="block text-sm font-medium">数量上限</span>
                      <Input type="number" min="0" step="1" max="9999999999.99" placeholder="留空不限" value={item.reportMaxQuantity} readOnly={readOnly} disabled={saving} onChange={(event) => updateItem(index, { reportMaxQuantity: event.target.value })} />
                    </label>
                    {canViewPrice && (
                      <>
                        <label className="block space-y-2">
                          <span className="block text-sm font-medium">单价优惠 *</span>
                          <Input type="number" min="0" step="0.01" max="9999999999.99" value={item.marketUnitDiscount} readOnly={readOnly} disabled={saving} onChange={(event) => updateItem(index, { marketUnitDiscount: event.target.value })} />
                        </label>
                      </>
                    )}
                    <label className="block space-y-2 sm:col-span-2 lg:col-span-4">
                      <span className="block text-sm font-medium">明细备注</span>
                      <Textarea value={item.remark} readOnly={readOnly} disabled={saving} onChange={(event) => updateItem(index, { remark: event.target.value })} />
                    </label>
                  </div>
                  {readOnly && (
                    <p className="text-xs text-[#666666]">适用数量：{formatQuantityRange(numberOrNull(item.reportMinQuantity), numberOrNull(item.reportMaxQuantity))}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => closeEditor(false)} disabled={saving}>{readOnly ? '关闭' : '取消'}</Button>
          {!readOnly && <Button onClick={save} loading={saving}>{mode === 'edit' ? '保存修改' : '创建方案'}</Button>}
        </DialogFooter>
      </Dialog>

      <AlertDialog open={!!disableTarget} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogTitle>停用福利方案</AlertDialogTitle>
        <AlertDialogDescription>
          确定停用福利方案「{disableTarget?.name}」吗？已经生成的市场报货单仍保留其当时的优惠快照，后续报货将不再提取本方案。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDisableTarget(null)} disabled={disabling}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={disable} disabled={disabling}>确认停用</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
