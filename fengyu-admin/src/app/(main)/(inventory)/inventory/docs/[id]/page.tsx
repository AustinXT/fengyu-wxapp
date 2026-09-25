import Link from 'next/link'
import { ReturnContextLink } from '@/components/return-context'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getInventoryCoreDocById } from '@/actions/inventory/docs'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { fmtDateTime } from '@/lib/datetime'
import { getSession } from '@/lib/auth'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import { canOpenOrderDetail } from '@/lib/order-detail-access'
import { isStocktakeDocType, stocktakeDiff, stocktakeSummary } from '@/lib/inventory/stocktake'
import { resolveInventoryDocReturn } from '@/lib/inventory/operation-return'
import { inventoryDocStatusLabel } from '@/lib/inventory/doc-status-label'
import { InventoryDocReturnLink } from './inventory-doc-return-link'

export const dynamic = 'force-dynamic'

function fmt(v: string | number | boolean | null | undefined) {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

/** 盘盈绿 / 盘亏红 / 相符灰，取 admin 状态色（成功 / 错误 / 完结）。 */
function StocktakeDiffCell({ diff }: { diff: number | null }) {
  if (diff === null) return <td className="px-3 py-2 text-right text-[#999999]">—</td>
  const tone = diff > 0 ? 'text-[#3D8A5A]' : diff < 0 ? 'text-[#D94040]' : 'text-[#888888]'
  return (
    <td className={`px-3 py-2 text-right font-medium ${tone}`}>
      {diff > 0 ? `+${diff}` : String(diff)}
    </td>
  )
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  /** Next 15 起是 Promise，与同目录 `docs/page.tsx` 的写法一致；页面已 force-dynamic。 */
  searchParams?: Promise<Record<string, string | undefined>>
}) {
  const { id } = await params
  const query = await searchParams
  /*
   * #190 返回入口：办理台的单据号链接带 `?from=operations&level=<level>&op=<业务>`。
   * 白名单解析在服务端做一次（不把脏值当 prop 往下传），解析不出来就是 null ——
   * 页面回落到既有的「返回单据中心」，不会拿着来路不明的字符串去拼跳转路径。
   */
  const back = resolveInventoryDocReturn(query)
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list'])
  // 「关联销售单」能否点进订单详情：与 /orders/[id] 的页面守卫同源（#350）
  const canLinkOrder = canOpenOrderDetail(session.permissions.actions)
  const doc = await getInventoryCoreDocById(id)
  if (!doc) notFound()

  const showPrice = doc.totalAmount !== undefined && doc.docType !== '品项公司发货'
  // 标准价 / 优惠 / 实际价三列：分院配货（门店货款）与供应链采购入库（#346 入库单价优惠）
  const showStoreAllocationPrice = showPrice && (doc.docType === '分院配货' || doc.docType === '供应链采购入库')
  const discountPriceHeaders = doc.docType === '供应链采购入库'
    ? ['标准进价', '单价优惠', '实际进价', '金额']
    : ['门店标准单价', '单价优惠', '优惠后实际单价', '应付货款']
  const reportFulfillment = doc.fulfillmentProgress?.kind === '报货履约'
    ? doc.fulfillmentProgress
    : null
  const shipmentFulfillment = doc.fulfillmentProgress?.kind === '发货收货'
    ? doc.fulfillmentProgress
    : null
  const itemCompanyRequestFulfillment = doc.fulfillmentProgress?.kind === '品项公司报货履约'
    ? doc.fulfillmentProgress
    : null
  const supplyChainPurchaseFulfillment = doc.fulfillmentProgress?.kind === '供应链采购收货'
    ? doc.fulfillmentProgress
    : null
  const reportProgressByItemId = new Map(
    reportFulfillment?.items.map((item) => [item.itemId, item]) ?? [],
  )
  const shipmentProgressByItemId = new Map(
    shipmentFulfillment?.items.map((item) => [item.itemId, item]) ?? [],
  )
  const itemCompanyRequestProgressByItemId = new Map(
    itemCompanyRequestFulfillment?.items.map((item) => [item.itemId, item]) ?? [],
  )
  const supplyChainPurchaseProgressByItemId = new Map(
    supplyChainPurchaseFulfillment?.items.map((item) => [item.itemId, item]) ?? [],
  )
  const reportColumnCount = reportFulfillment
    ? (doc.docType === '市场报货' ? 6 : 5)
    : 0
  const shipmentColumnCount = shipmentFulfillment ? 2 : 0
  const itemCompanyRequestColumnCount = itemCompanyRequestFulfillment ? 3 : 0
  // 采购订单的市场行（#335）：同样经供应链采购入库，另列市场结算价（参考）。
  // 发货自 #336 起直连市场报货单，采购单上不再有「已发货」列。
  const hasPurchaseMarketLine = doc.docType === '采购订单' && doc.items.some((item) => item.marketId)
  // #346：入库可填单价优惠，采购单「入库后实际金额」按各次入库的实际进价算（不是下单价），价格可见时才有
  // 进度被价格档遮蔽时不带金额；单头合计要求每一行都算得出（历史按发货完结的单、缺下单价的行服务端不给 actualAmount）
  const purchaseAmountVisible = showPrice && Boolean(supplyChainPurchaseFulfillment?.items.some((item) => item.receivedAmount !== undefined))
  const purchaseActualAmount = purchaseAmountVisible && supplyChainPurchaseFulfillment!.items.every((item) => item.actualAmount !== undefined)
    ? Number(supplyChainPurchaseFulfillment!.items.reduce((sum, item) => sum + item.actualAmount!, 0).toFixed(2))
    : null
  const supplyChainPurchaseColumnCount = supplyChainPurchaseFulfillment ? (purchaseAmountVisible ? 3 : 2) : 0
  // 盘点单：把「数量」当实盘数，额外并排展示账面数与差异。
  // 差异是纯派生值（实盘 − 账面），**前端算、不落库** —— 落库就多一个会漂的数（issue #131 Q2）。
  const isStocktake = isStocktakeDocType(doc.docType)
  const stocktakeColumnCount = isStocktake ? 2 : 0
  // 供应商与市场两列的成立条件并不相同，分开判：
  //
  // 供应商：采购订单/汇总单把它挂在行上（#194 单头不再挂），其下游的发货、入库单
  // 行上带的是批次供应商。按「行上是否真有」判断而不是按 docType，这样 0043 回填过的
  // 存量单据也能显示；末一项兜住只有名称快照、没有档案关联的存量行 ——
  // 但单头已经显示了供应商时就不重复列。
  const lineSupplierColumnCount = doc.items.some(
    (item) => item.supplierId || (item.supplier && !doc.supplierName),
  ) ? 1 : 0
  // 市场：**只有采购订单与市场报货汇总的行级归属是权威的**。下游发货/入库单的市场记在
  // 单头、明细行为空，若一并按行渲染会把它们统统误标成「品项公司自用」。
  const lineMarketColumnCount = (doc.docType === '采购订单' || doc.docType === '市场报货汇总') ? 1 : 0
  const lineOwnershipColumnCount = lineSupplierColumnCount + lineMarketColumnCount
  const marketReferencePriceColumnCount = showPrice && !showStoreAllocationPrice && hasPurchaseMarketLine ? 1 : 0
  const priceColumnCount = showPrice ? (showStoreAllocationPrice ? 4 : 2 + marketReferencePriceColumnCount) : 0
  const promotionColumnCount = doc.items.some((item) => item.promotionPlanId || item.promotionPlanNoSnapshot) ? 1 : 0
  const itemColumnCount = 9 + lineOwnershipColumnCount + priceColumnCount + reportColumnCount + shipmentColumnCount +
    itemCompanyRequestColumnCount + supplyChainPurchaseColumnCount + promotionColumnCount +
    stocktakeColumnCount
  const fields = [
    ['单据号', doc.id],
    ['类型', doc.docType],
    ['状态', inventoryDocStatusLabel(doc)],
    ['出库/发起主体', doc.sourceOrgNodeName ?? doc.sourceOrgNodeId],
    ['入库/接收主体', doc.targetOrgNodeName ?? doc.targetOrgNodeId],
    ['单据日期', doc.docDate?.slice(0, 10)],
    ['总数量', doc.totalQuantity],
    ...(isStocktake ? ([['盘点结论', stocktakeSummary(doc.items)]] as const) : []),
    ...(showPrice ? ([['金额', doc.totalAmount]] as const) : []),
    ...(purchaseActualAmount !== null ? ([['入库后实际金额', purchaseActualAmount]] as const) : []),
    ['顾客', doc.customerName],
    // #350：顾客出库（GCK）由提货服务产生，related_sale_order_id 记着是哪张销售单的货
    ['关联销售单', doc.relatedSaleOrderId],
    ['员工', doc.employeeName],
    ['供应商', doc.supplierName],
    ['外部对象', doc.externalPartyName],
    ['物流', doc.logisticsCompany],
    ['运单号', doc.trackingNo],
    ['收据附件', doc.receiptAttachmentUrl],
    ['录入人', doc.createdBy],
    ['确认时间', doc.confirmedAt ? fmtDateTime(doc.confirmedAt) : null],
    ['审批时间', doc.approvedAt ? fmtDateTime(doc.approvedAt) : null],
    ['驳回时间', doc.rejectedAt ? fmtDateTime(doc.rejectedAt) : null],
    ['审核备注', doc.auditRemark],
    ['撤回申请原因', doc.cancellationRequestReason],
    ['撤回申请人', doc.cancellationRequestedBy],
    ['撤回申请时间', doc.cancellationRequestedAt ? fmtDateTime(doc.cancellationRequestedAt) : null],
    ['撤回原因', doc.cancellationReason],
    ['备注', doc.remark],
  ] as const

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        {/*
          * 两条来源天然互斥，优先级明确：
          *   单据中心列表 → PreserveListContextLink 注入 `?returnTo=` → 走 ReturnContextLink；
          *   办理台单据 Tab → `?from/level/op` 枚举、**不带 returnTo** → 走 InventoryDocReturnLink，
          *   它会先试 window.close() 真正回到原标签（办理台表单不丢），关不掉再导航过去。
          */}
        {back ? (
          <InventoryDocReturnLink
            href={back.href}
            label={back.label}
            className="inline-flex items-center gap-1 text-sm text-[#666666] hover:text-[var(--foreground)]"
          />
        ) : (
          <ReturnContextLink
            href="/inventory/docs"
            className="inline-flex items-center gap-1 text-sm text-[#666666] hover:text-[var(--foreground)]"
          >
            <ArrowLeft className="size-4" /> 返回
          </ReturnContextLink>
        )}
        <h1 className="text-xl font-medium">库存单据详情</h1>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {fields.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="text-xs text-[#888888]">{label}</span>
                {label === '收据附件' && typeof value === 'string' && value ? (
                  <a
                    href={value}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-[var(--primary)] hover:underline"
                  >
                    查看附件
                  </a>
                ) : label === '关联销售单' && typeof value === 'string' && value && canLinkOrder ? (
                  <Link
                    href={`/orders/${encodeURIComponent(value)}`}
                    className="font-mono text-sm text-[var(--primary)] hover:underline"
                  >
                    {value}
                  </Link>
                ) : <span className="text-sm">{fmt(value)}</span>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h2 className="mb-4 text-base font-medium">关联单据血缘</h2>
          <div className="overflow-x-auto rounded-md border border-[var(--border)]">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-[#F8F8F8] text-xs text-[#666666]">
                <tr>
                  <th className="px-3 py-2 text-left">方向</th>
                  <th className="px-3 py-2 text-left">关系</th>
                  <th className="px-3 py-2 text-left">关联单据</th>
                  <th className="px-3 py-2 text-left">类型</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-right">关联数量</th>
                  <th className="px-3 py-2 text-right">单据总数量</th>
                  <th className="px-3 py-2 text-left">单据日期</th>
                </tr>
              </thead>
              <tbody>
                {doc.lineage.map((lineage) => (
                  <tr key={`${lineage.direction}-${lineage.relationType}-${lineage.docId}`} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">{lineage.direction}</td>
                    <td className="px-3 py-2">{lineage.relationType}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/inventory/docs/${encodeURIComponent(lineage.docId)}`} className="text-[var(--primary)] hover:underline">
                        {lineage.docId}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{lineage.docType}</td>
                    <td className="px-3 py-2">{lineage.status}</td>
                    {/* #344 库存转换 N:M：关联数量记的是分摊到该目标的来源（出库）数量，与入库单总数量不同口径 */}
                    <td className="px-3 py-2 text-right">{lineage.linkedQuantity}{lineage.relationType === '库存转换' && <span className="ml-1 text-xs text-[#999999]">（按出库数量）</span>}</td>
                    <td className="px-3 py-2 text-right">{lineage.totalQuantity}</td>
                    <td className="px-3 py-2">{fmt(lineage.docDate?.slice(0, 10))}</td>
                  </tr>
                ))}
                {doc.lineage.length === 0 && (
                  <tr>
                    <td className="px-3 py-8 text-center text-[#999999]" colSpan={8}>暂无关联单据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-md border border-[var(--border)] bg-white">
        <table className={`w-full ${
          showStoreAllocationPrice ? 'min-w-[1180px]' : isStocktake ? 'min-w-[1080px]' : 'min-w-[960px]'
        } text-sm`}>
          <thead className="bg-[#F8F8F8] text-xs text-[#666666]">
            <tr>
              <th className="px-3 py-2 text-left">批次ID</th>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">产品</th>
              <th className="px-3 py-2 text-left">规格</th>
              <th className="px-3 py-2 text-left">批号</th>
              <th className="px-3 py-2 text-left">效期</th>
              {isStocktake && <th className="px-3 py-2 text-right">账面数量</th>}
              <th className="px-3 py-2 text-right">{isStocktake ? '实盘数量' : '数量'}</th>
              {isStocktake && <th className="px-3 py-2 text-right">差异</th>}
              <th className="px-3 py-2 text-left">赠送</th>
              {lineSupplierColumnCount > 0 && <th className="px-3 py-2 text-left">供应商</th>}
              {lineMarketColumnCount > 0 && <th className="px-3 py-2 text-left">市场</th>}
              {showStoreAllocationPrice ? <>
                {discountPriceHeaders.map((header) => <th key={header} className="px-3 py-2 text-right">{header}</th>)}
              </> : showPrice && <>
                <th className="px-3 py-2 text-right">实际单价</th>
                <th className="px-3 py-2 text-right">金额</th>
                {marketReferencePriceColumnCount > 0 && <th className="px-3 py-2 text-right">市场结算价（参考）</th>}
              </>}
              {promotionColumnCount > 0 && <th className="px-3 py-2 text-left">报货福利</th>}
              {reportFulfillment && <>
                <th className="px-3 py-2 text-right">正常需求</th>
                {doc.docType === '市场报货' && <th className="px-3 py-2 text-right">已采购</th>}
                <th className="px-3 py-2 text-right">正常发货/配货</th>
                <th className="px-3 py-2 text-right">赠送发货/配货</th>
                <th className="px-3 py-2 text-right">正常已收</th>
                <th className="px-3 py-2 text-right">赠送已收</th>
              </>}
              {shipmentFulfillment && <>
                <th className="px-3 py-2 text-right">已收</th>
                <th className="px-3 py-2 text-right">待收</th>
              </>}
              {itemCompanyRequestFulfillment && <>
                <th className="px-3 py-2 text-right">需求</th>
                <th className="px-3 py-2 text-right">已下单</th>
                <th className="px-3 py-2 text-right">已入库</th>
              </>}
              {supplyChainPurchaseFulfillment && <>
                <th className="px-3 py-2 text-right">已入库</th>
                <th className="px-3 py-2 text-right">待入库</th>
                {purchaseAmountVisible && <th className="px-3 py-2 text-right">已入库金额</th>}
              </>}
              <th className="px-3 py-2 text-left">原因</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item) => {
              const reportProgress = reportProgressByItemId.get(item.id)
              const shipmentProgress = shipmentProgressByItemId.get(item.id)
              const itemCompanyRequestProgress = itemCompanyRequestProgressByItemId.get(item.id)
              const supplyChainPurchaseProgress = supplyChainPurchaseProgressByItemId.get(item.id)
              return (
                <tr key={item.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-mono text-xs">{fmt(item.lotId)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{item.skuId}</td>
                  <td className="px-3 py-2">{item.skuName}</td>
                  <td className="px-3 py-2">{fmt(item.specName)}</td>
                  <td className="px-3 py-2">{fmt(item.batchNo)}</td>
                  <td className="px-3 py-2">{fmt(item.expiryDate?.slice(0, 10))}</td>
                  {isStocktake && (
                    <td className="px-3 py-2 text-right">{fmt(item.stockSnapshot)}</td>
                  )}
                  <td className="px-3 py-2 text-right font-medium">{item.quantity}</td>
                  {isStocktake && <StocktakeDiffCell diff={stocktakeDiff(item)} />}
                  <td className="px-3 py-2">
                    {item.isGift ? <Badge variant="outline" className="text-[10px]">赠送</Badge> : '—'}
                  </td>
                  {lineSupplierColumnCount > 0 && <td className="px-3 py-2">{fmt(item.supplier)}</td>}
                  {lineMarketColumnCount > 0 && (
                    <td className="px-3 py-2">{item.marketId ? fmt(item.marketName) : '品项公司自用'}</td>
                  )}
                  {showStoreAllocationPrice ? <>
                    <td className="px-3 py-2 text-right">{fmt(item.standardUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.unitDiscount)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.actualUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.amount)}</td>
                  </> : showPrice && <>
                    <td className="px-3 py-2 text-right">{fmt(item.actualUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.amount)}</td>
                    {marketReferencePriceColumnCount > 0 && (
                      <td className="px-3 py-2 text-right">{item.marketId ? fmt(item.marketActualUnitPrice) : '—'}</td>
                    )}
                  </>}
                  {promotionColumnCount > 0 && (
                    <td className="px-3 py-2">
                      {item.promotionPlanNoSnapshot ? (
                        <div>
                          <div className="font-medium">{item.promotionPlanNoSnapshot}</div>
                          <div className="text-xs text-[#888888]">
                            {item.promotionPlanNameSnapshot ?? '—'} · {item.promotionRuleTypeSnapshot ?? '—'} · {item.promotionSelectionMode ?? '历史记录'}
                          </div>
                        </div>
                      ) : '—'}
                    </td>
                  )}
                  {reportFulfillment && <>
                    <td className="px-3 py-2 text-right">{fmt(reportProgress?.normalDemandQuantity)}</td>
                    {doc.docType === '市场报货' && <td className="px-3 py-2 text-right">{fmt(reportProgress?.orderedQuantity)}</td>}
                    <td className="px-3 py-2 text-right">{fmt(reportProgress?.normalFulfilledQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(reportProgress?.giftFulfilledQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(reportProgress?.normalReceivedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(reportProgress?.giftReceivedQuantity)}</td>
                  </>}
                  {shipmentFulfillment && <>
                    <td className="px-3 py-2 text-right">{fmt(shipmentProgress?.receivedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(shipmentProgress?.outstandingQuantity)}</td>
                  </>}
                  {itemCompanyRequestFulfillment && <>
                    <td className="px-3 py-2 text-right">{fmt(itemCompanyRequestProgress?.demandQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(itemCompanyRequestProgress?.orderedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(itemCompanyRequestProgress?.receivedQuantity)}</td>
                  </>}
                  {supplyChainPurchaseFulfillment && <>
                    <td className="px-3 py-2 text-right">{fmt(supplyChainPurchaseProgress?.receivedQuantity)}</td>
                    <td className="px-3 py-2 text-right">{fmt(supplyChainPurchaseProgress?.outstandingQuantity)}</td>
                    {purchaseAmountVisible && <td className="px-3 py-2 text-right">{fmt(supplyChainPurchaseProgress?.receivedAmount)}</td>}
                  </>}
                  <td className="px-3 py-2">{fmt(item.reason)}</td>
                </tr>
              )
            })}
            {doc.items.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-[#999999]" colSpan={itemColumnCount}>
                  无明细
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
