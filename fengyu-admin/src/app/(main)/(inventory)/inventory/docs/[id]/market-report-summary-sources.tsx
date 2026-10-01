import { Fragment } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import type { MarketReportSummarySourceRow } from '@/lib/inventory/market-report-summary-detail-types'

/**
 * #349 汇总单「来源明细」：构成汇总单的原始报货行，按 市场 → 来源报货单 → 商品 展示。
 *
 * 市场筛选在**内存**里做而非再发一次查询：来源行已按 scope 取全（一张汇总单的来源行数在数百量级），
 * 市场下拉需要"全部市场"这份全集来派生选项，再查一次反而多一次往返。筛选条件与导出侧
 * （`marketReportSummarySourceWhereSql` 的 `i.market_id = $market`）完全等价 —— 同一份行、同一个谓词。
 */

const round2 = (value: number) => Number(value.toFixed(2))
const fmtAmount = (value: number | null) => (value === null ? '—' : value.toFixed(2))
const fmtPrice = (value: number | null) => (value === null ? '—' : value.toFixed(2))

interface SourceDocGroup {
  docId: string
  docDate: string
  rows: MarketReportSummarySourceRow[]
}

interface MarketGroup {
  marketId: string
  marketName: string
  quantity: number
  amount: number | null
  docs: SourceDocGroup[]
}

function groupSources(rows: MarketReportSummarySourceRow[]): MarketGroup[] {
  const markets = new Map<string, {
    marketId: string
    marketName: string
    quantity: number
    amount: number | null
    docs: Map<string, SourceDocGroup>
  }>()
  for (const row of rows) {
    const marketKey = row.marketId ?? ''
    let market = markets.get(marketKey)
    if (!market) {
      market = {
        marketId: marketKey,
        marketName: row.marketName ?? (row.marketId ?? '未知市场'),
        quantity: 0,
        amount: 0,
        docs: new Map(),
      }
      markets.set(marketKey, market)
    }
    market.quantity += row.quantity
    // 价格档为 none 时 amount 恒 null：保持 null 而不是累加成 0，
    // 否则"没价格"与"合计为 0"在页面上无法区分。
    if (row.amount !== null) market.amount = round2((market.amount ?? 0) + row.amount)
    let doc = market.docs.get(row.sourceDocId)
    if (!doc) {
      doc = { docId: row.sourceDocId, docDate: row.sourceDocDate, rows: [] }
      market.docs.set(row.sourceDocId, doc)
    }
    doc.rows.push(row)
  }
  return [...markets.values()].map((market) => ({
    marketId: market.marketId,
    marketName: market.marketName,
    quantity: market.quantity,
    amount: market.amount,
    docs: [...market.docs.values()],
  }))
}

/** 保留返回入口的 from/level/op 参数，只改 market —— 否则点完筛选，返回按钮就失灵了。 */
function buildHref(query: Record<string, string | undefined>, market?: string): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (key === 'market' || value === undefined) continue
    params.set(key, value)
  }
  if (market) params.set('market', market)
  const search = params.toString()
  return search ? `?${search}` : '?'
}

