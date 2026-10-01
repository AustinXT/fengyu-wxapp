'use client'

import { useEffect, useState } from 'react'
import { Landmark, Store as StoreIcon } from 'lucide-react'
import type { InventorySettlementReport, InventorySettlementRow } from '@/lib/inventory/types'
import type { SettlementDetailRow, SettlementDetailSegment } from '@/lib/inventory/settlement-detail-types'
import { listSettlementDetails } from '@/actions/inventory/settlements'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { DatePicker } from '@/components/ui/date-picker'
import { ExportButton } from '@/components/ui/export-button'
import { Select, SelectOption } from '@/components/ui/select'
import { actionErrorMessage } from '@/lib/action-error'
import { formatSignedCurrency } from '@/lib/utils'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'

function sumPayable(rows: InventorySettlementRow[]): number {
  return rows.reduce((total, row) => total + row.payableAmount, 0)
}

const rowKeyOf = (row: InventorySettlementRow) => `${row.sourceOrgNodeId ?? ''}|${row.targetOrgNodeId ?? ''}`

const fmtUnitPrice = (value: number | null) => (value === null ? '—' : value.toFixed(2))

/** 下钻明细列：与汇总行同源（同一投影），退货行以「退货」标记 + 负数量/负金额呈现。 */
function detailColumnsFor(segment: SettlementDetailSegment): Column<SettlementDetailRow>[] {
  const priceColumns: Column<SettlementDetailRow>[] = segment === 'market'
    ? [
        { key: 'marketStandardUnitPrice', header: '市场单价', cell: (row) => fmtUnitPrice(row.marketStandardUnitPrice) },
        { key: 'marketUnitDiscount', header: '单价优惠', cell: (row) => fmtUnitPrice(row.marketUnitDiscount) },
        { key: 'marketActualUnitPrice', header: '实际单价', cell: (row) => fmtUnitPrice(row.marketActualUnitPrice) },
      ]
    : [
        { key: 'storeStandardUnitPrice', header: '门店进货价', cell: (row) => fmtUnitPrice(row.storeStandardUnitPrice) },
        { key: 'storeUnitDiscount', header: '优惠', cell: (row) => fmtUnitPrice(row.storeUnitDiscount) },
        { key: 'storeActualUnitPrice', header: '实际单价', cell: (row) => fmtUnitPrice(row.storeActualUnitPrice) },
      ]
  return [
    { key: 'effectiveDate', header: segment === 'market' ? '报货日期' : '配货日期', cell: (row) => row.effectiveDate },
    {
      key: 'docId',
      header: '单号',
      cell: (row) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{row.docId}</span>
          {row.isReturn && <Badge variant="outline" className="text-[10px]">退货</Badge>}
        </span>
      ),
    },
    { key: 'skuName', header: '商品', cell: (row) => row.skuName },
    { key: 'specName', header: '规格', cell: (row) => row.specName ?? '—' },
    ...(segment === 'store'
      ? [{ key: 'batchNo', header: '批号', cell: (row: SettlementDetailRow) => row.batchNo || '—' }]
      : []),
    { key: 'quantity', header: '数量', cell: (row) => (row.isReturn ? `-${row.quantity}` : row.quantity) },
    ...priceColumns,
    {
      key: 'signedAmount',
      header: segment === 'market' ? '金额' : '应付',
      // 冲减行金额本身已是负数（投影带符号），这里只做颜色区分
      cell: (row) => <span className={row.isReturn ? 'text-[#3D8A5A]' : undefined}>{formatSignedCurrency(row.signedAmount)}</span>,
    },
    ...(segment === 'store'
      ? [{ key: 'isGift', header: '赠送', cell: (row: SettlementDetailRow) => (row.isGift ? '是' : '—') }]
      : []),
  ]
}

