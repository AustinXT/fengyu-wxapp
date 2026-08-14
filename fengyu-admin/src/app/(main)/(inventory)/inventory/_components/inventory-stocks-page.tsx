'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Boxes } from 'lucide-react'
import { toast } from 'sonner'
import { exportInventoryLots } from '@/actions/inventory/stocks'
import type { InventoryLocationFilterOptions, InventoryLotRow } from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { ExportButton } from '@/components/ui/export-button'
import InventoryLocationFilter from '@/components/inventory-location-filter'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { exportToXlsx } from '@/lib/export-xlsx'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

function formatDate(v: string | null | undefined) {
  return v ? v.slice(0, 10) : '—'
}

export default function InventoryStocksPage({
  rows,
  total,
  canViewPrice,
  canExport,
  locationFilterOptions,
  selectedLocationId,
}: {
  rows: InventoryLotRow[]
  total: number
  canViewPrice: boolean
  canExport: boolean
  locationFilterOptions: InventoryLocationFilterOptions
  selectedLocationId: string | null
}) {
  const { get, setMany } = useUrlFilters()
  const searchParams = useSearchParams()
  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const page = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [debounceRef, setMany])

  const handleExport = useCallback(async () => {
    if (!selectedLocationId) {
      toast.info('当前账号没有可访问的库存主体')
      return
    }
    const raw = Object.fromEntries(searchParams.entries())
    delete raw.type
    raw.location = selectedLocationId
    const { rows: exportRows, truncated, canViewPrice: exportCanViewPrice } = await exportInventoryLots(raw)
    if (exportRows.length === 0) {
      toast.info('当前筛选无数据可导出')
      return
    }
    await exportToXlsx({
      filename: '实时库存',
      sheetName: '实时库存',
      columns: [
        { header: '库存主体', width: 20, accessor: (r) => r.locationName ?? r.locationId },
        { header: '主体类型', width: 10, accessor: (r) => r.locationType },
        { header: '批次 ID', width: 12, accessor: (r) => r.id },
        { header: 'SKU', width: 18, accessor: (r) => r.skuId },
        { header: '产品', width: 28, accessor: (r) => r.skuName },
        { header: '规格', width: 16, accessor: (r) => r.specName },
        { header: '供应商', width: 18, accessor: (r) => r.supplier },
        { header: '系列', width: 18, accessor: (r) => r.productSeries },
        { header: '批号', width: 16, accessor: (r) => r.batchNo },
        { header: '效期', width: 12, accessor: (r) => formatDate(r.expiryDate) },
        { header: '赠送', width: 8, accessor: (r) => (r.isGift ? '是' : '否') },
        { header: '库存', width: 10, accessor: (r) => r.quantityOnHand },
        ...(exportCanViewPrice
          ? [
              { header: '供应链成本', width: 14, accessor: (r: InventoryLotRow) => r.supplyChainUnitCost },
              { header: '市场实际价', width: 14, accessor: (r: InventoryLotRow) => r.marketActualUnitPrice },
              { header: '门店实际价', width: 14, accessor: (r: InventoryLotRow) => r.storeActualUnitPrice },
            ]
          : []),
        { header: '备注', width: 24, accessor: (r) => r.remark },
        { header: '更新时间', width: 12, accessor: (r) => formatDate(r.updatedAt) },
      ],
      rows: exportRows,
    })
    if (truncated) toast.warning('数据量过大，已导出前 10000 条，请缩小筛选范围')
  }, [searchParams, selectedLocationId])

  const columns: Column<InventoryLotRow>[] = [
    {
      key: 'locationName',
      header: '库存主体',
      cell: (r) => (
        <div>
          <div className="font-medium">{r.locationName ?? r.locationId}</div>
          <div className="text-xs text-[#888888]">{r.locationType ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'skuName',
      header: '产品',
      cell: (r) => (
        <div>
          <div className="font-medium">{r.skuName}</div>
          <div className="font-mono text-xs text-[#888888]">{r.skuId}</div>
        </div>
      ),
    },
    {
      key: 'id',
      header: '批次 ID',
      cell: (r) => <span className="font-mono text-xs text-[#888888]">{r.id}</span>,
    },
    { key: 'specName', header: '规格', cell: (r) => r.specName || '—' },
    { key: 'batchNo', header: '批号', cell: (r) => r.batchNo || '—' },
    { key: 'expiryDate', header: '效期', cell: (r) => formatDate(r.expiryDate) },
    { key: 'isGift', header: '赠送', cell: (r) => (r.isGift ? '是' : '否') },
    {
      key: 'quantityOnHand',
      header: '库存',
      cell: (r) => <span className="font-semibold text-[var(--primary)]">{r.quantityOnHand}</span>,
    },
    ...(canViewPrice
      ? [
          {
            key: 'marketActualUnitPrice',
            header: '市场实际价',
            cell: (r: InventoryLotRow) => r.marketActualUnitPrice ?? '—',
          } as Column<InventoryLotRow>,
          {
            key: 'storeActualUnitPrice',
            header: '门店实际价',
            cell: (r: InventoryLotRow) => r.storeActualUnitPrice ?? '—',
          } as Column<InventoryLotRow>,
        ]
      : []),
    { key: 'updatedAt', header: '更新时间', cell: (r) => formatDate(r.updatedAt) },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">实时库存</h1>
        </div>
        <div className="flex items-center gap-2">
          <InventoryLocationFilter
            options={locationFilterOptions}
            value={selectedLocationId}
            onChange={(location) => setMany({ location, type: '', page: '' })}
          />
          <Input
            className="w-72"
            placeholder="搜索主体 / SKU / 产品 / 批号"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          <Button
            variant={get('onlyPositive') === '1' ? 'default' : 'outline'}
            onClick={() => setMany({ onlyPositive: get('onlyPositive') === '1' ? '' : '1', page: '' })}
          >
            仅看有库存
          </Button>
          <Button
            variant="outline"
            onClick={() => setMany({
              q: '',
              location: locationFilterOptions.defaultLocationId ?? '',
              type: '',
              onlyPositive: '',
              page: '',
            })}
          >
            重置
          </Button>
          {canExport && <ExportButton onExport={handleExport} />}
        </div>
      </div>

      <DataTable columns={columns} data={rows} emptyText="暂无库存记录" />
      <Pagination
        total={total}
        page={page}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(next) => setMany({ page: String(next) })}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />
    </div>
  )
}
