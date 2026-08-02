'use client'

import { useCallback, useState } from 'react'
import { Boxes } from 'lucide-react'
import { exportInventoryStocks, type StoreInventoryStockRow } from '@/actions/inventory-v2'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { ExportButton } from '@/components/ui/export-button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import MarketStoreFilter from '@/components/market-store-filter'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import { exportToXlsx } from '@/lib/export-xlsx'
import type { MarketStoreFilterOptions } from '@/lib/market-store-filter-types'

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

function formatDate(v: string | null | undefined) {
  return v ? v.slice(0, 10) : '—'
}

export default function InventoryStocksPage({
  rows,
  total,
  filterOptions,
  canViewPrice,
  canExport,
}: {
  rows: StoreInventoryStockRow[]
  total: number
  filterOptions: MarketStoreFilterOptions
  canViewPrice: boolean
  canExport: boolean
}) {
  const { get, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)

  const page = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20
  const marketFilter = get('market')
  const storeFilter = get('store')

  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
  }, [debounceRef, setMany])

  const handleExport = useCallback(async () => {
    const { rows: exportRows } = await exportInventoryStocks({
      keyword: get('q') || undefined,
      marketId: get('market') || undefined,
      storeId: get('store') || undefined,
    })
    await exportToXlsx({
      filename: '门店库存',
      sheetName: '门店库存',
      rows: exportRows,
      columns: [
        { header: '门店', width: 20, accessor: (r) => r.storeName ?? r.storeId },
        { header: 'SKU', width: 24, accessor: (r) => r.skuId },
        { header: '产品', width: 36, accessor: (r) => r.skuName },
        { header: '产品类型', width: 12, accessor: (r) => r.productType },
        { header: '批号', width: 16, accessor: (r) => r.batchNo },
        { header: '效期', width: 14, accessor: (r) => r.expiryDate ?? '' },
        { header: '库存数量', width: 12, accessor: (r) => r.quantityOnHand },
        ...(canViewPrice
          ? [
              { header: '最近单价', width: 12, accessor: (r: StoreInventoryStockRow) => r.lastUnitPrice ?? '' },
              { header: '最近金额', width: 12, accessor: (r: StoreInventoryStockRow) => r.lastAmount ?? '' },
            ]
          : []),
        { header: '备注', width: 24, accessor: (r) => r.remark ?? '' },
      ],
    })
  }, [canViewPrice, get])

  const handleReset = useCallback(() => {
    setSearchInput('')
    setMany({ market: '', store: '', q: '', page: '' })
  }, [setMany])

  const columns: Column<StoreInventoryStockRow>[] = [
    { key: 'storeName', header: '门店', cell: (r) => r.storeName ?? r.storeId },
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
      key: 'productType',
      header: '类型',
      cell: (r) => (
        <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-xs text-[var(--primary)]">
          {r.productType}
        </span>
      ),
    },
    { key: 'batchNo', header: '批号', cell: (r) => r.batchNo || '—' },
    { key: 'expiryDate', header: '效期', cell: (r) => formatDate(r.expiryDate) },
    {
      key: 'quantityOnHand',
      header: '库存',
      cell: (r) => <span className="font-semibold text-[var(--primary)]">{r.quantityOnHand}</span>,
    },
    ...(canViewPrice
      ? [
          {
            key: 'lastUnitPrice',
            header: '最近单价',
            cell: (r: StoreInventoryStockRow) => r.lastUnitPrice ?? '—',
          } as Column<StoreInventoryStockRow>,
          {
            key: 'lastAmount',
            header: '最近金额',
            cell: (r: StoreInventoryStockRow) => r.lastAmount ?? '—',
          } as Column<StoreInventoryStockRow>,
        ]
      : []),
    { key: 'updatedAt', header: '更新时间', cell: (r) => formatDate(r.updatedAt) },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">门店库存表</h1>
        </div>
      </div>

      <div className="bg-white border border-[var(--border)] rounded-md p-3 flex flex-wrap gap-3 items-end">
        <MarketStoreFilter
          options={filterOptions}
          marketValue={marketFilter}
          storeValue={storeFilter}
          onMarketChange={(value) => setMany({ market: value, store: '', page: '' })}
          onStoreChange={(value) => setMany({ store: value, page: '' })}
          withLabels
        />

        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="text-xs text-[#666666]">搜索</span>
          <Input
            placeholder="搜索 SKU / 产品 / 批号"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          {canExport && <ExportButton onExport={handleExport} disabled={total === 0} />}
          <Button variant="outline" onClick={handleReset}>
            重置
          </Button>
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
