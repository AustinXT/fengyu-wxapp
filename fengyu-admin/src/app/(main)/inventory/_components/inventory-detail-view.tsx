import Link from 'next/link'
import type {
  InventoryItemDto,
  InventoryOrderRow,
} from '@/actions/inventory/types'
import { Card, CardContent } from '@/components/ui/card'
import { ArrowLeft } from 'lucide-react'
import { formatDateTime as fmtDateTime } from '@/lib/utils'

interface DetailField {
  label: string
  value: string | number | null | undefined
}

interface Props {
  category: 'procurement' | 'sale' | 'transfer' | 'scrap'
  title: string
  order: InventoryOrderRow & {
    items: (InventoryItemDto & { id: number; createdAt: string })[]
    // 各类型扩展字段
    isCompleted?: boolean
    sourceDate?: string | null
    sourceQuantity?: number | null
    signatureUrl?: string | null
    relatedDocNo?: string | null
    clientUserId?: string | null
    relatedSaleOrderId?: string | null
    counterpartStoreId?: string | null
    counterpartStoreName?: string | null
    isDispatcher?: boolean
    receiveQuantity?: number | null
  }
}

function fmt(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  return fmtDateTime(s)
}

export default function InventoryDetailView({ category, title, order }: Props) {
  const fields: DetailField[] = [
    { label: '单据号', value: order.id },
    ...(order.docSubtype ? [{ label: '子类型', value: order.docSubtype }] : []),
    { label: '门店', value: order.storeName ?? order.storeId },
    { label: '单据日期', value: order.docDate?.slice(0, 10) },
    { label: '状态', value: order.status },
    { label: '总数量', value: order.totalQuantity ?? '—' },
    { label: '录入人', value: order.createdByName ?? order.createdBy },
    { label: '录入时间', value: formatDateTime(order.createdAt) },
    { label: '更新时间', value: formatDateTime(order.updatedAt) },
    ...(order.confirmedAt
      ? [
          { label: '确认人', value: order.confirmedByName ?? order.confirmedBy },
          { label: '确认时间', value: formatDateTime(order.confirmedAt) },
        ]
      : []),
    { label: '备注', value: order.remark ?? '—' },
  ]

  if (category === 'procurement') {
    fields.push(
      { label: '是否完成', value: order.isCompleted ? '是' : '否' },
      { label: '市场配货日期', value: order.sourceDate?.slice(0, 10) },
      { label: '市场配货数量', value: order.sourceQuantity ?? null },
      { label: '引用市场出库单号', value: order.relatedDocNo ?? null },
      ...(order.signatureUrl
        ? [{ label: '签字图', value: order.signatureUrl }]
        : []),
    )
  }
  if (category === 'sale') {
    fields.push(
      { label: '顾客', value: order.customerName ?? null },
      { label: '引用销售单', value: order.relatedSaleOrderId ?? null },
    )
  }
  if (category === 'transfer') {
    fields.push(
      { label: '对方门店', value: order.counterpartStoreName ?? order.counterpartStoreId ?? null },
      {
        label: '本端身份',
        value: order.isDispatcher ? '发出方' : '接收方',
      },
      { label: '接收方实收数量', value: order.receiveQuantity ?? null },
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/inventory/${category}`}
          className="inline-flex items-center gap-1 text-sm text-[#666666] hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="size-4" /> 返回
        </Link>
        <h2 className="text-lg font-medium">{title}</h2>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {fields.map((f) => (
              <div key={f.label} className="flex flex-col gap-0.5">
                <span className="text-xs text-[#999999]">{f.label}</span>
                <span className="text-sm">{fmt(f.value)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div>
        <h3 className="text-sm font-medium mb-2">明细行（共 {order.items.length} 条）</h3>
        <div className="bg-white border border-[var(--border)] rounded-md overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8F8F8] text-xs text-[#666666]">
              <tr>
                <th className="px-3 py-2 text-left">产品编号</th>
                <th className="px-3 py-2 text-left">产品名</th>
                <th className="px-3 py-2 text-left">规格</th>
                <th className="px-3 py-2 text-left">批号</th>
                <th className="px-3 py-2 text-right">数量</th>
                <th className="px-3 py-2 text-right">单价</th>
                <th className="px-3 py-2 text-right">金额</th>
                {category === 'scrap' && (
                  <th className="px-3 py-2 text-left">报损原因</th>
                )}
                {category === 'sale' && (
                  <>
                    <th className="px-3 py-2 text-left">销售流水号</th>
                    <th className="px-3 py-2 text-right">剩余可领</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {order.items.map((it) => (
                <tr key={it.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-mono text-xs">{it.productCode}</td>
                  <td className="px-3 py-2">{it.productName}</td>
                  <td className="px-3 py-2">{fmt(it.specName)}</td>
                  <td className="px-3 py-2">{fmt(it.batchNo)}</td>
                  <td className="px-3 py-2 text-right font-medium">{it.quantity}</td>
                  <td className="px-3 py-2 text-right">{fmt(it.unitPrice)}</td>
                  <td className="px-3 py-2 text-right">{fmt(it.amount)}</td>
                  {category === 'scrap' && <td className="px-3 py-2">{fmt(it.scrapReason)}</td>}
                  {category === 'sale' && (
                    <>
                      <td className="px-3 py-2">{fmt(it.saleFlowNo)}</td>
                      <td className="px-3 py-2 text-right">{fmt(it.customerRemaining)}</td>
                    </>
                  )}
                </tr>
              ))}
              {order.items.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-[#999999]" colSpan={9}>
                    无明细
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
