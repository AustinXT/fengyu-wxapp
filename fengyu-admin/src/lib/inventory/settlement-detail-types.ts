/** #349 货款结算下钻明细：构成某个结算汇总行的单据行（含退货冲减行）。 */
export type SettlementDetailSegment = 'market' | 'store'

export interface SettlementDetailFilters {
  segment?: string
  startDate?: string
  endDate?: string
  /** 汇总行的市场侧主体（市场段=市场，分院段=配货市场）。**下钻必填**。 */
  marketNode?: string
  /** 汇总行的对方主体（市场段=供应链主体，分院段=门店）。**下钻必填**。 */
  partyNode?: string
  /** 期间内市场筛选，与汇总行同一口径（inventory_docs.market_id）。 */
  market?: string
}

/** 整段导出：会计凭证是"整月 × 整段"，不绑定某一个汇总行的两个端点。 */
export interface SettlementSegmentFilters {
  segment?: string
  startDate?: string
  endDate?: string
  market?: string
}

export interface SettlementDetailRow {
  /** inventory_doc_items.id —— 明细不可变主键，兼作 keyset 游标（bigint 全程 string）。 */
  id: string
  docId: string
  docType: string
  status: string
  /** 归期：正向单取 doc_date，退货单取审批日（上海时区）。 */
  effectiveDate: string
  /** 市场侧主体（下钻时行内一致；整段导出跨多个市场主体）。 */
  marketNode: string | null
  marketName: string | null
  /** 对方主体（市场段=供应链主体，分院段=门店）。 */
  partyNode: string | null
  partyName: string | null
  marketId: string | null
  skuId: string
  skuName: string
  specName: string | null
  batchNo: string
  /** 分院段的「是否赠送」；赠送行金额为 0（数量仍计入 total_quantity，与单头一致）。 */
  isGift: boolean
  /** 原值（正数）；退货行由 isReturn 标记，页面据此显示为负。 */
  quantity: number
  /** 带符号金额：正向为正、退货为负，已按段计价规则算好（市场退货走市场价）。 */
  signedAmount: number
  /** 该行是退货冲减行（院退货 / 市场退货）。 */
  isReturn: boolean
  /*
   * 价格列按段返回（见 settlement-details.ts 的 detailPriceColumnsSql）：市场段只填 market* 三列、
   * 分院段只填 store* 三列，另一段恒为 null。通用三件套（standard/unitDiscount/actual）**不返回** ——
   * 它们的语义随 doc_type 变（市场退货行上就是门店价），返回等于给供应链档开一条反推门店价的路径。
   */
  marketStandardUnitPrice: number | null
  marketUnitDiscount: number | null
  marketActualUnitPrice: number | null
  storeStandardUnitPrice: number | null
  storeUnitDiscount: number | null
  storeActualUnitPrice: number | null
}

export interface SettlementDetailResult {
  rows: SettlementDetailRow[]
  /** 行数超过单次展示上限（仅页面路径会遇到）；完整明细走导出。 */
  truncated: boolean
  /**
   * 本次的展示上限。**由服务端回传**而不是前端写死 ——
   * 上一版页面文案写死"500 行"、后端上限后来提到 2000，两边就漂了（评审 R4 抓到）。
   */
  limit: number
  /**
   * 该行的**完整**合计（不受展示上限影响，用同一投影单独聚合）。
   *
   * 验收「明细合计必须等于汇总行」靠它核对：只按 `rows` 累加的话，超过 `limit` 时
   * 页面合计小于汇总行，用户无从判断是数据问题还是截断 —— 这条正是 R5 评审报的验收缺口。
   * 与汇总行同源（同一投影、同一端点条件），两边的正/退货拆分口径也一致。
   */
  totals: {
    forwardQuantity: number
    returnedQuantity: number
    amount: number
  }
}
