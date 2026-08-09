import { db } from '@/db'
import { orgNodes } from '@db/org'
import { exportProductSkus } from '@/actions/products'
import { exportCouponTemplates, getMarkets } from '@/actions/coupons'
import {
  exportOrders,
  exportAllocationOrders,
  type ExportAllocationOrdersCursor,
  type ExportOrdersCursor,
} from '@/actions/orders'
import {
  exportServiceOrders,
  exportAllocationServiceOrders,
  type ExportAllocationServiceCursor,
} from '@/actions/services'
import { exportCustomers } from '@/actions/customers'
import { exportEmployees } from '@/actions/employees'
import { exportPointTransactions } from '@/actions/points'
import { exportCards } from '@/actions/cards'
import { exportInventoryStocks } from '@/actions/inventory-v2'
import { getSalesBoard } from '@/actions/data-center/sales'
import { getCustomerBoard } from '@/actions/data-center/customer'
import { getProductBoard } from '@/actions/data-center/product'
import { getEfficiencyBoard } from '@/actions/data-center/efficiency'
import { parseBoardParams } from '@/lib/data-center/params'
import { headerWithUnit, metricCell } from '@/lib/data-center/export'
import type { BreakdownRow, MetricUnit, RankingRow } from '@/lib/data-center/types'
import { fmtDate, fmtDateTime } from '@/lib/datetime'
import { formatCurrency } from '@/lib/utils'
import {
  EXPORT_WORKER_BATCH_SIZE,
  iterateExportPages,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import {
  exportJobLabel,
  type DataCenterExportPayload,
  type ExportJobPayload,
  type ExportJobType,
} from '@/lib/export-job-types'
import type { WorkerExportColumn, ExportCell } from './xlsx-writer'

export interface ExportContent {
  fileNameBase: string
  sheetName: string
  columns: WorkerExportColumn<Record<string, unknown>>[]
  rows: AsyncIterable<Record<string, unknown>>
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
  { header: '经营类型', width: 10, key: 'salesCategory' },
  { header: '顾客类型', width: 10, key: 'customerType', map: (row) => cellOr(value(row, 'customerType'), '未注册') },
  { header: '开单人', width: 10, key: 'openedByName' },
  { header: '下单时间', width: 20, key: 'saleOrderDatetime', map: (row) => fmtDateTime(value(row, 'saleOrderDatetime') as string | Date | null) },
  { header: '创建时间', width: 20, key: 'createdAt', map: (row) => fmtDateTime(value(row, 'createdAt') as string | Date | null) },
  { header: '备注', width: 24, key: 'remark' },
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
  { header: '消耗数量', width: 10, key: 'sessionUsed', map: (row) => value(row, 'sessionUsed') == null ? '' : `${value(row, 'sessionUsed')} ${text(row, 'unit')}` },
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
  { header: '生日', width: 14, key: 'birthday' },
])

const employeeColumns = mapColumns([
  { header: '员工编号', width: 16, key: 'employeeId' },
  { header: '姓名', key: 'name' },
  { header: '性别', width: 8, key: 'gender' },
  { header: '手机号', width: 14, key: 'phone' },
  { header: '身份证(后4位)', width: 14, key: 'idCard', map: (row) => maskIdCard(value(row, 'idCard')) },
  { header: '所属组织', width: 18, key: 'orgPath' },
  { header: '所属门店', width: 18, key: 'storeName' },
  { header: '职位', key: 'positionName' },
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
  { header: '剩余/总量', width: 12, key: 'remaining', map: (row) => `${value(row, 'remaining')} / ${value(row, 'totalSessions')} ${text(row, 'unit')}` },
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
  { header: '门店', width: 20, key: 'storeName', map: (row) => String(value(row, 'storeName') ?? value(row, 'storeId') ?? '') },
  { header: 'SKU', width: 24, key: 'skuId' },
  { header: '产品', width: 36, key: 'skuName' },
  { header: '产品类型', width: 12, key: 'productType' },
  { header: '批号', width: 16, key: 'batchNo' },
  { header: '效期', width: 14, key: 'expiryDate' },
  { header: '库存数量', width: 12, key: 'quantityOnHand' },
  ...(canViewPrice
    ? [
        { header: '最近单价', width: 12, key: 'lastUnitPrice' },
        { header: '最近金额', width: 12, key: 'lastAmount' },
      ]
    : []),
  { header: '备注', width: 24, key: 'remark' },
])

