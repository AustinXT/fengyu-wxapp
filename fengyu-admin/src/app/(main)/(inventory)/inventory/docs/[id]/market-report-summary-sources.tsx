import { Fragment } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { ExportButton } from '@/components/ui/export-button'
import type { MarketReportSummarySourceRow } from '@/lib/inventory/market-report-summary-detail-types'

/**
 * #349 汇总单「来源明细」：构成汇总单的原始报货行，按 市场 → 来源报货单 → 商品 展示。
 *
 * 市场筛选走**服务端 SQL**（与导出侧 `marketReportSummarySourceWhereSql` 的 `i.market_id = $market`
 * 同一份 where），市场下拉选项由 `listMarketReportSummarySourceMarkets` **独立查询**下发。
 * ⚠️ 不要改回"取全量行再在内存里筛"：行集会被 `MAX_PAGE_ROWS` 截断，截断后筛选既会漏行、
 * 选项也会缺市场，且与导出的行集不再同源（R2 已修过一次）。
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
  /**
   * 该市场内既有有价行、又有缺价行 —— 此时 amount 是**部分和**，必须显式标注。
   * 不标注的话，"只累加了有价行"会被读成"这就是该市场的全额小计"。
   */
  partialPrice: boolean
  docs: SourceDocGroup[]
}

function groupSources(rows: MarketReportSummarySourceRow[]): MarketGroup[] {
  const markets = new Map<string, {
    marketId: string
    marketName: string
    quantity: number
    amount: number | null
    hasPriced: boolean
    hasUnpriced: boolean
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
        // 初值必须与"该市场一行有价的行都没有"区分开：下面只在 row.amount 非 null 时累加，
        // 全缺价时保持 null → 页面显示「—」，而不是把"没价格"渲染成"合计为 0"。
        amount: null,
        hasPriced: false,
        hasUnpriced: false,
        docs: new Map(),
      }
      markets.set(marketKey, market)
    }
    market.quantity += row.quantity
    // 价格档为 none 时 amount 恒 null：保持 null 而不是累加成 0，
    // 否则"没价格"与"合计为 0"在页面上无法区分。
    if (row.amount !== null) {
      market.amount = round2((market.amount ?? 0) + row.amount)
      market.hasPriced = true
    } else {
      market.hasUnpriced = true
    }
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
    partialPrice: market.hasPriced && market.hasUnpriced,
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
  docId,
  query,
  marketFilter,
  marketOptions,
  canViewPrice,
  canExport,
  truncated,
  limit,
}: {
  /** 已按当前 market 筛选（服务端 SQL 层）后的行集。 */
  rows: MarketReportSummarySourceRow[]
  docId: string
  /** 当前 URL 的 searchParams，用于构造保留返回上下文的筛选链接。 */
  query: Record<string, string | undefined>
  marketFilter?: string
  /** 独立查询下发（不受截断与当前筛选影响），照结算页的做法。 */
  marketOptions: Array<{ id: string; name: string }>
  canViewPrice: boolean
  /** 与页面闸同源下发（`hasUiCapability(session.permissions.actions, 'inventory:export')`）。 */
  canExport: boolean
  truncated: boolean
  /** 本次展示上限，服务端回传。 */
  limit: number
}) {
  /*
   * 不再在内存里过滤：行集由服务端按 market 过滤（与导出同一 where）。
   * 原先的"取全量再内存筛"在 `MAX_PAGE_ROWS` 截断后会漏掉本该属于该市场的行，
   * 页面上却显示"该市场下没有来源明细" —— 与导出的行集不再同源。
   */
  const groups = groupSources(rows)
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0)
  const totalAmount = rows.reduce<number | null>(
    (sum, row) => (row.amount === null ? sum : round2((sum ?? 0) + row.amount)),
    null,
  )
  // 同上：整表既有有价行又有缺价行时，合计是部分和
  const totalPartialPrice = rows.some((row) => row.amount !== null) && rows.some((row) => row.amount === null)

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-medium">来源明细</h2>
          {/* 导出是辅助入口（会计凭证的主入口在货款结算-市场段）；带当前市场筛选，行集与页面一致。
              按 inventory:export 门控 —— 能打开汇总单详情不等于能导出，否则按钮点了才在任务侧被拒。 */}
          {canExport && (
            <ExportButton
              exportRequest={{
                exportType: 'market-report-summary-sources',
                payload: { docId, ...(marketFilter ? { market: marketFilter } : {}) },
              }}
            />
          )}
        </div>
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
            来源行数超过展示上限，仅显示前 {limit} 行；完整明细请用导出查看。
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
                      <td className="px-3 py-2 text-right font-medium">
                        {fmtAmount(market.amount)}
                        {market.partialPrice && <span className="ml-1 text-[10px] text-[#D4820A]">部分行无价</span>}
                      </td>
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
              {rows.length === 0 && (
                <tr>
                  <td className="px-3 py-8 text-center text-[#999999]" colSpan={canViewPrice ? 11 : 7}>
                    {marketFilter ? '该市场下没有来源明细' : '没有来源明细'}
                  </td>
                </tr>
              )}
              {rows.length > 0 && (
                <tr className="border-t border-[var(--border)] bg-[#F8F8F8]">
                  <td className="px-3 py-2 font-medium" colSpan={5}>合计</td>
                  <td className="px-3 py-2 text-right font-medium">{totalQuantity}</td>
                  {canViewPrice && <>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right font-medium">
                      {fmtAmount(totalAmount)}
                      {totalPartialPrice && <span className="ml-1 text-[10px] text-[#D4820A]">部分行无价</span>}
                    </td>
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
