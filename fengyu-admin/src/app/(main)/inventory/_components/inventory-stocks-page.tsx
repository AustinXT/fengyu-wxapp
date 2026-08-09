'use client'

import { useCallback, useState } from 'react'
import { Boxes } from 'lucide-react'
import { type StoreInventoryStockRow } from '@/actions/inventory-v2'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { ExportButton } from '@/components/ui/export-button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import MarketStoreFilter from '@/components/market-store-filter'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
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
          {canExport && (
            <ExportButton
              disabled={total === 0}
              exportRequest={{
                exportType: 'inventory-stocks',
                payload: {
                  keyword: get('q') || '',
                  marketId: get('market') || '',
                  storeId: get('store') || '',
                },
              }}
            />
          )}
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