export function MarketReportSummarySources({
  rows,
  query,
  marketFilter,
  canViewPrice,
  truncated,
}: {
  rows: MarketReportSummarySourceRow[]
  /** 当前 URL 的 searchParams，用于构造保留返回上下文的筛选链接。 */
  query: Record<string, string | undefined>
  marketFilter?: string
  canViewPrice: boolean
  truncated: boolean
}) {
  const visibleRows = marketFilter ? rows.filter((row) => row.marketId === marketFilter) : rows
  const groups = groupSources(visibleRows)
  const totalQuantity = visibleRows.reduce((sum, row) => sum + row.quantity, 0)
  const totalAmount = visibleRows.reduce<number | null>(
    (sum, row) => (row.amount === null ? sum : round2((sum ?? 0) + row.amount)),
    canViewPrice ? 0 : null,
  )
  // 选项取自**全量**行：筛选后仍能看到其它市场，否则筛一次就回不去。
  const marketOptions = [...new Map(rows.map((row) => [
    row.marketId ?? '',
    { id: row.marketId ?? '', name: row.marketName ?? '未知市场' },
  ])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  return (
    <Card>
      <CardContent className="p-5">
        <h2 className="mb-4 text-base font-medium">来源明细</h2>
        <p className="mb-3 text-xs text-[#888888]">
          本汇总单由下列报货明细构成，按市场 → 来源报货单 → 商品展开；数量为本次汇总分摊量，价格取来源行快照，不随 SKU 现价变动。
        </p>

        {marketOptions.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-2">
            <Link
              href={buildHref(query)}
              className={`rounded-md border px-2 py-1 text-xs ${
                marketFilter ? 'border-[var(--border)] text-[#666666] hover:bg-[#F8F8F8]' : 'border-[var(--primary)] text-[var(--primary)]'
              }`}
            >
              全部市场
            </Link>
            {marketOptions.map((option) => (
              <Link
                key={option.id || 'unknown'}
                href={buildHref(query, option.id || undefined)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  marketFilter === option.id ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-[var(--border)] text-[#666666] hover:bg-[#F8F8F8]'
                }`}
              >
                {option.name}
              </Link>
            ))}
          </div>
        )}

        {truncated && (
          <p className="mb-3 rounded-md bg-[#FFF8F7] px-3 py-2 text-xs text-[#D4820A]">
            来源行数超过展示上限，仅显示前 2000 行；完整明细请用导出查看。
          </p>
        )}

        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-[#F8F8F8] text-xs text-[#666666]">
              <tr>
                <th className="px-3 py-2 text-left">市场</th>
                <th className="px-3 py-2 text-left">报货单号</th>
                <th className="px-3 py-2 text-left">报货日期</th>
                <th className="px-3 py-2 text-left">商品</th>
                <th className="px-3 py-2 text-left">规格</th>
                <th className="px-3 py-2 text-right">数量</th>
                {canViewPrice && <>
                  <th className="px-3 py-2 text-right">市场单价</th>
                  <th className="px-3 py-2 text-right">单价优惠</th>
                  <th className="px-3 py-2 text-right">实际单价</th>
                  <th className="px-3 py-2 text-right">金额</th>
                </>}
                <th className="px-3 py-2 text-left">福利方案</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((market) => (
                <Fragment key={market.marketId || 'unknown'}>
                  <tr className="border-t border-[var(--border)] bg-[#F8F8F8]">
                    <td className="px-3 py-2 font-medium" colSpan={5}>
                      {market.marketName} · 小计
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{market.quantity}</td>
                    {canViewPrice && <>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right font-medium">{fmtAmount(market.amount)}</td>
                    </>}
                    <td className="px-3 py-2" />
                  </tr>
                  {market.docs.map((doc) => doc.rows.map((row) => (
                    <tr key={row.id} className="border-t border-[var(--border)]">
                      <td className="px-3 py-2">{market.marketName}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link
                          href={`/inventory/docs/${encodeURIComponent(row.sourceDocId)}`}
                          className="text-[var(--primary)] hover:underline"
                        >
                          {row.sourceDocId}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{row.sourceDocDate}</td>
                      <td className="px-3 py-2">{row.skuName}</td>
                      <td className="px-3 py-2">{row.specName ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{row.quantity}</td>
                      {canViewPrice && <>
                        <td className="px-3 py-2 text-right">{fmtPrice(row.marketStandardUnitPrice)}</td>
                        <td className="px-3 py-2 text-right">{fmtPrice(row.marketUnitDiscount)}</td>
                        <td className="px-3 py-2 text-right">{fmtPrice(row.marketActualUnitPrice)}</td>
                        <td className="px-3 py-2 text-right">{fmtAmount(row.amount)}</td>
                      </>}
                      <td className="px-3 py-2">{row.promotionPlanNo ?? '—'}</td>
                    </tr>
                  )))}
                </Fragment>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td className="px-3 py-8 text-center text-[#999999]" colSpan={canViewPrice ? 11 : 7}>
                    {rows.length === 0 ? '没有来源明细' : '该市场下没有来源明细'}
                  </td>
                </tr>
              )}
              {visibleRows.length > 0 && (
                <tr className="border-t border-[var(--border)] bg-[#F8F8F8]">
                  <td className="px-3 py-2 font-medium" colSpan={5}>合计</td>
                  <td className="px-3 py-2 text-right font-medium">{totalQuantity}</td>
                  {canViewPrice && <>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right font-medium">{fmtAmount(totalAmount)}</td>
                  </>}
                  <td className="px-3 py-2" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
