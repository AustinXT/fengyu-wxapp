'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Ban, Link2, Plus, RotateCcw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createInventorySkuMapping,
  updateInventorySkuMapping,
} from '@/actions/inventory/mappings'
import { actionErrorMessage } from '@/lib/action-error'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type {
  InventorySkuMappingOptions,
  InventorySkuMappingRow,
} from '@/lib/inventory/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

interface MappingForm {
  productSkuId: string
  inventorySkuId: string
}

const EMPTY_FORM: MappingForm = { productSkuId: '', inventorySkuId: '' }

function statusBadge(enabled: boolean, unavailable: boolean) {
  if (unavailable) {
    return <Badge variant="outline" className="border-[#B7791F] bg-[#FFFBEB] text-[#B7791F]">主数据已停用</Badge>
  }
  return (
    <Badge
      variant="outline"
      className={enabled
        ? 'border-[#3D8A5A] bg-[#F0F9F2] text-[#3D8A5A]'
        : 'border-[#888888] bg-[#F5F5F5] text-[#888888]'}
    >
      {enabled ? '启用' : '停用'}
    </Badge>
  )
}

export default function InventorySkuMappingsPage({
  rows,
  options,
  canCreate,
  canUpdate,
}: {
  rows: InventorySkuMappingRow[]
  options: InventorySkuMappingOptions
  canCreate: boolean
  canUpdate: boolean
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get('q'))
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<MappingForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setMany({ q: value }), 300)
  }, [setMany])

  function openCreate() {
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  async function submit() {
    if (!form.productSkuId || !form.inventorySkuId) {
      toast.error('请选择销售 SKU 和库存 SKU')
      return
    }
    setSaving(true)
    try {
      await createInventorySkuMapping(form)
      toast.success('SKU 映射已创建')
      setDialogOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '创建 SKU 映射失败'))
    } finally {
      setSaving(false)
    }
  }

  async function toggle(row: InventorySkuMappingRow) {
    setUpdatingId(row.id)
    try {
      await updateInventorySkuMapping(row.id, !row.isActive)
      toast.success(row.isActive ? 'SKU 映射已停用' : 'SKU 映射已启用')
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, '更新 SKU 映射失败'))
    } finally {
      setUpdatingId(null)
    }
  }

  const columns: Column<InventorySkuMappingRow>[] = [
    {
      key: 'productSkuName',
      header: '销售 SKU（家居产品）',
      cell: (row) => (
        <div className="space-y-1">
          <div className="font-medium">{row.productSkuName}</div>
          <div className="font-mono text-xs text-[#888888]">{row.productSkuId}</div>
        </div>
      ),
    },
    {
      key: 'inventorySkuName',
      header: '库存 SKU',
      cell: (row) => (
        <div className="space-y-1">
          <div className="font-medium">{row.inventorySkuName}</div>
          <div className="font-mono text-xs text-[#888888]">{row.inventorySkuCode} · {row.inventorySkuId}</div>
        </div>
      ),
    },
    {
      key: 'isActive',
      header: '映射状态',
      cell: (row) => statusBadge(row.isActive, !row.productSkuEnabled || !row.inventorySkuActive),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => canUpdate ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-1"
          disabled={updatingId === row.id}
          onClick={() => toggle(row)}
        >
          {row.isActive ? <><Ban /> 停用</> : <><RotateCcw /> 启用</>}
        </Button>
      ) : '—',
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link2 className="size-5 text-[var(--primary)]" />
          <div>
            <h1 className="text-xl font-medium">销售 SKU 映射</h1>
            <p className="text-sm text-[#888888]">提货时由店长从已映射的库存 SKU 中选择实际交付品。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={get('status')}
            onChange={(event) => setMany({ status: event.target.value })}
            className="w-28"
            aria-label="映射状态筛选"
          >
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </Select>
          <Input
            className="w-72"
            placeholder="搜索销售 SKU、库存编号或名称"
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
          />
          <Button variant="outline" onClick={() => {
            setSearchInput('')
            setMany({ q: '', status: '' })
          }}>
            重置
          </Button>
          {canCreate && (
            <Button onClick={openCreate}>
              <Plus /> 新建映射
            </Button>
          )}
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无 SKU 映射" />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>新建销售 SKU 映射</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5 text-sm font-medium">
            <span>销售 SKU（仅家居产品）</span>
            <Input
              list="pickup-product-sku-options"
              value={form.productSkuId}
              placeholder="输入或选择销售 SKU ID"
              onChange={(event) => setForm((prev) => ({ ...prev, productSkuId: event.target.value }))}
            />
            <datalist id="pickup-product-sku-options">
              {options.productSkus.map((sku) => (
                <option key={sku.skuId} value={sku.skuId} label={sku.specName} />
              ))}
            </datalist>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>库存 SKU</span>
            <Input
              list="pickup-inventory-sku-options"
              value={form.inventorySkuId}
              placeholder="输入或选择库存 SKU ID"
              onChange={(event) => setForm((prev) => ({ ...prev, inventorySkuId: event.target.value }))}
            />
            <datalist id="pickup-inventory-sku-options">
              {options.inventorySkus.map((sku) => (
                <option
                  key={sku.skuId}
                  value={sku.skuId}
                  label={`${sku.productCode} · ${sku.productName}${sku.specName ? ` · ${sku.specName}` : ''}`}
                />
              ))}
            </datalist>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
          <Button disabled={saving} onClick={submit}>{saving ? '保存中...' : '保存映射'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
