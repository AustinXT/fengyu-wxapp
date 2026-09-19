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
import { isStocktakeDocType, stocktakeDiff, stocktakeSummary } from '@/lib/inventory/stocktake'

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
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  requireAllUiPageCapabilities(await getSession(), ['inventory:list'])
  const doc = await getInventoryCoreDocById(id)
  if (!doc) notFound()

  const showPrice = doc.totalAmount !== undefined && doc.docType !== '品项公司发货'
  const showStoreAllocationPrice = showPrice && doc.docType === '分院配货'
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
  const supplyChainPurchaseColumnCount = supplyChainPurchaseFulfillment ? 2 : 0
  // 盘点单：把「数量」当实盘数，额外并排展示账面数与差异。
  // 差异是纯派生值（实盘 − 账面），**前端算、不落库** —— 落库就多一个会漂的数（issue #131 Q2）。
  const isStocktake = isStocktakeDocType(doc.docType)
  const stocktakeColumnCount = isStocktake ? 2 : 0
  // 采购订单与市场报货汇总把供应商/市场挂在明细行上（#193 #194），单头没有这两个字段。
  // 按「行上是否真有归属」判断而不是按 docType，这样 0043 回填过的存量单据也能显示。
  const lineOwnershipColumnCount = doc.items.some((item) => item.supplierId || item.marketId) ? 2 : 0
  const priceColumnCount = showPrice ? (showStoreAllocationPrice ? 4 : 2) : 0
  const promotionColumnCount = doc.items.some((item) => item.promotionPlanId || item.promotionPlanNoSnapshot) ? 1 : 0
  const itemColumnCount = 9 + lineOwnershipColumnCount + priceColumnCount + reportColumnCount + shipmentColumnCount +
    itemCompanyRequestColumnCount + supplyChainPurchaseColumnCount + promotionColumnCount +
    stocktakeColumnCount
  const fields = [
    ['单据号', doc.id],
    ['类型', doc.docType],
    ['状态', doc.status],
    ['出库/发起主体', doc.sourceOrgNodeName ?? doc.sourceOrgNodeId],
    ['入库/接收主体', doc.targetOrgNodeName ?? doc.targetOrgNodeId],
    ['单据日期', doc.docDate?.slice(0, 10)],
    ['总数量', doc.totalQuantity],
    ...(isStocktake ? ([['盘点结论', stocktakeSummary(doc.items)]] as const) : []),
    ...(showPrice ? ([['金额', doc.totalAmount]] as const) : []),
    ['顾客', doc.customerName],
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
        <ReturnContextLink
          href="/inventory/docs"
          className="inline-flex items-center gap-1 text-sm text-[#666666] hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="size-4" /> 返回
        </ReturnContextLink>
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
                    <td className="px-3 py-2 text-right">{lineage.linkedQuantity}</td>
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
              {lineOwnershipColumnCount > 0 && <>
                <th className="px-3 py-2 text-left">供应商</th>
                <th className="px-3 py-2 text-left">市场</th>
              </>}
              {showStoreAllocationPrice ? <>
                <th className="px-3 py-2 text-right">门店标准单价</th>
                <th className="px-3 py-2 text-right">单价优惠</th>
                <th className="px-3 py-2 text-right">优惠后实际单价</th>
                <th className="px-3 py-2 text-right">应付货款</th>
              </> : showPrice && <>
                <th className="px-3 py-2 text-right">实际单价</th>
                <th className="px-3 py-2 text-right">金额</th>
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
                  {lineOwnershipColumnCount > 0 && <>
                    <td className="px-3 py-2">{fmt(item.supplier)}</td>
                    <td className="px-3 py-2">{item.marketId ? fmt(item.marketName) : '品项公司自用'}</td>
                  </>}
                  {showStoreAllocationPrice ? <>
                    <td className="px-3 py-2 text-right">{fmt(item.standardUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.unitDiscount)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.actualUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.amount)}</td>
                  </> : showPrice && <>
                    <td className="px-3 py-2 text-right">{fmt(item.actualUnitPrice)}</td>
                    <td className="px-3 py-2 text-right">{fmt(item.amount)}</td>
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
