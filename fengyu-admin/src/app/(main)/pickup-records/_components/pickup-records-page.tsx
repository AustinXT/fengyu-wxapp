'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type { AdminPickupRecord } from '@/actions/pickup-records'
import type { Store } from '@/lib/types'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Pagination } from '@/components/ui/pagination'
import {
  Dialog,
  DialogClose,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatPhone, formatDateTime as fmtDateTime } from '@/lib/utils'

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function formatDateTime(dt: string) {
  return fmtDateTime(dt)
}

interface Props {
  records: AdminPickupRecord[]
  stores: Store[]
  total: number
  canCreate: boolean
}

/**
 * 提货记录管理页 — 服务端分页
 *
 * scope 过滤基于 pickup_records.store_id，非 admin 角色仅看到 scopeStoreIds 内的门店记录。
 * canCreate=true 时（manager 角色）显示"新建提货记录"入口。
 */
export default function PickupRecordsPage({ records, stores, total, canCreate }: Props) {
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback(
    (key: string, value: string) => {
      setMany({ [key]: value, page: '' })
    },
    [setMany],
  )

  const storeFilter = get('store')
  const dateFrom = get('from')
  const dateTo = get('to')
  const currentPage = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20

  // 搜索防抖
  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceRef[0]) clearTimeout(debounceRef[0])
      debounceRef[0] = setTimeout(() => setFilter('q', value), 300)
    },
    [setFilter, debounceRef],
  )

  const [detail, setDetail] = useState<AdminPickupRecord | null>(null)

  const columns: Column<AdminPickupRecord>[] = [
    {
      key: 'createdAt',
      header: '提货时间',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span className="text-[#999999] text-xs">{formatDateTime(row.createdAt)}</span>
      ),
    },
    {
      key: 'storeName',
      header: '门店',
      cell: (row) => <span>{row.storeName ?? '—'}</span>,
    },
    {
      key: 'skuName',
      header: '商品/规格',
      cell: (row) => (
        <span className="font-medium line-clamp-1">{row.skuName ?? '—'}</span>
      ),
    },
    {
      key: 'pickupQuantity',
      header: '本次提货',
      cell: (row) => (
        <span className="font-medium text-[#C0322A]">
          {row.pickupQuantity}
        </span>
      ),
    },
    {
      key: 'progress',
      header: '进度',
      cell: (row) =>
        row.itemQuantity != null ? (
          <span className="text-xs text-[#666666]">
            {row.itemPickedUpQuantity ?? 0} / {row.itemQuantity}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'clientName',
      header: '顾客',
      cell: (row) =>
        row.clientName || row.clientPhone ? (
          <div className="flex flex-col">
            <span>{row.clientName ?? '—'}</span>
            {row.clientPhone && (
              <span className="text-xs text-[#999999]">
                {formatPhone(row.clientPhone)}
              </span>
            )}
          </div>
        ) : (
          '—'
        ),
    },
    {
      key: 'confirmedByName',
      header: '确认员工',
      cell: (row) => <span>{row.confirmedByName ?? row.confirmedBy}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setDetail(row)}
        >
          详情
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">提货记录</h1>
        {canCreate && (
          <Link href="/pickup-records/create">
            <Button>新建提货记录</Button>
          </Link>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select
              className="w-40"
              value={storeFilter}
              onChange={(e) => setFilter('store', e.target.value)}
            >
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeName}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="w-40"
                value={dateFrom}
                onChange={(e) => setFilter('from', e.target.value)}
              />
              <span className="text-[#999999]">-</span>
              <Input
                type="date"
                className="w-40"
                value={dateTo}
                onChange={(e) => setFilter('to', e.target.value)}
              />
            </div>
            <Input
              className="max-w-xs"
              placeholder="搜索商品 / 顾客 / 员工 / 销售明细号"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <DataTable columns={columns} data={records} />

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set('page', p === 1 ? '' : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      {/* Detail Dialog */}
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogClose onOpenChange={(open) => !open && setDetail(null)} />
        <DialogHeader>
          <DialogTitle>提货详情</DialogTitle>
        </DialogHeader>
        {detail && (
          <div className="space-y-3 mt-4 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">提货时间</span>
              <span>{formatDateTime(detail.createdAt)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">门店</span>
              <span>{detail.storeName ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">商品/规格</span>
              <span>{detail.skuName ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">销售明细号</span>
              <span className="font-mono text-xs">{detail.saleItemId}</span>
            </div>
            {detail.saleOrderId && (
              <div className="flex justify-between gap-4">
                <span className="text-[#999999]">关联订单</span>
                <span className="font-mono text-xs">{detail.saleOrderId}</span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">本次提货数量</span>
              <span className="font-medium text-[#C0322A]">
                {detail.pickupQuantity}
              </span>
            </div>
            {detail.itemQuantity != null && (
              <div className="flex justify-between gap-4">
                <span className="text-[#999999]">累计进度</span>
                <span>
                  {detail.itemPickedUpQuantity ?? 0} / {detail.itemQuantity}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">顾客</span>
              <span>
                {detail.clientName ?? '—'}
                {detail.clientPhone && (
                  <span className="ml-1 text-xs text-[#999999]">
                    {formatPhone(detail.clientPhone)}
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">确认员工</span>
              <span>
                {detail.confirmedByName ?? '—'}
                <span className="ml-2 font-mono text-xs text-[#999999]">
                  {detail.confirmedBy}
                </span>
              </span>
            </div>
            {detail.remark && (
              <div>
                <div className="text-[#999999] mb-1">备注</div>
                <div className="whitespace-pre-wrap bg-[var(--muted)] rounded-md p-3">
                  {detail.remark}
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
