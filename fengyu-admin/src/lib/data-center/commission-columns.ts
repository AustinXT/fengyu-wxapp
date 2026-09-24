/**
 * 员工提成日报 / 提成明细（#375）的列定义单源：页面（MatrixTable 在此之上补单元格渲染）
 * 与 export-worker（matrix-export.ts 的 toWorkerExportColumns）从同一份列出发，表头 / 分组 / 冻结 / 数值不漂移。
 *
 * 纯常量 + 纯函数，不 import React / DB。
 */
import { listMonthDays, type MatrixTotals } from './matrix'
import type { MatrixExportColumnSpec } from './matrix-export'
import {
  COMMISSION_SOURCE_LABELS,
  cellTotal,
  type CommissionCell,
  type CommissionDailyRow,
  type CommissionDailyTotals,
  type CommissionRowGrain,
  type CommissionSource,
  type CommissionView,
} from './commission-daily'

/** 与 MatrixTable 的 MatrixColumn 同名同义的展示属性（纯数据，页面直接透传） */
interface ColumnPresentation {
  align?: 'left' | 'center' | 'right'
  weekend?: boolean
  hint?: string
}

export type CommissionDailyColumn = MatrixExportColumnSpec<CommissionDailyRow> & ColumnPresentation & {
  /** 该列对应的日期（日期列）；右侧合计列为 'total' */
  day?: string
  /** 该列取的是哪一部分：合计 / 业绩 / 消耗（下钻时据此带提成类型） */
  part?: 'total' | CommissionSource
  /** 左侧文字列的角色，页面据此渲染链接 / 灰显 */
  role?: 'name' | 'position' | 'store' | 'employees'
}

const DAY_WIDTH = 88
const SPLIT_WIDTH = 80
const TOTAL_WIDTH = 112

function partValue(cell: CommissionCell | undefined, part: 'total' | CommissionSource): number {
  if (!cell) return 0
  return part === 'total' ? cellTotal(cell) : cell[part]
}

/** 视图 → 每天取哪几部分 */
function partsOf(view: CommissionView): Array<'total' | CommissionSource> {
  if (view === 'split') return ['sale', 'service']
  if (view === 'sale') return ['sale']
  if (view === 'service') return ['service']
  return ['total']
}

const PART_HEADERS: Record<'total' | CommissionSource, string> = {
  total: '提成',
  sale: COMMISSION_SOURCE_LABELS.sale,
  service: COMMISSION_SOURCE_LABELS.service,
}

/**
 * 日报矩阵列。
 * @param today Asia/Shanghai 今天：晚于今天的日期还没发生，格子留空（「—」）而不是 0；
 *              早于数据起点的日期（如 2026-07-01~07-07）照常显示 0，配合数据起点提示。
 */
export function buildCommissionDailyColumns(input: {
  month: string
  view: CommissionView
  grain: CommissionRowGrain
  today: string
}): CommissionDailyColumn[] {
  const { month, view, grain, today } = input
  const columns: CommissionDailyColumn[] = []

  if (grain === 'position') {
    columns.push(
      { key: 'position', header: '岗位', width: 120, freeze: 'left', role: 'position', exportValue: (row) => row.positionName, exportWidth: 16 },
      {
        key: 'employees', header: '人数', width: 72, freeze: 'left', unit: 'count', role: 'employees',
        value: (row) => row.employeeCount, aggregate: { kind: 'server' },
      },
    )
  } else {
    columns.push(
      { key: 'name', header: '姓名', width: 96, freeze: 'left', role: 'name', exportValue: (row) => row.employeeName, exportWidth: 12 },
      { key: 'position', header: '岗位', width: 96, freeze: 'left', role: 'position', exportValue: (row) => row.positionName, exportWidth: 14 },
      { key: 'store', header: '门店', width: 120, freeze: 'left', role: 'store', exportValue: (row) => row.storeName, exportWidth: 16 },
    )
  }

  const parts = partsOf(view)
  for (const day of listMonthDays(month)) {
    const future = day.date > today
    for (const part of parts) {
      columns.push({
        key: parts.length > 1 ? `d:${day.date}:${part}` : `d:${day.date}`,
        header: parts.length > 1 ? PART_HEADERS[part] : `${day.day}日`,
        group: parts.length > 1 ? { key: `day:${day.date}`, header: `${day.day}日` } : undefined,
        width: parts.length > 1 ? SPLIT_WIDTH : DAY_WIDTH,
        align: 'right',
        weekend: day.weekend,
        day: day.date,
        part,
        value: (row) => (future ? null : partValue(row.days[day.date], part)),
        aggregate: { kind: 'sum' },
        exportWidth: 11,
      })
    }
  }

  for (const part of parts) {
    columns.push({
      key: parts.length > 1 ? `total:${part}` : 'total',
      header: parts.length > 1 ? PART_HEADERS[part] : '本期合计',
      group: parts.length > 1 ? { key: 'total', header: '本期合计' } : undefined,
      width: TOTAL_WIDTH,
      freeze: 'right',
      align: 'right',
      day: 'total',
      part,
      value: (row) => partValue(row.total, part),
      aggregate: { kind: 'sum' },
      exportWidth: 14,
    })
  }
  return columns
}

/**
 * 表尾合计：用列自己的取值函数作用在「合计伪行」上（按日合计 + 总计来自 SQL 的 GROUPING SETS），
 * 页面表尾与导出合计行因此与列定义同源；人数列取去重人数。
 */
