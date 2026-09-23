"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Select, SelectOption } from "@/components/ui/select"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getProductBoard } from "@/actions/data-center/product"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable } from "../breakdown-table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { ProductBoardParams, ProductBoardResult } from "@/lib/data-center/types"

// ── KPI 卡片矩阵（key 对应后端 ProductBoardResult.kpis）────────────────
// #294：原 hint 的「未用完」「疗程卡」两个词都与 product.ts queryCardHolders 不符。
// 权威口径见 metrics.md:728「持卡 = 已解锁次数大于 0（paid_sessions > 0），不按 product_type 过滤」。
//
// ⚠ 用词取「已付次数」而非 metrics.md 的内部术语「已解锁次数」：admin UI 全仓
// 对 paid_sessions 的既有称呼是「已付」（order-detail-page.tsx:678「已用/已付/共」，
// ticket 2026-05-19 D10=A），本 issue 治的就是文案不一致，不该再造第三个词。
//
// ⚠ 四条措辞守则（均由闸门 1/2 评审提出，详见 _tmp/issue-294/review/）：
// ① **一个字都不要提 product_type 的枚举值**。SQL 确无 product_type 过滤，但家居产品
//    session_count 为空 ⇒ paid_sessions 恒 NULL（lib/paid-sessions.ts:43，并由 sale_items
//    的 chk_item_paid_sessions CHECK 兜住）⇒ `> 0` 对它恒 false —— 所以「不分疗程卡/
//    家居产品」字面对、语义反。但反过来写「只统计疗程卡」同样错：**本页是 product_kind
//    维度**（护理项目/家居产品/充值卡/体验卡，metrics.md:712/733），「疗程卡」是
//    product_type 的值（enums.ts:14 二元枚举），在本页筛选器里根本找不到；而体验卡
//    （is_experience capability，product.ts:76-79）的 product_type 正是疗程卡、必有次数，
//    用户照「只统计疗程卡」推断「选体验卡时持卡≈0」会与实际相反。
//    → 只用功能性表述「按次数计入，家居产品无次数故不参与统计」——「家居产品」
//      在两个维度里同名，是唯一安全的锚点。
// ② 不说「不限商品类型」——紧邻的筛选器就叫「一级/二级品项」，用户会读成
//    「不受本页筛选影响」，而事实相反（resolveGrouping 的 filter 真会收窄卡片数字）。
// ③ 占比不写「两者均为截面快照」——那是**正向保证**不是中立描述：用户看到
//    集团恒 253%（issue #287）时的第一怀疑是「有时差」，这句恰好堵死该路径却不给真因，
//    等于替 bug 背书。只点出分母口径，让异常自己暴露。
// ④ 守则 ③ 的执行范围**包括下方 section**：section 若写「持卡人数 / 占比为截面快照…
//    不随时间区间变化」，等于把同一句时差保证放回卡片正上方 3px 处、架空守则 ③。
//    section 只讲持卡人数，占比的口径交给 hint。
const KPI_CARD: KpiGridItem[] = [
  {
    key: "cardHolders",
    label: "持卡人数",
    hint: "已支付订单中已付次数 > 0 即计入，不扣已核销；随上方品项筛选变化",
  },
  { key: "cardHolderRate", label: "持卡占比", hint: "持卡人数 ÷ 会员数（分母 = 全部会员）" },
]
const KPI_CYCLE: KpiGridItem[] = [
  { key: "trialCount", label: "体验人数", hint: "区间内有购买但全历史未达标" },
  { key: "newCount", label: "品项进入人数", hint: "首次达标日落在区间内" },
  { key: "newRevenue", label: "进入业绩" },
  { key: "newAvgTicket", label: "进入客单价" },
  { key: "repurchaseCount", label: "复购人数", hint: "进入后的后续达标购买" },
  { key: "repurchaseRevenue", label: "复购业绩" },
  { key: "repurchaseAvgTicket", label: "复购客单价" },
  { key: "repurchaseRate", label: "复购率", hint: "复购人数 ÷ 品项进入人数" },
]

export function ProductBoard() {
  const { get, setMany, searchParams } = useUrlFilters()
  const [data, setData] = useState<ProductBoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // scope/时间/同比环比 + 一级(kind)/二级(category) 任一变化即重新取数
  const qs = searchParams.toString()
  const kind = get("kind")
  const category = get("category")

  useEffect(() => {
    const raw = Object.fromEntries(new URLSearchParams(qs).entries())
    const base = parseBoardParams(raw)
    const params: ProductBoardParams = {
      ...base,
      productKind: raw.kind || undefined,
      categoryName: raw.category || undefined,
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getProductBoard(params)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        // 生产构建会脱敏 message，必须走 actionErrorMessage 取 digest（issue #133）；
        // validateScope 的 4 条拒绝理由为何到不了这里，见 lib/data-center/context.ts 的说明。
        if (!cancelled) setError(actionErrorMessage(e, "请稍后重试"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [qs])

  const filterOptions = data?.filterOptions ?? []
  // 二级选项跟随当前一级（kind）；未选一级时无二级可选
  const secondLevel = filterOptions.find((o) => o.kind === kind)?.categories ?? []

  if (error) {
    return <Card className="p-6 text-sm text-[#D94040]">数据加载失败：{error}</Card>
  }

  const kpis = data?.kpis ?? {}
  const label = data?.timeRange.presetLabel ?? ""

  return (
    <div className="flex flex-col gap-6">
      {/* 品项筛选器：一级 kind → 二级 category（切一级清二级）*/}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">一级品项</span>
          <Select
            className="w-40"
            value={kind}
            onChange={(e) => setMany({ kind: e.target.value, category: "" })}
          >
            <SelectOption value="">全部品项</SelectOption>
            {filterOptions.map((o) => (
              <SelectOption key={o.kind} value={o.kind}>
                {o.kind}
              </SelectOption>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">二级品项</span>
          <Select
            className="w-48"
            value={category}
            disabled={!kind}
            onChange={(e) => setMany({ category: e.target.value })}
          >
            <SelectOption value="">{kind ? "全部二级" : "请先选一级"}</SelectOption>
            {secondLevel.map((c) => (
              <SelectOption key={c} value={c}>
                {c}
              </SelectOption>
            ))}
          </Select>
        </div>
      </div>

      {/* KPI：持卡（截面）*/}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">持卡情况</h2>
        <div className="text-xs text-[var(--muted-foreground)]">
          持卡人数为截面快照（持卡 = 已支付的销售单/转换单/寄存单中「已付次数 &gt; 0」，
          不扣已核销；按次数计入，家居产品无次数故不参与统计），不随时间区间变化。
        </div>
        <KpiGrid items={KPI_CARD} kpis={kpis} columns={2} />
      </section>

      {/* KPI：体验 / 进入 / 复购（区间）*/}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">体验 / 进入 / 复购</h2>
        <KpiGrid items={KPI_CYCLE} kpis={kpis} columns={4} />
      </section>

      {/* 明细表分 Tab：按市场 / 按门店 */}
      <Tabs defaultValue="market">
        <TabsList>
          <TabsTrigger value="market">按市场</TabsTrigger>
          <TabsTrigger value="store">按门店</TabsTrigger>
        </TabsList>
        <TabsContent value="market">
          <BreakdownTable
            rows={data?.byMarket ?? []}
            loading={loading}
            exportFilename={`品项明细_按市场_${label}`}
            exportView="product-market"
          />
        </TabsContent>
        <TabsContent value="store">
          <BreakdownTable
            rows={data?.byStore ?? []}
            loading={loading}
            exportFilename={`品项明细_按门店_${label}`}
            exportView="product-store"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
