import { db } from '@/db'
import { orgNodes } from '@db/org'
import { exportMallProducts, exportProductSkus } from '@/actions/products'
import { exportCouponTemplates, getMarkets } from '@/actions/coupons'
import {
  exportOrders,
  exportOrderPayments,
  exportAllocationOrders,
  type ExportAllocationOrdersCursor,
  type ExportOrdersCursor,
} from '@/actions/orders'
import { exportRefunds } from '@/actions/refunds'
import {
  exportServiceOrders,
  exportAllocationServiceOrders,
  type ExportAllocationServiceCursor,
} from '@/actions/services'
import { exportCustomers } from '@/actions/customers'
import { exportEmployees } from '@/actions/employees'
import { exportPointTransactions } from '@/actions/points'
import { exportCards } from '@/actions/cards'
import { exportInventoryLots } from '@/actions/inventory/stocks'
import { getSalesBoard } from '@/actions/data-center/sales'
import { getCustomerBoard } from '@/actions/data-center/customer'
import { getProductBoard } from '@/actions/data-center/product'
import { getEfficiencyBoard } from '@/actions/data-center/efficiency'
import {
  getDataCenterBreakdownConfig,
  getDataCenterRankingConfig,
  type DataCenterMetricColumn,
} from '@/lib/data-center/columns'
import { parseBoardParams } from '@/lib/data-center/params'
import { headerWithUnit, metricCell } from '@/lib/data-center/export'
import type { BreakdownRow, RankingRow } from '@/lib/data-center/types'
import { fmtDate, fmtDateTime } from '@/lib/datetime'
import { formatCurrency } from '@/lib/utils'
import {
  EXPORT_WORKER_BATCH_SIZE,
  iterateExportPages,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import {
  aggregateAllocationExportRows,
  aggregateContiguousExportRows,
  aggregateOrderExportRows,
} from '@/lib/export-row-aggregation'
import {
  exportJobLabel,
  type DataCenterExportPayload,
  type ExportJobPayload,
  type ExportJobType,
} from '@/lib/export-job-types'
import type { WorkerExportColumn, ExportCell } from './xlsx-writer'
import type { ExportContextMeta } from './export-meta'

export interface ExportContent {
  sheetName: string
  columns: WorkerExportColumn<Record<string, unknown>>[]
  rows: AsyncIterable<Record<string, unknown>>
  /** 以下为矩阵报表（#368）可选项，旧导出类型不填即保持原样 */
  frozenColumns?: number
  /** 给出即写合计行（各列合计值放在 column.total，见 lib/data-center/matrix-export.ts） */
  totalsLabel?: string
  isEmphasisRow?: (row: Record<string, unknown>) => boolean
  /** 业务元信息（时间区间 / scope / 基期）；导出时间与导出人由 worker 追加 */
  meta?: ExportContextMeta
}

type Row = Record<string, unknown>

function value(row: Row, key: string): unknown {
  return row[key]
}

function text(row: Row, key: string): ExportCell {
  const item = value(row, key)
  return item == null ? '' : String(item)
}

function cellOr(valueToConvert: unknown, fallback = ''): ExportCell {
  if (valueToConvert == null) return fallback
  if (
    typeof valueToConvert === 'string' ||
    typeof valueToConvert === 'number' ||
    typeof valueToConvert === 'boolean' ||
    valueToConvert instanceof Date
  ) {
    return valueToConvert
  }
  return fallback
}

function numberOrEmpty(row: Row, key: string): ExportCell {
  const item = value(row, key)
  if (item == null || item === '') return ''
  const n = Number(item)
  return Number.isFinite(n) ? n : ''
}

function boolLabel(row: Row, key: string): string {
  return value(row, key) ? '是' : '否'
}

function percent(valueToFormat: unknown): string {
  if (valueToFormat == null || valueToFormat === '') return ''
  const n = Number(valueToFormat)
  return Number.isFinite(n) ? `${Number((n * 100).toFixed(2))}%` : ''
}

function maskIdCard(valueToMask: unknown): string {
  const raw = valueToMask == null ? '' : String(valueToMask).trim()
  return raw.length <= 4 ? raw : `****${raw.slice(-4)}`
}

function fromRows<T extends Row>(rows: T[]): AsyncIterable<Row> {
  return (async function* () {
    for (const row of rows) yield row
  })()
}

function pagedRows<T, Cursor>(
  fetch: (options: ExportBatchOptions<Cursor>) => Promise<ExportBatchResult<T, Cursor>>,
  firstPage?: ExportBatchResult<T, Cursor>,
): AsyncIterable<Row> {
  return (async function* () {
    for await (const row of iterateExportPages(fetch, firstPage)) {
      yield row as unknown as Row
    }
  })()
}

function mapColumns(
  definitions: Array<{ header: string; width?: number; key: string; map?: (row: Row) => ExportCell }>,
): WorkerExportColumn<Row>[] {
  return definitions.map((definition) => ({
    header: definition.header,
    width: definition.width,
    value: definition.map ?? ((row: Row) => text(row, definition.key)),
  }))
}

const paymentMethodMap: Record<string, string> = {
  微信: '微信支付',
  支付宝: '支付宝',
  线下: '线下支付',
  无: '无（全额抵扣）',
}

const orderColumns = mapColumns([
  { header: '市场', width: 12, key: 'marketName' },
  { header: '门店', width: 16, key: 'storeName' },
  { header: '订单号', width: 22, key: 'saleOrderId' },
  { header: '类型', width: 10, key: 'saleOrderType' },
  { header: '单据类型', width: 10, key: 'documentType' },
  { header: '顾客', width: 12, key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'clientPhone' },
  { header: '顾客来源', width: 12, key: 'customerSource' },
  { header: '推荐人', width: 12, key: 'promoterEmployeeName' },
  { header: '商品类型', width: 10, key: 'productType' },
  { header: '品质(一级)', width: 14, key: 'categoryL1' },
  { header: '品质(二级)', width: 14, key: 'categoryL2' },
  { header: '商品明细', width: 28, key: 'productName' },
  { header: '总数量', width: 8, key: 'sessionCount', map: (row) => cellOr(value(row, 'sessionCount'), '—') },
  { header: '单位', width: 8, key: 'unit' },
  { header: '可用数量', width: 10, key: 'paidUnusedSessions', map: (row) => cellOr(value(row, 'paidUnusedSessions'), '—') },
  { header: '订单金额', width: 10, key: 'totalAmount' },
  { header: '储值卡抵扣', width: 10, key: 'prepaidCardAmount' },
  { header: '现付', width: 10, key: 'cashAmount' },
  { header: '实付', width: 10, key: 'received' },
  { header: '已退', width: 10, key: 'refundedAmount' },
  { header: '单价', width: 10, key: 'unitRealPrice', map: (row) => numberOrEmpty(row, 'unitRealPrice') },
  { header: '状态', width: 10, key: 'status' },
  { header: '支付方式', width: 12, key: 'paymentMethod', map: (row) => paymentMethodMap[String(value(row, 'paymentMethod') ?? '')] ?? text(row, 'paymentMethod') },
  { header: '是否纳客', width: 8, key: 'isMembershipUpgrade', map: (row) => boolLabel(row, 'isMembershipUpgrade') },
  { header: '是否活动', width: 8, key: 'isActivity', map: (row) => boolLabel(row, 'isActivity') },
  { header: '是否体验转换', width: 12, key: 'isExperienceConversion', map: (row) => boolLabel(row, 'isExperienceConversion') },
  { header: '经营类型', width: 10, key: 'salesCategory' },
  { header: '顾客类型', width: 10, key: 'customerType', map: (row) => cellOr(value(row, 'customerType'), '未注册') },
  { header: '开单人', width: 10, key: 'openedByName' },
  { header: '下单时间', width: 20, key: 'saleOrderDatetime', map: (row) => fmtDateTime(value(row, 'saleOrderDatetime') as string | Date | null) },
  { header: '业绩归属日期', width: 14, key: 'performanceAttributionDate', map: (row) => fmtDate(value(row, 'performanceAttributionDate') as string | Date | null) },
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '备注', width: 24, key: 'remark' },
])