export function commissionDailyTotalsMap(
  columns: readonly CommissionDailyColumn[],
  totals: CommissionDailyTotals,
): MatrixTotals {
  const pseudo: CommissionDailyRow = {
    key: '__totals__',
    employeeId: null,
    employeeName: '',
    positionName: '',
    storeId: null,
    storeName: '',
    storeCount: 0,
    employeeCount: totals.employeeCount,
    days: totals.days,
    total: totals.total,
  }
  const map: MatrixTotals = {}
  for (const column of columns) {
    if (!column.value || (column.aggregate?.kind ?? 'none') === 'none') continue
    map[column.key] = column.value(pseudo) ?? null
  }
  return map
}

/** 表尾标签：「合计（N 人）」/ 按岗位「合计（N 个岗位）」 */
export function commissionTotalsLabel(grain: CommissionRowGrain, totals: CommissionDailyTotals): string {
  return grain === 'position' ? `合计（${totals.rowCount} 个岗位）` : `合计（${totals.employeeCount} 人）`
}

// ─── 明细 ────────────────────────────────────────────────────────────────────

export interface CommissionDetailRow {
  /** `${source}:${sourceId}`，行唯一键 */
  key: string
  source: CommissionSource
  sourceId: number
  date: string
  storeId: string
  storeName: string
  employeeId: string
  employeeName: string
  positionName: string
  /** 系统单号：销售单号 / 服务单号 */
  orderId: string
  /** 销售行的款项 id（跳 /allocations/payments/[paymentId]）；服务行为 null */
  paymentId: number | null
  /** 无 customer:list 时已在服务端脱敏 */
  customerName: string
  orderKind: string
  productName: string
  categoryL1: string
  categoryL2: string
  received: number
  /** 服务行的消耗额；销售行为 null */
  consumeAmount: number | null
  allocated: number | null
  rate: number | null
  commission: number
}

export type CommissionDetailColumn = MatrixExportColumnSpec<CommissionDetailRow> & ColumnPresentation & {
  role?: 'order' | 'source'
}

export function productLabel(row: Pick<CommissionDetailRow, 'productName' | 'categoryL1' | 'categoryL2'>): string {
  const category = [row.categoryL1, row.categoryL2].filter(Boolean).join(' / ')
  return category ? `${row.productName}（${category}）` : row.productName
}

/**
 * 明细列：门店｜日期｜[员工]｜订单号｜顾客姓名｜订单类型｜项目名称（一级 / 二级品项）｜实收金额｜消耗额｜分配金额｜提成点｜提成｜提成类型。
 * 员工列只在未限定员工时出现（限定时信息条已写明员工）。
 * 分页表的合计全部来自服务端（金额列 sum 由汇总 SQL 给出），不拿本页现算。
 */
export function buildCommissionDetailColumns(input: { showEmployee: boolean }): CommissionDetailColumn[] {
  return [
    { key: 'store', header: '门店', width: 120, freeze: 'left', exportValue: (row) => row.storeName, exportWidth: 16 },
    { key: 'date', header: '日期', width: 104, freeze: 'left', exportValue: (row) => row.date, exportWidth: 12 },
    ...(input.showEmployee
      ? [{
          key: 'employee', header: '员工', width: 120,
          exportValue: (row: CommissionDetailRow) => `${row.employeeName}（${row.positionName || '无岗位'}）`,
          exportWidth: 16,
        } satisfies CommissionDetailColumn]
      : []),
    { key: 'order', header: '订单号', width: 176, role: 'order', exportValue: (row) => row.orderId, exportWidth: 22 },
    { key: 'customer', header: '顾客姓名', width: 96, exportValue: (row) => row.customerName, exportWidth: 12 },
    { key: 'kind', header: '订单类型', width: 140, exportValue: (row) => row.orderKind, exportWidth: 16 },
    { key: 'product', header: '项目名称', width: 240, exportValue: (row) => productLabel(row), exportWidth: 36 },
    {
      key: 'received', header: '实收金额', width: 104, align: 'right',
      hint: '销售行 = 这笔款项落在该商品行上的金额（退款为负）；服务行为 0，见消耗额',
      value: (row) => row.received, aggregate: { kind: 'sum' },
    },
    {
      key: 'consume', header: '消耗额', width: 96, align: 'right',
      hint: '仅服务行：单价 × 次数',
      value: (row) => row.consumeAmount,
    },
    {
      key: 'allocated', header: '分配金额', width: 104, align: 'right',
      hint: '销售行 = 分配给该员工的营业额；服务行 = round(round(单价 × 次数, 2) × 分配比例, 2)',
      value: (row) => row.allocated, aggregate: { kind: 'sum' },
    },
    {
      key: 'rate', header: '提成点', width: 88, align: 'right', unit: 'percent',
      hint: '落库的费率快照；合计行为平均提成点 = Σ提成 ÷ Σ分配金额',
      value: (row) => row.rate, aggregate: { kind: 'server' },
    },
    {
      key: 'commission', header: '提成', width: 104, align: 'right',
      value: (row) => row.commission, aggregate: { kind: 'sum' },
    },
    {
      key: 'source', header: '提成类型', width: 80, role: 'source',
      exportValue: (row) => COMMISSION_SOURCE_LABELS[row.source], exportWidth: 10,
    },
  ]
}
