import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import {
  resolveExportBatchLimit,
  resolveExportKeysetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { withPermission } from '@/lib/with-permission'
import { sql, type SQL } from 'drizzle-orm'
import type { AuthSession } from '@/lib/types'
import { assertInventoryLocationInScope } from './access'
import { assertRealCalendarDate } from './settlements'
import { INVENTORY_MOVEMENT_DEFAULT_PAGE_SIZE, INVENTORY_MOVEMENT_PAGE_SIZES } from './types'
import type {
  InventoryMovementDirection,
  InventoryMovementFilters,
  InventoryMovementPage,
  InventoryMovementRow,
} from './types'

/**
 * 全产品进出明细（#360）：按「库存主体 + 商品编号 / 批号（二选一）」查 inventory_movements 全流水。
 *
 * - 结存列是**批次结存**（流水自带的 quantity_before / quantity_after），按商品编号跨批次查时
 *   每行结存是该行所在批次的结存，配合「批号」列阅读 —— 2026-09-26 拍板方案 A，不另算主体合计。
 * - 排序与翻页键都是 `inventory_movements.id`（bigserial，不可变主键）：同一 created_at 的多行
 *   不会在页边界漏行/重行（与 export-pagination 的 keyset 约定一致）。
 * - 不含任何金额列，价格档位无关；scope 走 inventoryScopedLocationIds（总部不展开市场/门店）。
 * - 并发写入：id 在 INSERT 时分配、提交可能乱序，游标已越过的位置之前若有晚提交的行，本次翻页 / 导出
 *   看不到它（回首页重查可见），与 export-pagination 的「开始时刻集合」契约一致。同一批次的流水在批次行锁
 *   （FOR UPDATE）内写入，id 序 = 提交序 = 结存链序，单批次的前后结存链不会断。
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const CURSOR_PATTERN = /^[1-9]\d{0,17}$/
const MAX_TEXT_LENGTH = 64

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  const text = value.trim()
  if (!text) return undefined
  if (text.length > MAX_TEXT_LENGTH) throw new ApiError('INVALID_PARAMS', `${label}过长`)
  return text
}

function optionalDate(value: unknown, label: string): string | undefined {
  const text = optionalText(value, label)
  if (!text) return undefined
  if (!DATE_PATTERN.test(text)) throw new ApiError('INVALID_PARAMS', `${label}不是有效的日历日期`)
  assertRealCalendarDate(text, label)
  return text
}

function optionalCursor(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !CURSOR_PATTERN.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new ApiError('INVALID_PARAMS', `${label}格式不正确`)
  }
  return Number(text)
}

interface NormalizedMovementFilters {
  locationId: string
  skuCode?: string
  batchNo?: string
  startDate?: string
  endDate?: string
}

/**
 * 入参校验必须先于 scope 判定和任何 DB 访问：否则空 scope 会话传非法入参拿到的是
 * PERMISSION_DENIED 而不是 INVALID_PARAMS，同一入参的对错取决于谁在调。
 */
export function normalizeInventoryMovementFilters(filters: InventoryMovementFilters): NormalizedMovementFilters {
  const locationId = optionalText(filters.locationId, '库存主体')
  if (!locationId) throw new ApiError('INVALID_PARAMS', '请选择库存主体')
  const skuCode = optionalText(filters.skuCode, '商品编号')
  const batchNo = optionalText(filters.batchNo, '批号')
  if (!skuCode && !batchNo) throw new ApiError('INVALID_PARAMS', '请输入商品编号或批号')
  if (skuCode && batchNo) throw new ApiError('INVALID_PARAMS', '商品编号与批号只能二选一')
  const startDate = optionalDate(filters.startDate, '开始日期')
  const endDate = optionalDate(filters.endDate, '结束日期')
  if (startDate && endDate && startDate > endDate) {
    throw new ApiError('INVALID_PARAMS', '开始日期不能晚于结束日期')
  }
  return { locationId, skuCode, batchNo, startDate, endDate }
}

/**
 * 查询条件（不含翻页键）：计数、列表、导出三处共用同一份，同一时刻下三者条数一致。
 * （计数与列表是两条独立语句、导出异步执行，期间新写入的流水会造成个位数差异。）
 *
 * ⚠ 只允许引用 `m`（inventory_movements）与 `lot`（inventory_stock_lots）两个别名：
 * 计数 SQL 只 JOIN 了这两张表，引用 doc / loc / operator 会让计数在运行时报错。
 */
export function inventoryMovementWhereSql(filters: NormalizedMovementFilters): SQL {
  const conditions: SQL[] = [sql`m.location_id = ${filters.locationId}`]
  if (filters.skuCode) {
    // 商品编号：库存 SKU 的 sku_id 与 product_code 都唯一，用户手上拿到的可能是任一个
    conditions.push(sql`m.sku_id IN (
      SELECT sku.sku_id FROM inventory_skus sku
       WHERE sku.sku_id = ${filters.skuCode} OR sku.product_code = ${filters.skuCode}
    )`)
  }
  if (filters.batchNo) conditions.push(sql`lot.batch_no = ${filters.batchNo}`)
  // 日期按上海自然日：[startDate 00:00, endDate+1 00:00) —— created_at 是 timestamptz
  if (filters.startDate) {
    conditions.push(sql`m.created_at >= (${filters.startDate}::date)::timestamp AT TIME ZONE 'Asia/Shanghai'`)
  }
  if (filters.endDate) {
    conditions.push(sql`m.created_at < (${filters.endDate}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'`)
  }
  return sql.join(conditions, sql` AND `)
}

type KeysetBound = { after: number } | { before: number } | null

// 例外：流水型列表默认 desc(createdAt)，这里按 id 正序 —— 排查多/少要「从头到尾」顺着结存读，
// 且 id 是唯一不可变的 keyset 键；created_at 取事务开始时刻，并发写入下与 id 序不保证一致。
export function inventoryMovementSelectSql(
  filters: NormalizedMovementFilters,
  bound: KeysetBound,
  limit: number,
): SQL {
  const conditions: SQL[] = [inventoryMovementWhereSql(filters)]
  if (bound && 'after' in bound) conditions.push(sql`m.id > ${bound.after}`)
  if (bound && 'before' in bound) conditions.push(sql`m.id < ${bound.before}`)
  // before 翻页倒序取离游标最近的 N 行，调用方再翻回正序
  const order = bound && 'before' in bound ? sql`DESC` : sql`ASC`
  return sql`
    SELECT m.id,
           m.lot_id,
           m.sku_id,
           lot.sku_name,
           lot.spec_name,
           lot.batch_no,
           m.doc_id,
           doc.doc_type,
           m.direction,
           m.quantity_delta,
           m.quantity_before,
           m.quantity_after,
           -- 对方主体：组织端点优先（流水主体必是单据的 source 或 target，另一端即对方；端点无主体行时显示节点 id）；
           -- 非组织对象回落名称快照。employee_name 是单据的「相关员工」（员工购出库里是购买员工），
           -- 不是经办人 —— 经办人另取 m.created_by
           CASE
             WHEN doc.id IS NULL THEN NULL
             WHEN doc.source_org_node_id IS NOT NULL AND doc.source_org_node_id <> loc.org_node_id THEN COALESCE(src.name, doc.source_org_node_id)
             WHEN doc.target_org_node_id IS NOT NULL AND doc.target_org_node_id <> loc.org_node_id THEN COALESCE(tgt.name, doc.target_org_node_id)
             ELSE COALESCE(doc.supplier_name, doc.customer_name, doc.external_party_name, doc.employee_name)
           END AS counterparty_name,
           m.created_by,
           operator.name AS operator_name,
           m.remark,
           to_char(m.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS created_at
      -- 以下 JOIN 键全部唯一（lot.id / location_id / doc.id 主键，org_node_id 唯一索引，employee_id 主键），
      -- 不会放大行数：计数 SQL 不 JOIN 它们也与列表行数一致
      FROM inventory_movements m
      JOIN inventory_stock_lots lot ON lot.id = m.lot_id
      JOIN inventory_locations loc ON loc.location_id = m.location_id
      LEFT JOIN inventory_docs doc ON doc.id = m.doc_id
      LEFT JOIN inventory_locations src ON src.org_node_id = doc.source_org_node_id
      LEFT JOIN inventory_locations tgt ON tgt.org_node_id = doc.target_org_node_id
      LEFT JOIN staff_wechat_users operator ON operator.employee_id = m.created_by
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY m.id ${order}
     LIMIT ${limit}
  `
}

export function inventoryMovementCountSql(filters: NormalizedMovementFilters): SQL {
  return sql`
    SELECT COUNT(*)::int AS total
      FROM inventory_movements m
      JOIN inventory_stock_lots lot ON lot.id = m.lot_id
     WHERE ${inventoryMovementWhereSql(filters)}
  `
}

interface RawMovementRow {
  id: string | number
  lot_id: string | number
  sku_id: string
  sku_name: string | null
  spec_name: string | null
  batch_no: string | null
  doc_id: string | null
  doc_type: string | null
  direction: string
  quantity_delta: string | number
  quantity_before: string | number
  quantity_after: string | number
  counterparty_name: string | null
  created_by: string | null
  operator_name: string | null
  remark: string | null
  created_at: string
}

// 原生 SQL 经 postgres.js 回来 bigint / numeric 都是 string，必须显式 Number()
function movementRow(row: RawMovementRow): InventoryMovementRow {
  return {
    id: Number(row.id),
    lotId: Number(row.lot_id),
    skuId: row.sku_id,
    skuName: row.sku_name,
    specName: row.spec_name,
    batchNo: row.batch_no,
    docId: row.doc_id,
    docType: row.doc_type,
    direction: row.direction as InventoryMovementDirection,
    quantityDelta: Number(row.quantity_delta),
    quantityBefore: Number(row.quantity_before),
    quantityAfter: Number(row.quantity_after),
    counterpartyName: row.counterparty_name,
    operatorId: row.created_by,
    operatorName: row.operator_name,
    remark: row.remark,
    createdAt: row.created_at,
  }
}

async function queryMovementRows(query: SQL): Promise<InventoryMovementRow[]> {
  const rows = await db.execute(query)
  return (rows as unknown as RawMovementRow[]).map(movementRow)
}

export async function listInventoryMovementsForSession(
  session: AuthSession,
  params: InventoryMovementFilters & { after?: unknown; before?: unknown; pageSize?: unknown },
): Promise<InventoryMovementPage> {
  const filters = normalizeInventoryMovementFilters(params)
  const after = optionalCursor(params.after, '翻页游标')
  const before = optionalCursor(params.before, '翻页游标')
  if (after !== undefined && before !== undefined) {
    throw new ApiError('INVALID_PARAMS', '翻页游标只能指定一个方向')
  }
  const requestedSize = Number(params.pageSize)
  const pageSize = (INVENTORY_MOVEMENT_PAGE_SIZES as readonly number[]).includes(requestedSize)
    ? requestedSize
    : INVENTORY_MOVEMENT_DEFAULT_PAGE_SIZE
  assertInventoryLocationInScope(session, filters.locationId)

  const bound: KeysetBound = after !== undefined ? { after } : before !== undefined ? { before } : null
  const [countResult, fetched] = await Promise.all([
    db.execute(inventoryMovementCountSql(filters)),
    queryMovementRows(inventoryMovementSelectSql(filters, bound, pageSize + 1)),
  ])
  const total = Number((countResult as unknown as Array<{ total: number | string }>)[0]?.total ?? 0)
  const probed = fetched.length > pageSize
  const pageRows = probed ? fetched.slice(0, pageSize) : fetched
  if (bound && 'before' in bound) {
    // 倒序取回：多出的探测行在更早一侧 → 还有上一页。界面生成的 before 是下一页首行 id，
    // 游标之后必有行；手改 URL 取到空页时不再给「下一页」
    pageRows.reverse()
    return { rows: pageRows, total, hasPrev: probed, hasNext: pageRows.length > 0 }
  }
  // after 游标由界面取自上一页末行，游标之前必有行（手改 URL 的偏小游标只会得到一个空的上一页）
  return { rows: pageRows, total, hasPrev: bound !== null, hasNext: probed }
}

export const listInventoryMovements = withPermission(
  'inventory:stock_list',
  async (
    session,
    params: InventoryMovementFilters & { after?: string; before?: string; pageSize?: number },
  ): Promise<InventoryMovementPage> => listInventoryMovementsForSession(session, params),
)

/** 导出：同一 where，按 id 升序 keyset 分批。游标只有 `undefined` 是首批，其余非正整数一律拒绝。 */
export async function exportInventoryMovementsForSession(
  session: AuthSession,
  params: Record<string, string | undefined>,
  options?: ExportBatchOptions<number>,
): Promise<ExportBatchResult<InventoryMovementRow>> {
  const filters = normalizeInventoryMovementFilters({
    // 与页面 URL / 导出载荷同名的短键
    locationId: params.location,
    skuCode: params.sku,
    batchNo: params.batch,
    startDate: params.start,
    endDate: params.end,
  })
  if (options?.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 1)) {
    throw new ApiError('INVALID_STATE', '导出分页游标不合法')
  }
  assertInventoryLocationInScope(session, filters.locationId)

  const limit = resolveExportBatchLimit(options?.limit)
  if (limit == null) {
    throw new ApiError('INVALID_STATE', '进出明细导出只支持分批取数')
  }
  const bound: KeysetBound = options?.cursor === undefined ? null : { after: options.cursor }
  const fetched = await queryMovementRows(inventoryMovementSelectSql(filters, bound, limit + 1))
  const page = resolveExportKeysetPage(fetched, limit, (row) => row.id)
  return {
    rows: page.pageRows,
    truncated: false,
    hasMore: page.hasMore,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}

export const exportInventoryMovements = withPermission(
  'inventory:export',
  async (
    session,
    params: Record<string, string | undefined> = {},
    options?: ExportBatchOptions<number>,
  ): Promise<ExportBatchResult<InventoryMovementRow>> => exportInventoryMovementsForSession(session, params, options),
)