function SettlementSection({
  title,
  description,
  icon,
  sourceHeader,
  targetHeader,
  segment,
  rows,
  startDate,
  endDate,
  market,
  canExport,
}: {
  title: string
  description: string
  icon: React.ReactNode
  sourceHeader: string
  targetHeader: string
  segment: SettlementDetailSegment
  rows: InventorySettlementRow[]
  startDate: string
  endDate: string
  market: string
  canExport: boolean
}) {
  const [detail, setDetail] = useState<{ key: string; label: string; rows: SettlementDetailRow[]; truncated: boolean } | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
   * 筛选变化后丢弃展开的明细：detail 的状态键只有行端点，不含期间/市场 ——
   * 不重置的话，改了筛选仍显示上一期间/上一市场的旧明细，且标题里也看不出这一点。
   */
  useEffect(() => {
    setDetail(null)
    setError(null)
  }, [startDate, endDate, market])

  async function toggleDetail(row: InventorySettlementRow) {
    const key = rowKeyOf(row)
    if (detail?.key === key) {
      setDetail(null)
      return
    }
    setLoadingKey(key)
    setError(null)
    try {
      const result = await listSettlementDetails({
        segment,
        startDate,
        endDate,
        market: market || undefined,
        marketNode: row.sourceOrgNodeId ?? '',
        partyNode: row.targetOrgNodeId ?? '',
      })
      setDetail({
        key,
        label: `${row.sourceOrgNodeName ?? row.sourceOrgNodeId ?? '—'} → ${row.targetOrgNodeName ?? row.targetOrgNodeId ?? '—'}`,
        rows: result.rows,
        truncated: result.truncated,
      })
    } catch (err) {
      setError(actionErrorMessage(err, '加载明细失败'))
    } finally {
      setLoadingKey(null)
    }
  }

  const columns: Column<InventorySettlementRow>[] = [
    {
      key: 'sourceOrgNodeName',
      header: sourceHeader,
      cell: (row) => <span className="font-medium">{row.sourceOrgNodeName ?? row.sourceOrgNodeId ?? '—'}</span>,
    },
    { key: 'targetOrgNodeName', header: targetHeader, cell: (row) => row.targetOrgNodeName ?? row.targetOrgNodeId ?? '—' },
    { key: 'docCount', header: '单据数', cell: (row) => row.docCount },
    { key: 'totalQuantity', header: '数量合计', cell: (row) => row.totalQuantity },
    {
      key: 'returnDocCount',
      // 退货数量与金额不并入正向列：净额只出现在「应付货款」，避免"0 件"这类无法解释的合计
      header: '退货冲减',
      cell: (row) => (row.returnDocCount > 0 ? `${row.returnDocCount} 单 / ${row.returnedQuantity} 件` : '—'),
    },
    {
      key: 'payableAmount',
      header: '应付货款',
      cell: (row) => (
        <span className={`font-semibold ${row.payableAmount < 0 ? 'text-[#3D8A5A]' : 'text-[var(--primary)]'}`}>
          {formatSignedCurrency(row.payableAmount)}
        </span>
      ),
    },
    {
      key: 'detail',
      header: '明细',
      cell: (row) => {
        // 缺端点的行下钻不了：服务端对空端点抛 INVALID_PARAMS，点了只会看到「加载明细失败」
        const drillable = row.sourceOrgNodeId !== null && row.targetOrgNodeId !== null
        return (
          <Button
            variant="outline"
            disabled={!drillable}
            onClick={() => toggleDetail(row)}
            loading={loadingKey === rowKeyOf(row)}
          >
            {detail?.key === rowKeyOf(row) ? '收起' : '查看'}
          </Button>
        )
      },
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
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm text-[#666666]">
              期间应付合计
              <span className="ml-2 text-base font-semibold text-[var(--primary)]">{formatSignedCurrency(sumPayable(rows))}</span>
            </div>
            {canExport && (
              <ExportButton
                disabled={rows.length === 0}
                exportRequest={{
                  exportType: segment === 'market' ? 'settlement-market-details' : 'settlement-store-details',
                  // segment 由 exportType 区分，不再重复放进 payload（两处写同一个值会漂）
                  payload: { start: startDate, end: endDate, ...(market ? { market } : {}) },
                }}
              />
            )}
          </div>
        </div>

        {error && <p className="rounded-md bg-[#FFF8F7] px-3 py-2 text-xs text-[#D94040]">{error}</p>}

        <DataTable columns={columns} data={rows} emptyText="期间内暂无结算单据" />

        {detail && (
          <div className="rounded-md border border-[var(--border)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium">明细 · {detail.label}</h3>
              <Button variant="ghost" onClick={() => setDetail(null)}>收起</Button>
            </div>
            {detail.truncated && (
              <p className="mb-2 text-xs text-[#D4820A]">明细超过 500 行，仅显示前 500 行；完整明细请用导出。</p>
            )}
            <DataTable columns={detailColumnsFor(segment)} data={detail.rows} emptyText="该行期间内没有明细" />
            {detail.rows.length > 0 && (
              // issue 验收「明细合计必须等于汇总行」：不留合计行的话，用户只能靠导出对账
              <div className="mt-2 flex justify-end gap-4 text-xs text-[#666666]">
                <span>{detail.truncated ? '可见行合计（已截断）' : '合计'}</span>
                {/* 退货行在表格里显示为负数量，合计必须同号 —— 否则「6 正 + 4 退」会被加成 10 */}
                <span className="text-right">
                  数量 {detail.rows.reduce((sum, row) => sum + (row.isReturn ? -row.quantity : row.quantity), 0)}
                </span>
                <span className="text-right">
                  {formatSignedCurrency(detail.rows.reduce((sum, row) => sum + row.signedAmount, 0))}
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function InventorySettlementsPage({
  report,
  canExport,
}: {
  report: InventorySettlementReport
  canExport: boolean
}) {
  const { get, setMany } = useUrlFilters()
  const startDate = get('start') || report.startDate
  const endDate = get('end') || report.endDate
  const market = get('market') ?? ''

  /*
   * 市场下拉选项**由服务端下发**（`report.marketOptions`，不受期间与当前筛选影响）。
   * 早前版本从 `marketRows` 派生，结果是"筛一次就只剩当前市场、回不去"；
   * 也不能改调 `listInventoryLocations` —— 它的闸是 `inventory:stock_list`，
   * 而店长（#364 之后）只持 `inventory:store_settlement_view`，会直接 403。
   */
  const marketOptions = report.marketOptions

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Landmark className="size-5 text-[var(--primary)]" />
          <div>
            <h1 className="text-xl font-medium">货款结算</h1>
            <p className="mt-1 text-sm text-[#666666]">
              按期间汇总应付货款的只读报表，金额已冲减期间内已完成的退货；结算与支付流程线下执行，本页不做支付状态流转。
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
          <Select aria-label="市场" value={market} onChange={(event) => setMany({ market: event.target.value })}>
            <SelectOption value="">全部市场</SelectOption>
            {marketOptions.map((item) => (
              <SelectOption key={item.id} value={item.id}>{item.name}</SelectOption>
            ))}
          </Select>
          <Button variant="outline" onClick={() => setMany({ start: '', end: '', market: '' })}>
            重置为本月
          </Button>
        </div>
      </div>

      {report.canViewMarketSettlement && (
        <SettlementSection
          title="市场货款结算（市场应付供应链）"
          description={`统计期间 ${report.startDate} ~ ${report.endDate} 内已完成的市场报货单，并冲减同期已完成的市场退货`}
          icon={<Landmark className="size-5" />}
          sourceHeader="市场"
          targetHeader="供应链主体"
          segment="market"
          rows={report.marketRows}
          startDate={report.startDate}
          endDate={report.endDate}
          market={market}
          canExport={canExport}
        />
      )}

      {report.canViewStoreSettlement && (
        <SettlementSection
          title="分院货款结算（门店应付市场）"
          description={`统计期间 ${report.startDate} ~ ${report.endDate} 内分院配货单（待收货/已完成），并冲减同期已完成的院退货`}
          icon={<StoreIcon className="size-5" />}
          sourceHeader="配货市场"
          targetHeader="门店"
          segment="store"
          rows={report.storeRows}
          startDate={report.startDate}
          endDate={report.endDate}
          market={market}
          canExport={canExport}
        />
      )}
    </div>
  )
}