/**
 * 回款明细导出列（一行 = 一笔款项 × 一个商品子项）。
 *
 * 前 34 列的表头与顺序**逐字等于** orderColumns，使回款块可直接粘贴到订单明细导出下方
 * 合成一张表按品项/顾客求和（2026-09-05 需求沟通会决议）。因此：
 * - 款项专属列一律追加在尾部，**禁止往对齐段中间插列**；
 * - 对齐段的 5 个金额列必须与 orderColumns 一样走默认 text()（文本单元格），
 *   改成 numberOrEmpty 会让上下两段单元格类型不同，Excel 求和漏掉一段。
 * registry-aggregation.test.ts 有列顺序守卫用例，改动 orderColumns 时会一并失败。
 */
const paymentColumns = mapColumns([
  // ── 对齐段：与 orderColumns 逐列同名同序 ──
  { header: '市场', width: 12, key: 'marketName' },
  { header: '门店', width: 16, key: 'storeName' },
  { header: '订单号', width: 22, key: 'saleOrderId' },
  { header: '类型', width: 10, key: 'saleOrderType' },
  { header: '单据类型', width: 10, key: 'documentType' },
  { header: '顾客', width: 12, key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'clientPhone' },
  { header: '顾客来源', width: 12, key: 'customerSource' },
  { header: '推荐人', width: 12, key: 'promoterEmployeeName' },
  { header: '商品类型', width: 10, key: 'productType' },
  { header: '品质(一级)', width: 14, key: 'categoryL1' },
  { header: '品质(二级)', width: 14, key: 'categoryL2' },
  { header: '商品明细', width: 28, key: 'productName' },
  { header: '总数量', width: 8, key: 'sessionCount', map: (row) => cellOr(value(row, 'sessionCount'), '—') },
  { header: '单位', width: 8, key: 'unit' },
  { header: '可用数量', width: 10, key: 'paidUnusedSessions', map: (row) => cellOr(value(row, 'paidUnusedSessions'), '—') },
  { header: '订单金额', width: 10, key: 'totalAmount' },
  { header: '储值卡抵扣', width: 10, key: 'prepaidCardAmount' },
  { header: '现付', width: 10, key: 'cashAmount' },
  { header: '实付', width: 10, key: 'received' },
  { header: '已退', width: 10, key: 'refundedAmount' },
  { header: '单价', width: 10, key: 'unitRealPrice', map: (row) => numberOrEmpty(row, 'unitRealPrice') },
  { header: '状态', width: 10, key: 'status' },
  { header: '支付方式', width: 12, key: 'paymentMethod', map: (row) => paymentMethodMap[String(value(row, 'paymentMethod') ?? '')] ?? text(row, 'paymentMethod') },
  { header: '是否纳客', width: 8, key: 'isMembershipUpgrade', map: (row) => boolLabel(row, 'isMembershipUpgrade') },
  { header: '是否活动', width: 8, key: 'isActivity', map: (row) => boolLabel(row, 'isActivity') },
  { header: '是否体验转换', width: 12, key: 'isExperienceConversion', map: (row) => boolLabel(row, 'isExperienceConversion') },
  { header: '经营类型', width: 10, key: 'salesCategory' },
  { header: '顾客类型', width: 10, key: 'customerType', map: (row) => cellOr(value(row, 'customerType'), '未注册') },
  { header: '开单人', width: 10, key: 'openedByName' },
  { header: '下单时间', width: 20, key: 'saleOrderDatetime', map: (row) => fmtDateTime(value(row, 'saleOrderDatetime') as string | Date | null) },
  // 回款行取「款项归属日期」，订单行取订单归属日期：两段粘一起后按这一列 group 即为正确的业绩月份
  { header: '业绩归属日期', width: 14, key: 'performanceAttributionDate', map: (row) => fmtDate(value(row, 'performanceAttributionDate') as string | Date | null) },
  // ⚠ 同样是双语义列，但与上一列不同：这一列**不适合**跨两段分组。回款行取
  // sale_order_payments.created_at（款项建单时间），订单明细行取 sale_orders.created_at
  // （订单建单时间）；按它统计「当天新建单据」会把回款行错归到款项发生那天。
  // 表头不能改名——规范要求前 34 列与订单明细导出逐字一致（admin.pr.spec.md §回款明细导出）。
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '备注', width: 24, key: 'remark' },
  // ── 款项专属段：只能追加，不能插进上面 ──
  { header: '款项流水号', width: 14, key: 'paymentId', map: (row) => `#${text(row, 'paymentId')}` },
  { header: '款项类型', width: 12, key: 'changeType' },
  { header: '款项状态', width: 10, key: 'paymentStatus' },
  { header: '款项金额', width: 12, key: 'paymentAmount', map: (row) => numberOrEmpty(row, 'paymentAmount') },
  { header: '来源端', width: 10, key: 'sourceEnd' },
  { header: '操作人', width: 12, key: 'operatorName' },
  { header: '交易号', width: 24, key: 'externalTxnId' },
  { header: '款项发生时间', width: 20, key: 'paidAt', map: (row) => fmtDateTime(value(row, 'paidAt') as string | Date | null) },
  { header: '归属状态', width: 12, key: 'performanceAttributionStatus' },
  { header: '归属调整人', width: 12, key: 'performanceAttributionAdjustedByName' },
  { header: '归属调整时间', width: 20, key: 'performanceAttributionAdjustedAt', map: (row) => fmtDateTime(value(row, 'performanceAttributionAdjustedAt') as string | Date | null) },
  { header: '退款原因', width: 28, key: 'refundReason' },
  { header: '款项备注', width: 32, key: 'note' },
])

