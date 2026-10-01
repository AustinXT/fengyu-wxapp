'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { DatePicker } from '@/components/ui/date-picker'
import { ExportButton } from '@/components/ui/export-button'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectOption } from '@/components/ui/select'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type { PendingReceiptKind, PendingReceiptOptions, PendingReceiptPage, PendingReceiptRow } from '@/lib/inventory/pending-receipt-types'

export default function PendingReceiptsPage({ result, kind, options, error, canExport }: {
  result: PendingReceiptPage; kind: PendingReceiptKind; options: PendingReceiptOptions; error: string | null; canExport: boolean
}) {
  const { get, setMany, replaceAll } = useUrlFilters()
  const update = (values: Record<string, string>) => setMany({ ...values, page: '' })
  const columns: Column<PendingReceiptRow>[] = [
    { key: 'recipientName', header: kind === 'store' ? '门店' : '市场', cell: row => row.recipientName },
    { key: 'docDate', header: kind === 'store' ? '配货日期' : '发货日期', className: 'whitespace-nowrap', cell: row => row.docDate },
    { key: 'docId', header: '单号', cell: row => <Link className="text-[var(--primary)] hover:underline" href={`/inventory/docs/${encodeURIComponent(row.docId)}`}>{row.docId}</Link> },
    { key: 'skuName', header: '商品', cell: row => <div>{row.skuName}<div className="text-xs text-[var(--muted-foreground)]">{row.skuId}</div></div> },
    { key: 'batchNo', header: '批号', cell: row => row.batchNo || '—' },
    { key: 'sentQuantity', header: '已发', cell: row => row.sentQuantity },
    { key: 'receivedQuantity', header: '已收', cell: row => row.receivedQuantity },
    { key: 'pendingQuantity', header: '未收', cell: row => row.pendingQuantity },
    { key: 'transitDays', header: '在途天数', cell: row => row.transitDays },
  ]
  const market = get('market')
  const stores = options.stores.filter(store => !market || store.marketId === market)
  return <div className="space-y-4">
    <h1 className="text-xl font-medium">收货跟进</h1>
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="收货视图" value={kind} onChange={event => update({ kind: event.target.value, market: '', store: '' })}>
        <SelectOption value="store">分院未入库明细</SelectOption><SelectOption value="market">市场入库情况</SelectOption>
      </Select>
      <Select aria-label="市场" value={market} onChange={event => update({ market: event.target.value, store: '' })}>
        <SelectOption value="">全部市场</SelectOption>{options.markets.map(item => <SelectOption key={item.id} value={item.id}>{item.name}</SelectOption>)}
      </Select>
      {kind === 'store' && <Select aria-label="门店" value={get('store')} onChange={event => update({ store: event.target.value })}>
        <SelectOption value="">全部门店</SelectOption>{stores.map(item => <SelectOption key={item.id} value={item.id}>{item.name}</SelectOption>)}
      </Select>}
      <DatePicker aria-label="开始日期" placeholder="开始日期" value={get('start')} max={get('end') || undefined} onValueChange={value => update({ start: value })} />
      <DatePicker aria-label="结束日期" placeholder="结束日期" value={get('end')} min={get('start') || undefined} onValueChange={value => update({ end: value })} />
      <Button variant="outline" onClick={() => replaceAll({ kind })}>重置</Button>
      {canExport && <ExportButton disabled={Boolean(error) || result.total === 0} exportRequest={{ exportType: 'inventory-pending-receipts', payload: { kind, market, store: kind === 'store' ? get('store') : '', start: get('start'), end: get('end') } }} />}
    </div>
    <p className="text-sm text-[var(--muted-foreground)]">仅显示待收货单据的未收明细。已发、已收取发货明细数量；在途天数按上海日期计算。</p>
    {error && <p role="alert" className="text-sm text-[#D94040]">{error}</p>}
    <DataTable columns={columns} data={result.rows} emptyText="该条件下暂无未收明细" />
    <Pagination total={result.total} page={result.page} pageSize={result.pageSize} onPageChange={page => setMany({ page: String(page) })} pageSizeOptions={[20, 50, 100]} onPageSizeChange={size => update({ size: String(size) })} />
  </div>
}
