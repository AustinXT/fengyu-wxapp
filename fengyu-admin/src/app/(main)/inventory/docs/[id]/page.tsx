import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getInventoryCoreDocById } from '@/actions/inventory/docs'
import { Card, CardContent } from '@/components/ui/card'
import { fmtDateTime } from '@/lib/datetime'

export const dynamic = 'force-dynamic'

function fmt(v: string | number | boolean | null | undefined) {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const doc = await getInventoryCoreDocById(id)
  if (!doc) notFound()

  const showPrice = doc.totalAmount !== undefined
  const fields = [
    ['单据号', doc.id],
    ['类型', doc.docType],
    ['状态', doc.status],
    ['出库/发起主体', doc.sourceLocationName ?? doc.sourceLocationId],
    ['入库/接收主体', doc.targetLocationName ?? doc.targetLocationId],
    ['单据日期', doc.docDate?.slice(0, 10)],
    ['总数量', doc.totalQuantity],
    ...(showPrice ? ([['金额', doc.totalAmount]] as const) : []),
    ['顾客', doc.customerName],
    ['员工', doc.employeeName],
    ['供应商', doc.supplierName],
    ['外部对象', doc.externalPartyName],
    ['物流', doc.logisticsCompany],
    ['运单号', doc.trackingNo],
    ['收据附件', doc.receiptAttachmentUrl],
    ['关联单据', doc.relatedDocId],
    ['引用报货单', doc.requestDocId],
    ['录入人', doc.createdBy],
    ['确认时间', doc.confirmedAt ? fmtDateTime(doc.confirmedAt) : null],
    ['审批时间', doc.approvedAt ? fmtDateTime(doc.approvedAt) : null],
    ['驳回时间', doc.rejectedAt ? fmtDateTime(doc.rejectedAt) : null],
    ['审核备注', doc.auditRemark],
    ['撤回原因', doc.cancellationReason],
    ['备注', doc.remark],
  ] as const

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/inventory/docs"
          className="inline-flex items-center gap-1 text-sm text-[#666666] hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="size-4" /> 返回
        </Link>
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

      <div className="overflow-x-auto rounded-md border border-[var(--border)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[#F8F8F8] text-xs text-[#666666]">
            <tr>
              <th className="px-3 py-2 text-left">批次ID</th>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">产品</th>
              <th className="px-3 py-2 text-left">规格</th>
              <th className="px-3 py-2 text-left">批号</th>
              <th className="px-3 py-2 text-left">效期</th>
              <th className="px-3 py-2 text-right">数量</th>
              {showPrice && <th className="px-3 py-2 text-right">实际单价</th>}
              {showPrice && <th className="px-3 py-2 text-right">金额</th>}
              <th className="px-3 py-2 text-left">原因</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item) => (
              <tr key={item.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-2 font-mono text-xs">{fmt(item.lotId)}</td>
                <td className="px-3 py-2 font-mono text-xs">{item.skuId}</td>
                <td className="px-3 py-2">{item.skuName}</td>
                <td className="px-3 py-2">{fmt(item.specName)}</td>
                <td className="px-3 py-2">{fmt(item.batchNo)}</td>
                <td className="px-3 py-2">{fmt(item.expiryDate?.slice(0, 10))}</td>
                <td className="px-3 py-2 text-right font-medium">{item.quantity}</td>
                {showPrice && <td className="px-3 py-2 text-right">{fmt(item.actualUnitPrice)}</td>}
                {showPrice && <td className="px-3 py-2 text-right">{fmt(item.amount)}</td>}
                <td className="px-3 py-2">{fmt(item.reason)}</td>
              </tr>
            ))}
            {doc.items.length === 0 && (
              <tr>
                <td className="px-3 py-8 text-center text-[#999999]" colSpan={showPrice ? 10 : 8}>
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