const refundColumns = mapColumns([
  { header: '退款单号', width: 14, key: 'refundPaymentId', map: (row) => `#${text(row, 'refundPaymentId')}` },
  { header: '关联原单', width: 22, key: 'refSaleOrderId' },
  { header: '市场', width: 12, key: 'marketName' },
  { header: '门店', width: 16, key: 'storeName' },
  { header: '顾客', width: 12, key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'clientPhone' },
  { header: '退款金额', width: 12, key: 'amount', map: (row) => {
    const amount = Number(value(row, 'amount'))
    return Number.isFinite(amount) ? -Math.abs(amount) : ''
  } },
  { header: '状态', width: 10, key: 'status', map: (row) => {
    const status = text(row, 'status')
    return status === '已支付' ? '已通过' : status === '已作废' ? '已驳回' : status
  } },
  { header: '原因', width: 32, key: 'refundReason' },
  { header: '退款方式', width: 12, key: 'paymentMethod', map: (row) => {
    const method = String(value(row, 'paymentMethod') ?? '')
    return paymentMethodMap[method] ?? method
  } },
  { header: '发起人', width: 12, key: 'operatorName' },
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '审批人', width: 12, key: 'auditorName' },
  { header: '审批时间', width: 20, key: 'auditAt', map: (row) => fmtDateTime(value(row, 'auditAt') as string | Date | null) },
  { header: '审批备注', width: 28, key: 'auditRemark' },
])

