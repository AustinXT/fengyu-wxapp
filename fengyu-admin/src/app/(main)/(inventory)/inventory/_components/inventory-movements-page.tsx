'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeftRight } from 'lucide-react'
import type {
  InventoryLocationFilterOptions,
  InventoryMovementPage,
  InventoryMovementRow,
} from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { DatePicker } from '@/components/ui/date-picker'
import { ExportButton } from '@/components/ui/export-button'
import InventoryLocationFilter from '@/components/inventory-location-filter'
import { Input } from '@/components/ui/input'
import { Select, SelectOption } from '@/components/ui/select'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

const PAGE_SIZE_OPTIONS = [20, 50, 100]
// 短列（方向 / 数量 / 结存）被产品列挤压时会逐字折行，统一不换行
const NOWRAP = 'whitespace-nowrap'

type SearchMode = 'sku' | 'batch'

const DIRECTION_TONE: Record<string, string> = {
  入库: 'text-[#3D8A5A]',
  出库: 'text-[#D94040]',
  调整: 'text-[#5E8BB3]',
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

export default function InventoryMovementsPage({
  page,
  hasQuery,
  errorMessage,
  canExport,
  canOpenDoc,
  locationFilterOptions,
  selectedLocationId,
}: {
  page: InventoryMovementPage
  hasQuery: boolean
  errorMessage: string | null
  canExport: boolean
  canOpenDoc: boolean
  locationFilterOptions: InventoryLocationFilterOptions
  selectedLocationId: string | null
}) {
  const { get, setMany } = useUrlFilters()
  const initialMode: SearchMode = get('batch') && !get('sku') ? 'batch' : 'sku'
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [code, setCode] = useState(initialMode === 'batch' ? get('batch') : get('sku'))
  const bySku = Boolean(get('sku'))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size'))) ? Number(get('size')) : 20
  const resetCursor = { after: '', before: '' }

  const submit = () => {
    const value = code.trim()
    setMany({
      sku: mode === 'sku' ? value : '',
      batch: mode === 'batch' ? value : '',
      ...resetCursor,
    })
  }

  const columns: Column<InventoryMovementRow>[] = [
    { key: 'createdAt', header: '时间', className: NOWRAP, cell: (r) => r.createdAt },
    { key: 'docType', header: '单据类型', className: NOWRAP, cell: (r) => r.docType ?? '—' },
    {
      key: 'docId',
      header: '单号',
      className: NOWRAP,
      cell: (r) => {
        if (!r.docId) return ''
        return canOpenDoc
          ? <Link className="font-mono text-xs text-[var(--primary)] hover:underline" href={`/inventory/docs/${r.docId}`}>{r.docId}</Link>
          : <span className="font-mono text-xs">{r.docId}</span>
      },
    },
    {
      key: 'skuName',
      header: '产品',
      className: 'min-w-48',
      cell: (r) => (
        <div>
          <div className="font-medium">{r.skuName ?? r.skuId}</div>
          <div className="font-mono text-xs text-[#888888]">{r.skuId}{r.specName ? ` · ${r.specName}` : ''}</div>
        </div>
      ),
    },
    ...(bySku
      ? [{ key: 'batchNo', header: '批号', className: NOWRAP, cell: (r: InventoryMovementRow) => r.batchNo || '—' } as Column<InventoryMovementRow>]
      : []),
    {
      // 结存是批次结存：同一批号可能拆成多个批次（价格 / 效期 / 赠送不同），靠批次 ID 区分各自的结存序列
      key: 'lotId',
      header: '批次 ID',
      className: NOWRAP,
      cell: (r) => <span className="font-mono text-xs text-[#888888]">{r.lotId}</span>,
    },
    {
      key: 'direction',
      header: '方向',
      className: NOWRAP,
      cell: (r) => <span className={`font-medium ${DIRECTION_TONE[r.direction] ?? ''}`}>{r.direction}</span>,
    },
    {
      key: 'quantityDelta',
      header: '数量',
      className: NOWRAP,
      cell: (r) => <span className="font-semibold">{signed(r.quantityDelta)}</span>,
    },
    { key: 'quantityBefore', header: '变动前结存', className: NOWRAP, cell: (r) => r.quantityBefore },
    { key: 'quantityAfter', header: '变动后结存', className: NOWRAP, cell: (r) => <span className="font-semibold">{r.quantityAfter}</span> },
    { key: 'counterpartyName', header: '对方主体', className: 'min-w-28', cell: (r) => r.counterpartyName ?? '—' },
    { key: 'operatorName', header: '经办人', className: NOWRAP, cell: (r) => r.operatorName ?? r.operatorId ?? '—' },
  ]

  const firstRow = page.rows[0]
  const lastRow = page.rows[page.rows.length - 1]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ArrowLeftRight className="size-5 text-[var(--primary)]" />
          <h1 className="text-xl font-medium">进出明细</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <InventoryLocationFilter
            options={locationFilterOptions}
            value={selectedLocationId}
            onChange={(location) => setMany({ location, ...resetCursor })}
          />
          <Select
            className="w-28"
            aria-label="查询方式"
            value={mode}
            onChange={(e) => setMode(e.target.value as SearchMode)}
          >
            <SelectOption value="sku">商品编号</SelectOption>
            <SelectOption value="batch">批号</SelectOption>
          </Select>
          <Input
            className="w-56"
            placeholder={mode === 'sku' ? '输入完整商品编号' : '输入完整批号'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <DatePicker
            className="w-36"
            aria-label="开始日期"
            placeholder="开始日期"
            value={get('start')}
            onValueChange={(value) => setMany({ start: value, ...resetCursor })}
          />
          <DatePicker
            className="w-36"
            aria-label="结束日期"
            placeholder="结束日期"
            value={get('end')}
            onValueChange={(value) => setMany({ end: value, ...resetCursor })}
          />
          <Button onClick={submit}>查询</Button>
          <Button
            variant="outline"
            onClick={() => {
              setMode('sku')
              setCode('')
              setMany({
                location: locationFilterOptions.defaultLocationId ?? '',
                sku: '',
                batch: '',
                start: '',
                end: '',
                size: '',
                ...resetCursor,
              })
            }}
          >
            重置
          </Button>
          {canExport && (
            <ExportButton
              disabled={!selectedLocationId || !hasQuery || Boolean(errorMessage) || page.total === 0}
              exportRequest={{
                exportType: 'inventory-movements',
                payload: {
                  location: selectedLocationId ?? '',
                  sku: get('sku'),
                  batch: get('batch'),
                  start: get('start'),
                  end: get('end'),
                },
              }}
            />
          )}
        </div>
      </div>

      {errorMessage && <p className="text-sm text-[#D94040]">{errorMessage}</p>}

      <DataTable
        columns={columns}
        data={page.rows}
        emptyText={hasQuery ? '该条件下暂无进出流水' : '请选择库存主体，并输入商品编号或批号后查询'}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[#888888]">
        <span>共 {page.total} 条</span>
        <div className="flex items-center gap-2">
          <Select
            className="w-28"
            aria-label="每页条数"
            value={String(pageSize)}
            onChange={(e) => setMany({ size: e.target.value, ...resetCursor })}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectOption key={size} value={String(size)}>{size} 条/页</SelectOption>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={!page.hasPrev || !firstRow}
            onClick={() => firstRow && setMany({ before: String(firstRow.id), after: '' })}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!page.hasNext || !lastRow}
            onClick={() => lastRow && setMany({ after: String(lastRow.id), before: '' })}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
