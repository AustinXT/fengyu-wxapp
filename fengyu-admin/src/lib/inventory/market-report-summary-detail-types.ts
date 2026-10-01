/**
 * #349 汇总单来源明细：构成一张市场报货汇总单的原始报货行。
 * 取数走 inventory_doc_links(relation_type='市场报货汇总', to_doc_id=汇总单) 经 from_item_id
 * 回到来源市场报货明细；数量读 link 上的分摊量，价格读来源行快照，**不读 SKU 现价**。
 */
export interface MarketReportSummarySourceFilters {
  /** 作用在来源行的 market_id 上：汇总单单头 market_id 为 NULL（跨市场汇总），筛选只能在行上做。 */
  market?: string
}

export interface MarketReportSummarySourceRow {
  /** inventory_doc_links.id —— 明细不可变主键，兼作 keyset 游标（bigint 全程 string）。 */
  id: string
  marketId: string | null
  marketName: string | null
  /** 来源市场报货单号，可跳转单据详情。 */
  sourceDocId: string
  sourceDocDate: string
  skuId: string
  skuName: string
  specName: string | null
  batchNo: string
  /** 本次汇总分摊到该来源行的数量（link.quantity），非来源行的原始报货数量。 */
  quantity: number
  marketStandardUnitPrice: number | null
  marketUnitDiscount: number | null
  marketActualUnitPrice: number | null
  /** 本次汇总金额 = quantity × marketActualUnitPrice；价格档为 none 时与三个单价一并返回 null。 */
  amount: number | null
  promotionPlanNo: string | null
}

export interface MarketReportSummarySourcePage {
  rows: MarketReportSummarySourceRow[]
  total: number
  page: number
  pageSize: number
}

/** 每市场小计与末行合计由页面按 rows 派生 —— 与明细同源，避免第二处实现漂移。 */
export interface MarketReportSummarySourceTotals {
  quantity: number
  amount: number
}