const allocationSalesColumns = mapColumns([
  { header: '市场', width: 12, key: 'market' },
  { header: '门店', width: 18, key: 'storeName' },
  { header: '订单号', width: 22, key: 'saleOrderId' },
  { header: '销售单类型', width: 12, key: 'saleOrderType' },
  { header: '单据类型', width: 10, key: 'documentType' },
  { header: '顾客', key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'customerPhone' },
  { header: '顾客来源', width: 12, key: 'customerSource' },
  { header: '推荐人', width: 12, key: 'promoterEmployeeName' },
  { header: '商品类型', width: 12, key: 'productType' },
  { header: '一级分类', width: 14, key: 'categoryL1' },
  { header: '商品大类', width: 12, key: 'categoryL2' },
  { header: '商品名称', width: 24, key: 'productName' },
  { header: '总数量', width: 8, key: 'sessionCount' },
  { header: '单位', width: 8, key: 'unit' },
  { header: '可用数量', width: 8, key: 'paidUnusedSessions' },
  { header: '订单金额', width: 12, key: 'saleAmount' },
  { header: '储值卡抵扣', width: 12, key: 'prepaidCardAmount' },
  { header: '实收', width: 12, key: 'received' },
  { header: '已退款', width: 10, key: 'refundedAmount' },
  { header: '单价', width: 12, key: 'unitRealPrice' },
  { header: '状态', width: 12, key: 'status' },
  { header: '分配状态', width: 10, key: 'allocationStatus' },
  { header: '员工姓名', key: 'employeeName' },
  { header: '职位', width: 12, key: 'positionName' },
  { header: '分配占比', width: 10, key: 'allocationRatio', map: (row) => percent(value(row, 'allocationRatio')) },
  { header: '分配金额', width: 12, key: 'allocationAmount' },
  { header: '提成比例', width: 10, key: 'commissionRate', map: (row) => percent(value(row, 'commissionRate')) },
  { header: '提成金额', width: 12, key: 'commissionAmount' },
  { header: '是否活动', width: 10, key: 'isActivity', map: (row) => boolLabel(row, 'isActivity') },
  { header: '是否纳客', width: 10, key: 'isMembershipUpgrade', map: (row) => boolLabel(row, 'isMembershipUpgrade') },
  { header: '销售分类', width: 12, key: 'salesCategory' },
  { header: '顾客类型', width: 12, key: 'customerType' },
  { header: '开单人', key: 'openedByName' },
  { header: '支付时间', width: 20, key: 'paidAt', map: (row) => fmtDateTime(value(row, 'paidAt') as string | Date | null) },
  { header: '回款归属日期', width: 14, key: 'performanceAttributionDate', map: (row) => fmtDate(value(row, 'performanceAttributionDate') as string | Date | null) },
  { header: '备注', width: 20, key: 'remark' },
])

const serviceColumns = mapColumns([
  { header: '市场', width: 12, key: 'market' },
  { header: '门店', width: 18, key: 'storeName' },
  { header: '服务单号', width: 22, key: 'serviceOrderId' },
  { header: '订单类型', width: 12, key: 'saleOrderType' },
  { header: '单据类型', width: 12, key: 'serviceOrderType' },
  { header: '顾客', key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'customerPhone' },
  { header: '商品类型', width: 12, key: 'productType' },
  { header: '品项（一级）', width: 14, key: 'categoryL1' },
  { header: '品项（二级）', width: 12, key: 'categoryL2' },
  { header: '商品明细', width: 24, key: 'productName' },
  { header: '消耗数量', width: 10, key: 'sessionUsed', map: (row) => numberOrEmpty(row, 'sessionUsed') },
  { header: '项目消耗金额', width: 12, key: 'consumeMoney' },
  { header: '单位价', width: 12, key: 'unitRealPrice' },
  { header: '状态', width: 12, key: 'status' },
  { header: '经营类型', width: 12, key: 'salesCategory' },
  { header: '顾客类型', width: 12, key: 'customerType' },
  { header: '顾客评价', width: 24, key: 'reviewComment' },
  { header: '顾客评分', width: 8, key: 'rating' },
  { header: '开单人', key: 'openedByName' },
  { header: '来源订单号', width: 22, key: 'sourceSaleOrderId' },
  { header: '服务日期', width: 14, key: 'serviceDate', map: (row) => fmtDate(value(row, 'serviceDate') as string | Date | null) },
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '备注', width: 20, key: 'remark' },
])

