'use client'

import { Landmark, Store as StoreIcon } from 'lucide-react'
import type { InventorySettlementReport, InventorySettlementRow } from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { DatePicker } from '@/components/ui/date-picker'
import { formatCurrency } from '@/lib/utils'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

function sumPayable(rows: InventorySettlementRow[]): number {
  return rows.reduce((total, row) => total + row.payableAmount, 0)
}

function SettlementSection({
  title,
  description,
  icon,
  sourceHeader,
  targetHeader,
  rows,
}: {
  title: string
  description: string
  icon: React.ReactNode
  sourceHeader: string
  targetHeader: string
  rows: InventorySettlementRow[]
}) {
  const columns: Column<InventorySettlementRow>[] = [
    {
      key: 'sourceOrgNodeName',
      header: sourceHeader,
      cell: (row) => <span className="font-medium">{row.sourceOrgNodeName ?? row.sourceOrgNodeId ?? '—'}</span>,
    },
    {
      key: 'targetOrgNodeName',
      header: targetHeader,
      cell: (row) => row.targetOrgNodeName ?? row.targetOrgNodeId ?? '—',
    },
    { key: 'docCount', header: '单据数', cell: (row) => row.docCount },
    { key: 'totalQuantity', header: '数量合计', cell: (row) => row.totalQuantity },
    {
      key: 'payableAmount',
      header: '应付货款',
      cell: (row) => <span className="font-semibold text-[var(--primary)]">{formatCurrency(row.payableAmount)}</span>,
    },
  ]
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-[#FFF0EE] text-[var(--primary)]">
              {icon}
            </span>
            <div>
              <h2 className="text-base font-medium">{title}</h2>
              <p className="mt-0.5 text-xs text-[#888888]">{description}</p>
            </div>
          </div>
          <div className="text-sm text-[#666666]">
            期间应付合计
            <span className="ml-2 text-base font-semibold text-[var(--primary)]">{formatCurrency(sumPayable(rows))}</span>
          </div>
        </div>
        <DataTable columns={columns} data={rows} emptyText="期间内暂无结算单据" />
      </CardContent>
    </Card>
  )
}

export default function InventorySettlementsPage({ report }: { report: InventorySettlementReport }) {
  const { get, setMany } = useUrlFilters()
  const startDate = get('start') || report.startDate
  const endDate = get('end') || report.endDate

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Landmark className="size-5 text-[var(--primary)]" />
          <div>
            <h1 className="text-xl font-medium">货款结算</h1>
            <p className="mt-1 text-sm text-[#666666]">
              按期间汇总应付货款的只读报表；结算与支付流程线下执行，本页不做支付状态流转。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            aria-label="结算开始日期"
            value={startDate}
            onValueChange={(value) => setMany({ start: value })}
          />
          <span className="text-sm text-[#888888]">至</span>
          <DatePicker
            aria-label="结算结束日期"
            value={endDate}
            onValueChange={(value) => setMany({ end: value })}
          />
          <Button variant="outline" onClick={() => setMany({ start: '', end: '' })}>
            重置为本月
          </Button>
        </div>
      </div>

      {report.canViewMarketSettlement && (
        <SettlementSection
          title="市场货款结算（市场应付供应链）"
          description={`统计期间 ${report.startDate} ~ ${report.endDate} 内已完成的市场报货单应付货款`}
          icon={<Landmark className="size-5" />}
          sourceHeader="市场"
          targetHeader="供应链主体"
          rows={report.marketRows}
        />
      )}

      {report.canViewStoreSettlement && (
        <SettlementSection
          title="分院货款结算（门店应付市场）"
          description={`统计期间 ${report.startDate} ~ ${report.endDate} 内分院配货单（待收货/已完成）应付货款`}
          icon={<StoreIcon className="size-5" />}
          sourceHeader="配货市场"
          targetHeader="门店"
          rows={report.storeRows}
        />
      )}
    </div>
  )
}