const dataCenterMetricColumns: Record<string, Array<{ key: string; label: string; unit: MetricUnit }>> = {
  'sales-market': [
    ['storeCount', '门店数', 'count'], ['technicianCount', '技师人数', 'count'],
    ['storeRevenue', '总业绩', 'amount'], ['shengmeiRevenue', '生美业绩', 'amount'],
    ['revenuePerStore', '业绩店均', 'amount'], ['shengmeiRevenuePerStore', '生美店均', 'amount'],
    ['newCustomerRevenue', '新增客业绩', 'amount'], ['trafficCustomerRevenue', '流量客业绩', 'amount'],
    ['storeConsume', '总实耗', 'amount'], ['shengmeiConsume', '生美实耗', 'amount'],
    ['consumePerStore', '实耗店均', 'amount'], ['shengmeiConsumePerStore', '生美实耗店均', 'amount'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'sales-store': [
    ['technicianCount', '技师人数', 'count'], ['storeRevenue', '总业绩', 'amount'],
    ['shengmeiRevenue', '生美业绩', 'amount'], ['newCustomerRevenue', '新增客业绩', 'amount'],
    ['trafficCustomerRevenue', '流量客业绩', 'amount'], ['storeConsume', '总实耗', 'amount'],
    ['shengmeiConsume', '生美实耗', 'amount'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'customer-market-reg': [
    ['registered', '会员注册', 'count'], ['retained', '保有会员', 'count'], ['visitOnce', '回店1次', 'count'],
    ['visitOnceRate', '1次达成率', 'percent'], ['visitTwice', '回店2次', 'count'], ['visitTwiceRate', '2次达成率', 'percent'],
    ['dormant', '沉睡', 'count'], ['reactivatedDormant', '激活沉睡', 'count'], ['frozen', '冰冻', 'count'],
    ['reactivatedFrozen', '激活冰冻', 'count'], ['deep', '休眠', 'count'], ['reactivatedDeep', '激活休眠', 'count'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'customer-market-ops': [
    ['bucketD', '<1990', 'count'], ['bucketC', '≥1990', 'count'], ['bucketB', '≥1万', 'count'], ['bucketA', '≥3万', 'count'],
    ['bucketV', '≥6万', 'count'], ['bucketVIC', '≥10万', 'count'], ['operatedTotal', '被经营总数', 'count'],
    ['newMembers', '会员新增', 'count'], ['trafficCustomers', '流量客', 'count'], ['convRate', '成交率', 'percent'],
    ['memberAvgTicket', '会员客单', 'amount'], ['newCustomerAvgTicket', '新客客单', 'amount'], ['trafficVisits', '流量人次', 'count'],
    ['memberVisits', '会员人次', 'count'], ['projectCount', '项目数', 'count'], ['consumePerVisit', '单次客耗', 'amount'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'product-market': [
    ['cardHolders', '持卡人数', 'count'], ['cardHolderRate', '持卡占比', 'percent'], ['trialCount', '体验人数', 'count'],
    ['newCount', '新增人数', 'count'], ['newRevenue', '新增业绩', 'amount'], ['newAvgTicket', '新增客单价', 'amount'],
    ['repurchaseCount', '复购人数', 'count'], ['repurchaseRevenue', '复购业绩', 'amount'], ['repurchaseRate', '复购率', 'percent'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'product-store': [
    ['cardHolders', '持卡人数', 'count'], ['cardHolderRate', '持卡占比', 'percent'], ['trialCount', '体验人数', 'count'],
    ['newCount', '新增人数', 'count'], ['newRevenue', '新增业绩', 'amount'], ['newAvgTicket', '新增客单价', 'amount'],
    ['repurchaseCount', '复购人数', 'count'], ['repurchaseRevenue', '复购业绩', 'amount'], ['repurchaseRate', '复购率', 'percent'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'efficiency-market': [
    ['managerCount', '店长人数', 'count'], ['managerAvgIncome', '店长人均收入', 'amount'], ['technicianCount', '技师人数', 'count'],
    ['techAvgRevenue', '技师人均业绩', 'amount'], ['techAvgConsume', '技师人均实耗', 'amount'],
    ['techAvgShengmeiConsume', '技师人均生美实耗', 'amount'], ['techAvgIncome', '技师人均收入', 'amount'],
    ['techAvgMembers', '技师人均会员量', 'count'], ['techAvgProjects', '技师人均项目数', 'count'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'efficiency-staff': [
    ['revenue', '当月业绩', 'amount'], ['saleZxzh', '自销自耗', 'amount'], ['saleTxzh', '他销自耗', 'amount'],
    ['saleTxth', '他销他耗', 'amount'], ['saleEco', '生态合作', 'amount'], ['consumeTotal', '实耗合计', 'amount'],
    ['newMember', '纳客数', 'count'], ['projectCount', '项目数', 'count'], ['serviceHeadcount', '服务人头', 'count'],
    ['serviceVisits', '服务人次', 'count'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
}

const rankingMetrics: Record<string, Array<{ key: string; label: string; unit: MetricUnit }>> = {
  'efficiency-store-ranking': [
    ['revenue', '业绩', 'amount'], ['consume', '实耗', 'amount'], ['retainedMember', '保有会员', 'count'],
    ['newMember', '新会员', 'count'], ['projectCount', '项目数', 'count'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
  'efficiency-staff-ranking': [
    ['revenue', '业绩', 'amount'], ['consume', '实耗', 'amount'], ['newMember', '新会员', 'count'],
    ['projectCount', '项目数', 'count'], ['income', '收入', 'amount'],
  ].map(([key, label, unit]) => ({ key, label, unit: unit as MetricUnit })),
}

function breakdownContent(
  view: string,
  rows: BreakdownRow[],
  timeLabel: string,
): ExportContent {
  const definitions = dataCenterMetricColumns[view] ?? []
  const isStore = view.endsWith('-store') || view === 'customer-store-reg' || view === 'customer-store-ops'
  const isStaff = view === 'efficiency-staff'
  const firstLabel = view.includes('customer') ? (isStore ? '门店' : '市场') : isStaff ? '姓名' : isStore ? '门店' : view.includes('efficiency') ? '市场' : view.includes('product') || view.includes('sales') ? (isStore ? '门店' : '市场') : '名称'
  const columns: WorkerExportColumn<Row>[] = [
    { header: firstLabel, width: 18, value: (row) => text(row, 'groupName') },
  ]
  if (isStaff) {
    columns.push(
      { header: '门店', width: 14, value: (row) => String((value(row, 'labels') as Record<string, string> | undefined)?.store ?? '') },
      { header: '职级', width: 14, value: (row) => String((value(row, 'labels') as Record<string, string> | undefined)?.position ?? '') },
    )
  } else if (isStore || view === 'customer-store-reg' || view === 'customer-store-ops') {
    columns.push({ header: '所属市场', width: 16, value: (row) => text(row, 'marketName') })
  }
  for (const definition of definitions) {
    columns.push({
      header: headerWithUnit(definition.label, definition.unit),
      value: (row) => metricCell((value(row, 'metrics') as Record<string, number | null> | undefined)?.[definition.key], definition.unit),
    })
  }
  return {
    fileNameBase: `${exportJobLabel('data-center', { view: view as DataCenterExportPayload['view'], params: {} })}_${timeLabel}`,
    sheetName: exportJobLabel('data-center', { view: view as DataCenterExportPayload['view'], params: {} }).replace(/.*-/, '').slice(0, 31),
    columns,
    rows: fromRows(rows as unknown as Row[]),
  }
}

function rankingContent(
  view: string,
  rows: RankingRow[],
  metric: { key: string; label: string; unit: MetricUnit },
  timeLabel: string,
): ExportContent {
  const columns: WorkerExportColumn<Row>[] = [
    { header: '排名', width: 8, value: (row) => numberOrEmpty(row, 'rank') },
    { header: '名称', width: 20, value: (row) => text(row, 'name') },
    { header: '所属市场', width: 16, value: (row) => text(row, 'marketName') },
    { header: headerWithUnit(metric.label, metric.unit), value: (row) => metricCell(value(row, 'value') as number | null, metric.unit) },
  ]
  const label = exportJobLabel('data-center', { view: view as DataCenterExportPayload['view'], params: {}, metric: metric.key })
  return {
    fileNameBase: `${label}_${metric.label}_${timeLabel}`,
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
    return breakdownContent(view, rows, board.timeRange.presetLabel)
  }
  if (view.startsWith('customer-')) {
    const board = await getCustomerBoard(base)
    const rows = view.endsWith('-reg')
      ? (view.startsWith('customer-market') ? board.byMarket : board.byStore)
      : (view.startsWith('customer-market') ? board.byMarket : board.byStore)
    return breakdownContent(view, rows, board.timeRange.presetLabel)
  }
  if (view.startsWith('product-')) {
    const board = await getProductBoard({
      ...base,
      productKind: raw.kind || undefined,
      categoryName: raw.category || undefined,
    })
    const rows = view === 'product-market' ? board.byMarket : board.byStore
    return breakdownContent(view, rows, board.timeRange.presetLabel)
  }

  const board = await getEfficiencyBoard(base)
  if (view === 'efficiency-market') return breakdownContent(view, board.byMarket, board.timeRange.presetLabel)
  if (view === 'efficiency-staff') return breakdownContent(view, board.byStaff, board.timeRange.presetLabel)
  const metrics = rankingMetrics[view] ?? []
  const metric = metrics.find((item) => item.key === payload.metric)
  if (!metric) throw new Error('INVALID_PARAMS: 排名指标无效')
  const source = view === 'efficiency-store-ranking' ? board.storeRankings : board.staffRankings
  return rankingContent(view, source[metric.key] ?? [], metric, board.timeRange.presetLabel)
}

function queryProducts(payload: Record<string, string>): ExportContent {
  return {
    fileNameBase: '商品',
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

async function queryCoupons(payload: Record<string, string>): Promise<ExportContent> {
  const markets = await getMarkets()
  const marketMap = new Map(markets.map((market) => [market.id, market.name]))
  return {
    fileNameBase: '优惠券',
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
        fileNameBase: '订单',
        sheetName: '订单',
        columns: orderColumns,
        rows: pagedRows((options: ExportBatchOptions<ExportOrdersCursor>) => exportOrders(params, options)),
      }
    case 'allocation-sales':
      return {
        fileNameBase: '营业额分配-销售提成',
        sheetName: '销售提成',
        columns: allocationSalesColumns,
        rows: pagedRows((options: ExportBatchOptions<ExportAllocationOrdersCursor>) => exportAllocationOrders(params, options)),
      }
    case 'allocation-services':
      return {
        fileNameBase: '营业额分配-服务提成',
        sheetName: '服务提成',
        columns: serviceCommissionColumns,
        rows: pagedRows((options: ExportBatchOptions<ExportAllocationServiceCursor>) => exportAllocationServiceOrders(params, options)),
      }
    case 'services':
      return {
        fileNameBase: '服务单-消耗明细',
        sheetName: '服务单消耗',
        columns: serviceColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportServiceOrders(params, options)),
      }
    case 'customers':
      return {
        fileNameBase: '顾客',
        sheetName: '顾客',
        columns: customerColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportCustomers(params, options)),
      }
    case 'employees': {
      const nodes = await db.select().from(orgNodes)
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      const rows = (async function* (): AsyncIterable<Row> {
        for await (const source of pagedRows((options: ExportBatchOptions<number>) => exportEmployees(params, options))) {
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
      return { fileNameBase: '员工', sheetName: '员工', columns: employeeColumns, rows }
    }
    case 'points':
      return {
        fileNameBase: '积分流水',
        sheetName: '积分流水',
        columns: pointColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportPointTransactions(params, options)),
      }
    case 'cards':
      return {
        fileNameBase: '疗程卡',
        sheetName: '疗程卡',
        columns: cardColumns,
        rows: pagedRows((options: ExportBatchOptions<number>) => exportCards(params, options)),
      }
    case 'inventory-stocks': {
      const firstPage = await exportInventoryStocks(params, { limit: EXPORT_WORKER_BATCH_SIZE })
      return {
        fileNameBase: '门店库存',
        sheetName: '门店库存',
        columns: inventoryColumns(firstPage.canViewPrice),
        rows: pagedRows((options: ExportBatchOptions<number>) => exportInventoryStocks(params, options), firstPage),
      }
    }
    case 'products':
      return queryProducts(params)
    case 'coupons':
      return queryCoupons(params)
  }
}