// 服务提成表的列比服务单消耗明细多出分配/提成和评价上下文；显式定义以避免列名变化影响历史任务。
const serviceCommissionColumns = mapColumns([
  { header: '市场', width: 12, key: 'market' },
  { header: '门店', width: 18, key: 'storeName' },
  { header: '服务单号', width: 22, key: 'serviceOrderId' },
  { header: '订单类型', width: 12, key: 'saleOrderType' },
  { header: '单据类型', width: 12, key: 'serviceOrderType' },
  { header: '顾客', key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'customerPhone' },
  { header: '商品类型', width: 12, key: 'productType' },
  { header: '品项（一级）', width: 14, key: 'categoryL1' },
  { header: '品项（二级）', width: 12, key: 'categoryL2' },
  { header: '商品明细', width: 24, key: 'productName' },
  { header: '消耗数量', width: 10, key: 'sessionUsed' },
  { header: '单位', width: 8, key: 'unit' },
  { header: '消耗金额', width: 12, key: 'consumeMoney' },
  { header: '单价', width: 12, key: 'unitRealPrice' },
  { header: '状态', width: 12, key: 'status' },
  { header: '负责美容师', key: 'employeeName' },
  { header: '员工职位', width: 12, key: 'positionName' },
  { header: '分配占比', width: 10, key: 'allocationRatio', map: (row) => percent(value(row, 'allocationRatio')) },
  { header: '分配额', width: 12, key: 'allocationAmount' },
  { header: '提成比例', width: 10, key: 'commissionRate', map: (row) => percent(value(row, 'commissionRate')) },
  { header: '提成金额', width: 12, key: 'commissionAmount' },
  { header: '顾客评价', width: 24, key: 'reviewComment' },
  { header: '顾客评分', width: 8, key: 'rating' },
  { header: '经营类型', width: 12, key: 'salesCategory' },
  { header: '顾客类型', width: 12, key: 'customerType' },
  { header: '开单人', key: 'openedByName' },
  { header: '来源订单号', width: 22, key: 'sourceSaleOrderId' },
  { header: '服务日期', width: 14, key: 'serviceDate', map: (row) => fmtDate(value(row, 'serviceDate') as string | Date | null) },
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '备注', width: 20, key: 'remark' },
])

/**
 * 日期列一律在此处挂 `map: fmtDate`，即使 action 侧已经格式化过。
 * fmtDate 对 `YYYY-MM-DD` 幂等（无 `T` 直接 slice），重复调用无副作用；
 * 而列侧不挂 map 时回落的 `text()` 是裸 `String(item)` —— 一旦上游换成 Date 或
 * 去掉 action 侧格式化，就会把 `Wed Jan 14 2026 ... GMT+0000` 整串写进单元格，
 * 且 tsc 和单测都不会红（列签名是 `Record<string, unknown>`，类型护栏到此为止）。
 * ⚠️ 别改用 fmtDateTime 做这种双保险 —— 它不幂等，两侧都做会偏 8 小时。
 */
const customerColumns = mapColumns([
  { header: '姓名', width: 14, key: 'name' },
  { header: '手机号', width: 14, key: 'phone' },
  { header: '归属门店', width: 18, key: 'storeName' },
  { header: '顾客类型', width: 10, key: 'customerType' },
  { header: '会员等级', width: 10, key: 'memberLevel' },
  { header: '消费档位', width: 10, key: 'spendingTier' },
  { header: '到店状态', width: 14, key: 'customerStatus' },
  { header: '所属美容师', width: 14, key: 'employeeName' },
  { header: '累计消费', width: 14, key: 'totalSpend' },
  { header: '推荐人', width: 14, key: 'promoterName' },
  { header: '顾客来源', width: 14, key: 'customerSource' },
  { header: '生日', width: 14, key: 'birthday', map: (row) => fmtDate(value(row, 'birthday') as string | Date | null) },
  // 「建档日期」而非「注册日期」：created_at 是本系统建档时刻，data-center 的「注册」指的是
  // became_member_at（会员注册），两个「注册」不是一件事，同名会让甲方拿两张表对不上数。
  // 老顾客普遍 2026 年才录入本系统，所以「建档日期」晚于「成为会员日期」是正常的（非倒挂 bug）。
  { header: '建档日期', width: 14, key: 'createdAt', map: (row) => fmtDate(value(row, 'createdAt') as string | Date | null) },
  { header: '成为会员日期', width: 16, key: 'becameMemberAt', map: (row) => fmtDate(value(row, 'becameMemberAt') as string | Date | null) },
])

/**
 * 「入职日期」插在「职位」之后（雇佣信息聚在一起），因此「生日」及其后 5 列相对
 * #183 之前的导出文件整体右移一列 —— 按列位置引用旧文件的 Excel 公式会错位。
 * 后续再加列请一律追加到末尾，不要再中插。
 */
const employeeColumns = mapColumns([
  { header: '员工编号', width: 16, key: 'employeeId' },
  { header: '姓名', key: 'name' },
  { header: '性别', width: 8, key: 'gender' },
  { header: '手机号', width: 14, key: 'phone' },
  { header: '身份证(后4位)', width: 14, key: 'idCard', map: (row) => maskIdCard(value(row, 'idCard')) },
  { header: '所属组织', width: 18, key: 'orgPath' },
  { header: '所属门店', width: 18, key: 'storeName' },
  { header: '职位', key: 'positionName' },
  { header: '入职日期', width: 14, key: 'hiredAt', map: (row) => fmtDate(value(row, 'hiredAt') as string | Date | null) },
  { header: '生日', width: 14, key: 'birthday', map: (row) => fmtDate(value(row, 'birthday') as string | Date | null) },
  { header: '技能', width: 24, key: 'skills' },
  { header: '社保', width: 8, key: 'socialInsurance', map: (row) => boolLabel(row, 'socialInsurance') },
  { header: '在职状态', width: 10, key: 'isResigned', map: (row) => value(row, 'isResigned') ? '已离职' : '在职' },
  { header: '离职原因', width: 24, key: 'resignationReason' },
])

