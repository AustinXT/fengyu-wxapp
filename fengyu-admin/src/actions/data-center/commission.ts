'use server'

/**
 * 员工提成日报 / 提成明细（#375）取数。
 *
 * 权限：dashboard + data_center:staff_commission 由同一角色授权同时提供（withAllPermissions，
 * 与页面闸门 getStaffCommissionScopeOptions、导出 DATA_CENTER_VIEW_REQUIRED_ACTIONS 同一口径）。
 * 入参一律是 URL 查询参数原样（页面与 export-worker 共用），在这里解析 + 校验 scope，不信任调用方。
 *
 * 口径与 SQL 见 lib/data-center/commission-sql.ts；列定义见 commission-columns.ts。
 */
import { db } from '@/db'
import { withAllPermissions } from '@/lib/with-permission'
import { hasUiCapability } from '@/lib/permission-contract'
import { maskName } from '@/lib/pii'
import { resolveScopeName, validateScope } from '@/lib/data-center/context'
import { DATA_CENTER_STAFF_COMMISSION_ACTIONS } from '@/lib/data-center/reports'
import { firstQueryValue, parseScope } from '@/lib/data-center/params'
import { parseReportMonth } from '@/lib/data-center/report-period'
import { shanghaiToday } from '@/lib/data-center/time-range'
import { technicianCountSql } from '@/lib/data-center/technician-sql'
import {
  assembleCommissionMatrix,
  commissionFilterSignature,
  decodeCommissionCursor,
  encodeCommissionCursor,
  grainOf,
  parseCommissionDailyOptions,
  parseCommissionDetailFilters,
  parseCommissionDetailPageSize,
  type CommissionAggregateRecord,
  type CommissionDailyOptions,
  type CommissionDailyRow,
  type CommissionDailyTotals,
  type CommissionDetailFilters,
  type CommissionDetailKey,
  type CommissionRowGrain,
  type CommissionSource,
} from '@/lib/data-center/commission-daily'
import {
  buildCommissionDailyColumns,
  parseCommissionSort,
  sortCommissionDailyRows,
  type CommissionDetailRow,
} from '@/lib/data-center/commission-columns'
import {
  commissionDetailPageSql,
  commissionDetailSummarySql,
  commissionEmployeeOptionsSql,
  commissionKpiSql,
  commissionMatrixSql,
  detailLineFilters,
  pendingAllocationSql,
} from '@/lib/data-center/commission-sql'
import {
  EXPORT_WORKER_BATCH_SIZE,
  resolveExportBatchLimit,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import type { MatrixSort } from '@/lib/data-center/matrix'
import type { DataCenterScope } from '@/lib/data-center/types'
import type { AuthSession } from '@/lib/types'

type Query = Record<string, string | string[] | undefined>
type DbRow = Record<string, unknown>

function rowsOf(result: unknown): DbRow[] {
  return result as DbRow[]
}

/** numeric / bigint 经原生 SQL 返回字符串（见 fengyu-admin/CLAUDE.md），一律显式 Number() */
function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : 0
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

async function resolveContext(session: AuthSession, query: Query) {
  const get = (key: string) => firstQueryValue(query[key])
  const scope = parseScope({ scope: get('scope'), scopeId: get('scopeId') })
  await validateScope(session, scope)
  const today = shanghaiToday()
  const period = parseReportMonth({ month: get('month') }, today)
  return { scope, period, today, get }
}

// ─── 日报 ────────────────────────────────────────────────────────────────────

export interface CommissionDailyKpis {
  total: number
  sale: number
  service: number
  saleShare: number | null
  serviceShare: number | null
  /** 净提成 > 0 的去重员工数 */
  earningEmployees: number
  /** 有任意提成行的去重员工数（副文案「范围内共 N 位」） */
  employees: number
  /** 人均提成分母：产能技师数，与人效板 technicianCount 同源（#285 单源） */
  technicianCount: number
  perTechnician: number | null
  /** 去重订单数（销售单号 + 服务单号，含 0 提成订单） */
  orders: number
  perOrder: number | null
}

export interface CommissionDailyResult {
  month: string
  scopeName: string
  isAllScope: boolean
  options: CommissionDailyOptions
  grain: CommissionRowGrain
  sort: MatrixSort
  rows: CommissionDailyRow[]
  totals: CommissionDailyTotals
  kpis: CommissionDailyKpis
  /** 待分配提示（口径同 /allocations「待分配」） */
  pending: { count: number; amount: number }
}

export const getCommissionDaily = withAllPermissions(
  DATA_CENTER_STAFF_COMMISSION_ACTIONS,
  async (session, query: Query): Promise<CommissionDailyResult> => {
    const { scope, period, today, get } = await resolveContext(session, query)
    const options = parseCommissionDailyOptions(query)
    const isAllScope = scope.type === 'all'
    const grain = grainOf(options, isAllScope)
    const range = period.current
    // 人均分母按区间末在职历史化；本月未走完时截到今天（与人效板「本月」同口径）
    const technicianEnd = range.end > today ? today : range.end

    const [matrixRows, kpiRows, technicianRows, pendingRows, scopeName] = await Promise.all([
      db.execute(commissionMatrixSql(session, scope, range, grain, options)),
      db.execute(commissionKpiSql(session, scope, range)),
      db.execute(technicianCountSql(session, scope, technicianEnd)),
      db.execute(pendingAllocationSql(session, scope, range)),
      resolveScopeName(scope),
    ])

    const { rows, totals } = assembleCommissionMatrix(rowsOf(matrixRows) as unknown as CommissionAggregateRecord[], grain)
    const columns = buildCommissionDailyColumns({ month: period.month, view: options.view, grain, today })
    const sort = parseCommissionSort({ sort: get('sort'), dir: get('dir') }, columns)

    const kpi = rowsOf(kpiRows)[0] ?? {}
    const sale = toNumber(kpi.sale)
    const service = toNumber(kpi.service)
    const total = sale + service
    const orders = toNumber(kpi.orders)
    const technicianCount = toNumber(rowsOf(technicianRows)[0]?.v)
    const pending = rowsOf(pendingRows)[0] ?? {}

    return {
      month: period.month,
      scopeName,
      isAllScope,
      options,
      grain,
      sort,
      rows: sortCommissionDailyRows(rows, columns, sort),
      totals,
      kpis: {
        total,
        sale,
        service,
        // 占比分母用合计本身：合计 ≤ 0（极端的全月净退款）时占比无意义，给空
        saleShare: ratio(sale, total),
        serviceShare: ratio(service, total),
        earningEmployees: toNumber(kpi.earning_employees),
        employees: toNumber(kpi.employees),
        technicianCount,
        perTechnician: ratio(total, technicianCount),
        orders,
        perOrder: ratio(total, orders),
      },
      pending: { count: toNumber(pending.count), amount: toNumber(pending.amount) },
    }
  },
)

// ─── 明细 ────────────────────────────────────────────────────────────────────

export interface CommissionDetailSummary {
  count: number
  orders: number
  received: number
  allocated: number
  commission: number
  sale: number
  service: number
  /** 平均提成点 = Σ提成 ÷ Σ分配金额（含负数行、0 费率行）；Σ分配金额为 0 时为空 */
  averageRate: number | null
}

export interface CommissionEmployeeOption {
  employeeId: string
  /** 「门店 · 姓名（岗位）」，门店为员工所属门店 / 组织节点 */
  label: string
}

export interface CommissionDetailResult {
  month: string
  scopeName: string
  filters: CommissionDetailFilters
  pageSize: number
  rows: CommissionDetailRow[]
  summary: CommissionDetailSummary
  /** 上一页 / 下一页游标（keyset，绑定筛选签名） */
  prevCursor: string | null
  nextCursor: string | null
  employeeOptions: CommissionEmployeeOption[]
  /** 有 allocation:list 时订单号可点进分配详情 */
  canLinkOrders: boolean
  /** 无 customer:list 时顾客姓名已脱敏 */
  customerMasked: boolean
}

function detailSignature(scope: DataCenterScope, month: string, filters: CommissionDetailFilters): string {
  return commissionFilterSignature({
    scope: scope.type,
    scopeId: scope.type === 'market' || scope.type === 'store' ? scope.id : '',
    month,
    employeeId: filters.employeeId,
    storeId: filters.storeId,
    date: filters.date,
    type: filters.source,
  })
}

function toDetailRow(row: DbRow, maskCustomer: boolean): CommissionDetailRow {
  const source = row.source === 'service' ? 'service' : 'sale'
  const sourceId = toNumber(row.source_id)
  const customer = row.customer_name == null ? '' : String(row.customer_name)
  return {
    key: `${source}:${sourceId}`,
    source,
    sourceId,
    date: String(row.biz_date ?? ''),
    storeId: String(row.store_id ?? ''),
    storeName: String(row.store_name ?? row.store_id ?? ''),
    employeeId: String(row.employee_id ?? ''),
    employeeName: String(row.employee_name ?? row.employee_id ?? ''),
    positionName: row.position_name == null ? '' : String(row.position_name),
    orderId: String(row.order_id ?? ''),
    paymentId: toNullableNumber(row.payment_id),
    customerName: maskCustomer ? maskName(customer) : customer,
    orderKind: String(row.order_kind ?? ''),
    productName: row.product_name == null ? '' : String(row.product_name),
    categoryL1: row.category_l1 == null ? '' : String(row.category_l1),
    categoryL2: row.category_l2 == null ? '' : String(row.category_l2),
    received: toNumber(row.received),
    consumeAmount: toNullableNumber(row.consume_amount),
    allocated: toNullableNumber(row.allocated),
    rate: toNullableNumber(row.rate),
    commission: toNumber(row.commission),
  }
}

function keyOf(row: CommissionDetailRow): CommissionDetailKey {
  return { d: row.date, t: row.source as CommissionSource, id: row.sourceId }
}

/** 顾客姓名脱敏判定：与页面 / 导出同一处，没有 customer:list 就脱敏 */
function shouldMaskCustomer(session: AuthSession): boolean {
  return !hasUiCapability(session.permissions.actions, 'customer:list')
}

export const getCommissionDetail = withAllPermissions(
  DATA_CENTER_STAFF_COMMISSION_ACTIONS,
  async (session, query: Query): Promise<CommissionDetailResult> => {
    const { scope, period, get } = await resolveContext(session, query)
    const filters = parseCommissionDetailFilters(query, period.current)
    const pageSize = parseCommissionDetailPageSize(get('size'))
    const signature = detailSignature(scope, period.month, filters)
    const after = decodeCommissionCursor(get('after'), signature)
    const before = after ? null : decodeCommissionCursor(get('before'), signature)
    const lineFilters = detailLineFilters(filters, period.current)
    const maskCustomer = shouldMaskCustomer(session)

    const [pageRows, summaryRows, optionRows, scopeName] = await Promise.all([
      db.execute(commissionDetailPageSql(session, scope, lineFilters, { limit: pageSize, after, before })),
      db.execute(commissionDetailSummarySql(session, scope, lineFilters)),
      db.execute(commissionEmployeeOptionsSql(session, scope, period.current)),
      resolveScopeName(scope),
    ])

    const fetched = rowsOf(pageRows).map((row) => toDetailRow(row, maskCustomer))
    const hasMore = fetched.length > pageSize
    const visible = hasMore ? fetched.slice(0, pageSize) : fetched
    // 上一页是 SQL 反向取的，翻回正序
    const rows = before ? visible.reverse() : visible
    const first = rows[0]
    const last = rows[rows.length - 1]
    // 正向：有游标即有上一页，探测行决定下一页；反向：探测行决定上一页，游标本身之后必有下一页
    const hasPrev = before ? hasMore : !!after
    const hasNext = before ? true : hasMore

    const summary = rowsOf(summaryRows)[0] ?? {}
    const allocated = toNumber(summary.allocated)
    const commission = toNumber(summary.commission)

    return {
      month: period.month,
      scopeName,
      filters,
      pageSize,
      rows,
      summary: {
        count: toNumber(summary.count),
        orders: toNumber(summary.orders),
        received: toNumber(summary.received),
        allocated,
        commission,
        sale: toNumber(summary.sale),
        service: toNumber(summary.service),
        averageRate: allocated !== 0 ? commission / allocated : null,
      },
      prevCursor: hasPrev && first ? encodeCommissionCursor(keyOf(first), signature) : null,
      nextCursor: hasNext && last ? encodeCommissionCursor(keyOf(last), signature) : null,
      employeeOptions: rowsOf(optionRows).map((row) => {
        const name = String(row.name ?? row.employee_id ?? '')
        const home = row.home_name == null ? '无门店' : String(row.home_name)
        const position = row.position_name ? String(row.position_name) : '无岗位'
        return { employeeId: String(row.employee_id), label: `${home} · ${name}（${position}）` }
      }),
      canLinkOrders: hasUiCapability(session.permissions.actions, 'allocation:list'),
      customerMasked: maskCustomer,
    }
  },
)

/**
 * 明细导出（export-worker 分批调用）。keyset 游标同页面：(日期 DESC, 来源类型, 来源表主键 DESC)，
 * 游标是上一批最后一行的键（编码成串，iterateExportPages 按串判重防死循环）。
 */
export const exportCommissionDetail = withAllPermissions(
  DATA_CENTER_STAFF_COMMISSION_ACTIONS,
  async (
    session,
    query: Query,
    options: ExportBatchOptions<string> = {},
  ): Promise<ExportBatchResult<CommissionDetailRow, string> & { summary: CommissionDetailSummary | null; scopeName: string; month: string; filters: CommissionDetailFilters }> => {
    const { scope, period } = await resolveContext(session, query)
    const filters = parseCommissionDetailFilters(query, period.current)
    const signature = detailSignature(scope, period.month, filters)
    const limit = resolveExportBatchLimit(options.limit) ?? EXPORT_WORKER_BATCH_SIZE
    const after = decodeCommissionCursor(options.cursor, signature)
    // 游标给了却解不出来：一定是签名不符（筛选被改）或损坏，从头导会重复输出，直接失败
    if (options.cursor && !after) throw new Error('INVALID_STATE: 导出分页游标无效')
    const lineFilters = detailLineFilters(filters, period.current)

    const [pageRows, summaryRows, scopeName] = await Promise.all([
      db.execute(commissionDetailPageSql(session, scope, lineFilters, { limit, after })),
      // 汇总只在第一批取一次，写进合计行
      after ? Promise.resolve(null) : db.execute(commissionDetailSummarySql(session, scope, lineFilters)),
      resolveScopeName(scope),
    ])
    const maskCustomer = shouldMaskCustomer(session)
    const fetched = rowsOf(pageRows).map((row) => toDetailRow(row, maskCustomer))
    const hasMore = fetched.length > limit
    const rows = hasMore ? fetched.slice(0, limit) : fetched

    let summary: CommissionDetailSummary | null = null
    if (summaryRows) {
      const raw = rowsOf(summaryRows)[0] ?? {}
      const allocated = toNumber(raw.allocated)
      const commission = toNumber(raw.commission)
      summary = {
        count: toNumber(raw.count),
        orders: toNumber(raw.orders),
        received: toNumber(raw.received),
        allocated,
        commission,
        sale: toNumber(raw.sale),
        service: toNumber(raw.service),
        averageRate: allocated !== 0 ? commission / allocated : null,
      }
    }
    return {
      rows,
      truncated: false,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCommissionCursor(keyOf(rows[rows.length - 1]), signature) } : {}),
      summary,
      scopeName,
      month: period.month,
      filters,
    }
  },
)
