'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createInventorySkuComposition,
  updateInventorySkuComposition,
} from '@/actions/inventory/mappings'
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type {
  InventoryCompositionOptions,
  InventoryCompositionRow,
} from '@/lib/inventory/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Select } from '@/components/ui/select'
import { normalizePage } from '@/lib/paging'

interface ComponentFormRow {
  inventorySkuId: string
  quantityPerSaleUnit: number
}

function configurationBadge(status: InventoryCompositionRow['configurationStatus']) {
  if (status === 'configured') {
    return <Badge variant="outline" className="border-[#3D8A5A] bg-[#F0F9F2] text-[#3D8A5A]">已配置</Badge>
  }
  if (status === 'invalid') {
    return <Badge variant="outline" className="border-[#B7791F] bg-[#FFFBEB] text-[#B7791F]">含停用商品</Badge>
  }
  return <Badge variant="outline" className="border-[#C0322A] bg-[#FFF1F0] text-[#C0322A]">未配置</Badge>
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export default function InventorySkuMappingsPage({
  rows,
  total,
  options,
  canCreate,
  canUpdate,
}: {
  rows: InventoryCompositionRow[]
  total: number
  options: InventoryCompositionOptions
  canCreate: boolean
  canUpdate: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const page = normalizePage(get('page', '1'))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20
  const [searchInput, setSearchInput] = useState(get('q'))
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [editing, setEditing] = useState<InventoryCompositionRow | null>(null)
  const [components, setComponents] = useState<ComponentFormRow[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [setMany])

  function openEditor(row: InventoryCompositionRow) {
    setEditing(row)
    setComponents(row.components.length > 0
      ? row.components.map((component) => ({
          inventorySkuId: component.inventorySkuId,
          quantityPerSaleUnit: component.quantityPerSaleUnit,
        }))
      : [{ inventorySkuId: '', quantityPerSaleUnit: 1 }])
  }

  function updateComponent(index: number, patch: Partial<ComponentFormRow>) {
    setComponents((current) => current.map((component, componentIndex) =>
      componentIndex === index ? { ...component, ...patch } : component))
  }

  function removeComponent(index: number) {
    setComponents((current) => current.filter((_, componentIndex) => componentIndex !== index))
  }

  async function submit() {
    if (!editing) return
    if (components.length === 0 || components.some((component) => !component.inventorySkuId)) {
      toast.error('请至少添加一个库存商品')
      return
    }
    if (components.some((component) => !Number.isInteger(component.quantityPerSaleUnit) || component.quantityPerSaleUnit <= 0)) {
      toast.error('组成数量必须为正整数')
      return
    }
    if (new Set(components.map((component) => component.inventorySkuId)).size !== components.length) {
      toast.error('同一库存商品不能重复添加')
      return
    }
    setSaving(true)
    try {
      const input = {
        productSkuId: editing.productSkuId,
        components,
        expectedUpdatedAt: editing.updatedAt,
      }
      if (editing.configurationStatus === 'unconfigured') {
        await createInventorySkuComposition(input)
      } else {
        await updateInventorySkuComposition(input)
      }
      toast.success('销售商品组成已保存')
      setEditing(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '保存销售商品组成失败'))
    } finally {
      setSaving(false)
    }
  }

  const columns: Column<InventoryCompositionRow>[] = [
    {
      key: 'productSkuName',
      header: '销售商品（家居产品）',
      cell: (row) => (
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium">
            {row.productSkuName}
            {!row.productSkuEnabled && <Badge variant="outline">销售商品已停用</Badge>}
          </div>
          <div className="font-mono text-xs text-[#888888]">{row.productSkuId}</div>
        </div>
      ),
    },
    {
      key: 'components',
      header: '包含的库存商品及数量',
      cell: (row) => row.components.length === 0 ? (
        <span className="text-sm text-[#C0322A]">尚未配置库存组成</span>
      ) : (
        <div className="space-y-2 py-1">
          {row.components.map((component) => (
            <div key={component.inventorySkuId} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{component.inventorySkuName}</span>
              {component.inventorySkuSpecName && <span className="text-[#666666]">{component.inventorySkuSpecName}</span>}
              <span className="font-mono text-xs text-[#888888]">{component.inventorySkuCode}</span>
              <span className="font-semibold text-[var(--primary)]">× {component.quantityPerSaleUnit}</span>
              {!component.inventorySkuActive && <span className="text-xs text-[#B7791F]">已停用</span>}
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'configurationStatus',
      header: '配置状态',
      cell: (row) => configurationBadge(row.configurationStatus),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => {
        const allowed = row.configurationStatus === 'unconfigured' ? canCreate : canUpdate
        return allowed ? (
          <Button variant="link" size="sm" className="h-auto px-1" onClick={() => openEditor(row)}>
            <Pencil /> {row.configurationStatus === 'unconfigured' ? '配置组成' : '修改组成'}
          </Button>
        ) : '—'
      },
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="size-5 text-[var(--primary)]" />
          <div>
            <h1 className="text-xl font-medium">销售商品组成</h1>
            <p className="text-sm text-[#888888]">设置每件销售商品实际包含的库存商品及数量，提货时按整套自动出库。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={get('status')}
            onChange={(event) => setMany({ status: event.target.value, page: '' })}
            className="w-36"
            aria-label="配置状态筛选"
          >
            <option value="">全部状态</option>
            <option value="configured">已配置</option>
            <option value="unconfigured">未配置</option>
            <option value="invalid">含停用商品</option>
          </Select>
          <Input
            className="w-72"
            placeholder="搜索销售商品、库存编号或名称"
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
          <Button variant="outline" onClick={() => {
            setSearchInput('')
            setMany({ q: '', status: '', page: '' })
          }}>
            <RotateCcw /> 重置
          </Button>
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无家居产品销售商品" />
      <Pagination
        total={total}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setMany({ page: String(next) })}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogHeader>
          <DialogTitle>配置销售商品组成</DialogTitle>
        </DialogHeader>
        {editing && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-[var(--border)] bg-[#FAFAFA] p-3">
              <div className="font-medium">{editing.productSkuName}</div>
              <div className="mt-1 font-mono text-xs text-[#888888]">{editing.productSkuId}</div>
            </div>
            <div className="space-y-3">
              {components.map((component, index) => {
                const selectedActive = options.inventorySkus.some((sku) => sku.skuId === component.inventorySkuId)
                const legacyComponent = editing.components.find((item) => item.inventorySkuId === component.inventorySkuId)
                return (
                  <div key={`${index}-${component.inventorySkuId}`} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-end gap-2">
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>库存商品</span>
                      <Select
                        value={component.inventorySkuId}
                        onChange={(event) => updateComponent(index, { inventorySkuId: event.target.value })}
                      >
                        <option value="">请选择库存商品</option>
                        {!selectedActive && legacyComponent && (
                          <option value={legacyComponent.inventorySkuId}>
                            [已停用] {legacyComponent.inventorySkuCode} · {legacyComponent.inventorySkuName}
                          </option>
                        )}
                        {options.inventorySkus.map((sku) => (
                          <option key={sku.skuId} value={sku.skuId}>
                            {sku.productCode} · {sku.productName}{sku.specName ? ` · ${sku.specName}` : ''}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="block space-y-1.5 text-sm font-medium">
                      <span>每件数量</span>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        // quantity_per_sale_unit 是 integer 列，上界即 int4 上限；
                        // 超出会让 PG 抛 22003，生产脱敏后只剩一个通用 500 页
                        max={2147483647}
                        value={component.quantityPerSaleUnit}
                        onChange={(event) => updateComponent(index, {
                          quantityPerSaleUnit: Number(event.target.value),
                        })}
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="删除库存商品"
                      onClick={() => removeComponent(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setComponents((current) => [
                ...current,
                { inventorySkuId: '', quantityPerSaleUnit: 1 },
              ])}
            >
              <Plus /> 添加库存商品
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
          <Button disabled={saving} onClick={submit}>{saving ? '保存中...' : '保存组成'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