const pointColumns = mapColumns([
  { header: '时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '顾客', key: 'customerName' },
  { header: '顾客手机', width: 14, key: 'customerPhone' },
  { header: '会员等级', width: 10, key: 'memberLevel' },
  { header: '归属门店', width: 18, key: 'storeName' },
  { header: '类型', width: 14, key: 'type' },
  { header: '变动积分', key: 'amount' },
  { header: '关联订单', width: 22, key: 'refOrderId' },
])

const cardColumns = mapColumns([
  { header: '顾客', width: 14, key: 'clientName' },
  { header: '手机号', width: 14, key: 'clientPhone' },
  { header: '一级品项', width: 14, key: 'categoryL1' },
  { header: '二级品项', width: 14, key: 'categoryL2' },
  { header: '商品/规格', width: 28, key: 'productSpec' },
  { header: '类型', key: 'cardType' },
  { header: '剩余', key: 'remaining', map: (row) => numberOrEmpty(row, 'remaining') },
  { header: '已付', key: 'paidSessions', map: (row) => numberOrEmpty(row, 'paidSessions') },
  { header: '总量', key: 'totalSessions', map: (row) => numberOrEmpty(row, 'totalSessions') },
  { header: '剩余零头', width: 12, key: 'remainingRemainder', map: (row) => numberOrEmpty(row, 'remainingRemainder') },
  { header: '单位标价', key: 'unitPrice' },
  { header: '单位优惠后价', width: 14, key: 'unitRealPrice' },
  { header: '行应付总额', width: 12, key: 'saleAmount' },
  { header: '行实收', key: 'received' },
  { header: '购买门店', width: 18, key: 'storeDisplay' },
  { header: '开单时间', width: 20, key: 'saleOrderDatetime', map: (row) => fmtDateTime(value(row, 'saleOrderDatetime') as string | Date | null) },
  { header: '订单号', width: 22, key: 'saleOrderId' },
  { header: '订单状态', key: 'orderStatus' },
  { header: '付款时间', width: 20, key: 'paidAt', map: (row) => fmtDateTime(value(row, 'paidAt') as string | Date | null) },
])

const inventoryColumns = (canViewPrice: boolean) => mapColumns([
  { header: '库存主体类型', width: 12, key: 'locationType' },
  { header: '库存主体', width: 20, key: 'locationName', map: (row) => String(value(row, 'locationName') ?? value(row, 'locationId') ?? '') },
  { header: 'SKU', width: 24, key: 'skuId' },
  { header: '产品', width: 36, key: 'skuName' },
  { header: '规格', width: 16, key: 'specName' },
  { header: '供应商', width: 20, key: 'supplier' },
  { header: '产品系列', width: 16, key: 'productSeries' },
  { header: '批号', width: 16, key: 'batchNo' },
  { header: '有效期', width: 14, key: 'expiryDate' },
  { header: '赠品', width: 10, key: 'isGift', map: (row) => boolLabel(row, 'isGift') },
  { header: '库存数量', width: 12, key: 'quantityOnHand', map: (row) => numberOrEmpty(row, 'quantityOnHand') },
  ...(canViewPrice
    ? [
        { header: '供应链单位成本', width: 14, key: 'supplyChainUnitCost', map: (row: Row) => numberOrEmpty(row, 'supplyChainUnitCost') },
        { header: '市场实际单价', width: 14, key: 'marketActualUnitPrice', map: (row: Row) => numberOrEmpty(row, 'marketActualUnitPrice') },
        { header: '门店实际单价', width: 14, key: 'storeActualUnitPrice', map: (row: Row) => numberOrEmpty(row, 'storeActualUnitPrice') },
      ]
    : []),
  { header: '备注', width: 24, key: 'remark' },
  { header: '更新时间', width: 20, key: 'updatedAt', map: (row) => fmtDateTime(value(row, 'updatedAt') as string | Date | null) },
])

function breakdownContent(
  view: DataCenterExportPayload['view'],
  rows: BreakdownRow[],
): ExportContent {
  const config = getDataCenterBreakdownConfig(view)
  const columns: WorkerExportColumn<Row>[] = [
    { header: config.groupLabel, width: 18, value: (row) => text(row, 'groupName') },
  ]
  for (const textColumn of config.textColumns) {
    columns.push({
      header: textColumn.label,
      width: textColumn.source === 'marketName' ? 16 : 14,
      value: (row) => textColumn.source === 'marketName'
        ? text(row, 'marketName')
        : String((value(row, 'labels') as Record<string, string> | undefined)?.[textColumn.key] ?? ''),
    })
  }
  for (const definition of config.metricColumns) {
    columns.push({
      header: headerWithUnit(definition.label, definition.unit),
      value: (row) => metricCell((value(row, 'metrics') as Record<string, number | null> | undefined)?.[definition.key], definition.unit),
    })
  }
  return {
    sheetName: exportJobLabel('data-center', { view, params: {} }).replace(/.*-/, '').slice(0, 31),
    columns,
    rows: fromRows(rows as unknown as Row[]),
  }
}

function rankingContent(
  rows: RankingRow[],
  metric: DataCenterMetricColumn,
): ExportContent {
  const columns: WorkerExportColumn<Row>[] = [
    { header: '排名', width: 8, value: (row) => numberOrEmpty(row, 'rank') },
    { header: '名称', width: 20, value: (row) => text(row, 'name') },
    { header: '所属市场', width: 16, value: (row) => text(row, 'marketName') },
    { header: headerWithUnit(metric.label, metric.unit), value: (row) => metricCell(value(row, 'value') as number | null, metric.unit) },
  ]
  return {
    sheetName: metric.label,
    columns,
    rows: fromRows(rows as unknown as Row[]),
  }
}

async function queryDataCenter(
  payload: DataCenterExportPayload,
): Promise<ExportContent> {
  const raw = payload.params
  const base = parseBoardParams(raw)
  const view = payload.view
  if (view.startsWith('sales-')) {
    const board = await getSalesBoard(base)
    const rows = view === 'sales-market' ? board.byMarket : board.byStore
    return breakdownContent(view, rows)
  }
  if (view.startsWith('customer-')) {
    const board = await getCustomerBoard(base)
    const rows = view.endsWith('-reg')
      ? (view.startsWith('customer-market') ? board.byMarket : board.byStore)
      : (view.startsWith('customer-market') ? board.byMarket : board.byStore)
    return breakdownContent(view, rows)
  }
  if (view.startsWith('product-')) {
    const board = await getProductBoard({
      ...base,
      productKind: raw.kind || undefined,
      categoryName: raw.category || undefined,
    })
    const rows = view === 'product-market' ? board.byMarket : board.byStore
    return breakdownContent(view, rows)
  }

  const board = await getEfficiencyBoard(base)
  if (view === 'efficiency-market') return breakdownContent(view, board.byMarket)
  if (view === 'efficiency-staff') return breakdownContent(view, board.byStaff)
  const config = getDataCenterRankingConfig(view)
  const metric = config.metrics.find((item) => item.key === payload.metric)
  if (!metric) throw new Error('INVALID_PARAMS: 排名指标无效')
  const source = view === 'efficiency-store-ranking' ? board.storeRankings : board.staffRankings
  return rankingContent(source[metric.key] ?? [], metric)
}

function queryProducts(payload: Record<string, string>): ExportContent {
  return {
    sheetName: '商品',
    columns: mapColumns([
      { header: '商品名称', width: 28, key: 'specName' },
      { header: '品项分类', width: 20, key: 'categoryName', map: (row) => [value(row, 'productKind'), value(row, 'categoryName')].filter(Boolean).join(' / ') },
      { header: '产品类型', key: 'productType' },
      { header: '是否生美', key: 'isShengmei', map: (row) => value(row, 'isShengmei') == null ? '' : boolLabel(row, 'isShengmei') },
      { header: '经营类型', key: 'salesCategory' },
      { header: '项目系列', key: 'projectSeriesName' },
      { header: '标价', key: 'price', map: (row) => numberOrEmpty(row, 'price') },
      { header: '会员价', key: 'specialPrice', map: (row) => numberOrEmpty(row, 'specialPrice') },
      { header: '数量', key: 'sessionCount', map: (row) => value(row, 'sessionCount') == null ? '' : `${value(row, 'sessionCount')} ${text(row, 'unit')}` },
      { header: '单位', key: 'unit' },
      { header: '限购次数', key: 'purchaseLimit' },
      { header: '手工费', key: 'serviceFee', map: (row) => numberOrEmpty(row, 'serviceFee') },
      { header: '状态', width: 10, key: 'isEnabled', map: (row) => value(row, 'isEnabled') ? '启用' : '停用' },
    ]),
    rows: pagedRows((options: ExportBatchOptions<number>) => exportProductSkus(payload, options)),
  }
}

function queryMallProducts(payload: Record<string, string>): ExportContent {
  return {
    sheetName: '商城商品',
    columns: mapColumns([
      { header: '商品编号', width: 20, key: 'productId' },
      { header: '商品名称', width: 28, key: 'name' },
      { header: '商城分类', width: 24, key: 'categoryName', map: (row) => [value(row, 'categoryGroup'), value(row, 'categoryName')].filter(Boolean).join(' / ') },
      { header: '商品类型', width: 12, key: 'isBundle', map: (row) => value(row, 'isBundle') ? '套餐' : '普通商品' },
      { header: '标价', key: 'price', map: (row) => numberOrEmpty(row, 'price') },
      { header: '会员价', key: 'specialPrice', map: (row) => numberOrEmpty(row, 'specialPrice') },
      { header: '展示状态', width: 12, key: 'isVisible', map: (row) => value(row, 'isVisible') ? '展示中' : '未展示' },
      { header: '规格数', key: 'skuCount', map: (row) => numberOrEmpty(row, 'skuCount') },
      { header: '排序', key: 'sortOrder', map: (row) => numberOrEmpty(row, 'sortOrder') },
      { header: '描述', width: 32, key: 'description' },
      { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
      { header: '更新时间', width: 20, key: 'updatedAt', map: (row) => fmtDateTime(value(row, 'updatedAt') as string | Date | null) },
    ]),
    rows: pagedRows((options: ExportBatchOptions<number>) => exportMallProducts(payload, options)),
  }
}

async function queryCoupons(payload: Record<string, string>): Promise<ExportContent> {
  const markets = await getMarkets()
  const marketMap = new Map(markets.map((market) => [market.id, market.name]))
  return {
    sheetName: '优惠券',
    columns: mapColumns([
      { header: '券名称', width: 24, key: 'name' },
      { header: '券类型', width: 10, key: 'couponType' },
      { header: '面值/折扣', key: 'discountValue', map: (row) => value(row, 'couponType') === '折扣券' ? `${(Number(value(row, 'discountValue')) * 10).toFixed(1)}折` : formatCurrency(value(row, 'discountValue') as string | number | null) },
      { header: '使用条件', width: 16, key: 'minSpend', map: (row) => Number(value(row, 'minSpend')) > 0 ? `满${formatCurrency(value(row, 'minSpend') as string | number)}可用` : '无门槛' },
      { header: '适用市场', width: 20, key: 'applicableMarketIds', map: (row) => {
        const ids = value(row, 'applicableMarketIds') as string[] | null | undefined
        return !ids?.length ? '全部市场' : ids.map((id) => marketMap.get(id) ?? id).join('、')
      } },
      { header: '有效期', width: 24, key: 'validityMode', map: (row) => value(row, 'validityMode') === 'days' && value(row, 'validDays') ? `领取后${value(row, 'validDays')}天` : value(row, 'validFrom') && value(row, 'validTo') ? `${fmtDate(value(row, 'validFrom') as string | Date)} ~ ${fmtDate(value(row, 'validTo') as string | Date)}` : '—' },
      { header: '已发', key: 'issuedCount' },
      { header: '总量', key: 'totalCount', map: (row) => value(row, 'couponType') === '折扣券' ? '' : cellOr(value(row, 'totalCount'), '不限') },
      { header: '状态', width: 10, key: 'isActive', map: (row) => value(row, 'isActive') ? '启用' : '停用' },
      { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
      { header: '描述', width: 30, key: 'description' },
    ]),
    rows: pagedRows((options: ExportBatchOptions<number>) => exportCouponTemplates(payload, options)),
  }
}

export async function createExportContent(
  exportType: ExportJobType,
  payload: ExportJobPayload,
): Promise<ExportContent> {
  if (exportType === 'data-center') return queryDataCenter(payload as DataCenterExportPayload)
  const params = payload as Record<string, string>
  switch (exportType) {
    case 'orders':
      return {
        sheetName: '订单',
        columns: orderColumns,
        rows: aggregateContiguousExportRows(
          pagedRows((options: ExportBatchOptions<ExportOrdersCursor>) => exportOrders(params, options)),
          (row) => String(row.saleOrderId ?? row.__sourceId ?? ''),
          aggregateOrderExportRows,
        ),
      }
    case 'payments':
      return {
        sheetName: '回款明细',
        columns: paymentColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportOrderPayments(params, options)),
      }
    case 'refunds':
      return {
        sheetName: '退款明细',
        columns: refundColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportRefunds(params, options)),
      }
    case 'allocation-sales':
      return {
        sheetName: '销售提成',
        columns: allocationSalesColumns,
        rows: aggregateContiguousExportRows(
          pagedRows((options: ExportBatchOptions<ExportAllocationOrdersCursor>) => exportAllocationOrders(params, options)),
          (row) => String(row.__salePaymentId ?? row.__sourceId ?? ''),
          aggregateAllocationExportRows,
        ),
      }
    case 'allocation-services':
      return {
        sheetName: '服务提成',
        columns: serviceCommissionColumns,
        rows: pagedRows((options: ExportBatchOptions<ExportAllocationServiceCursor>) => exportAllocationServiceOrders(params, options)),
      }
    case 'services':
      return {
        sheetName: '服务单消耗',
        columns: serviceColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportServiceOrders(params, options)),
      }
    case 'customers':
      return {
        sheetName: '顾客',
        columns: customerColumns,
        rows: pagedRows((options: ExportBatchOptions<string>) => exportCustomers(params, options)),
      }
    case 'employees': {
      const nodes = await db.select().from(orgNodes)
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const rows = (async function* (): AsyncIterable<Row> {
        for await (const source of pagedRows((options: ExportBatchOptions<string>) => exportEmployees(params, options))) {
          const path: string[] = []
          let current = source.orgNodeId as string | null | undefined
          const seen = new Set<string>()
          while (current && !seen.has(current)) {
            seen.add(current)
            const node = nodeMap.get(current)
            if (!node) break
            path.unshift(node.name)
            current = node.parentId
          }
          yield { ...source, orgPath: path.join(' / ') }
        }
      })()
      return { sheetName: '员工', columns: employeeColumns, rows }
    }
    case 'points':
      return {
        sheetName: '积分流水',
        columns: pointColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportPointTransactions(params, options)),
      }
    case 'cards':
      return {
        sheetName: '疗程卡',
        columns: cardColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportCards(params, options)),
    }
    case 'inventory-stocks': {
      const firstPage = await exportInventoryLots(params, { limit: EXPORT_WORKER_BATCH_SIZE })
      return {
        sheetName: '库存批次',
        columns: inventoryColumns(firstPage.canViewPrice),
        rows: pagedRows((options: ExportBatchOptions<number>) => exportInventoryLots(params, options), firstPage),
      }
    }
    case 'products':
      return queryProducts(params)
    case 'mall-products':
      return queryMallProducts(params)
    case 'coupons':
      return queryCoupons(params)
  }
}
