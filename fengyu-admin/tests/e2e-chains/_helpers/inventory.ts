/**
 * e2e-chains/_helpers/inventory.ts
 *
 * 库存域（procurement/sale/transfer/scrap）专属测试助手：
 *   - cleanupInventoryNamespace(prefix) — 批量清 4 类表中 remark 含 prefix 的残留
 *   - insertProcurementFixture / insertTransferFixture / insertScrapFixture / insertSaleFixture
 *     SQL 直插 fixture（绕过 admin action，纯造 list scope 矩阵数据）
 *   - getInventoryHeader(category, id)：返回单据头部 + items 聚合
 *   - readLatestAudit(action, targetId)：读 operation_logs 最新一条 detail，自动 JSON.parse
 *
 * 设计要点：
 *   1) fixture id 命名空间：`TE2L<N>-<CAT>-<TS>-<seq>`，便于 afterAll 按前缀清
 *   2) 默认 createdBy='FY-TEST-ADM'，避免 staff_wechat_users FK 报错
 *   3) 走 psql 同步执行（与现有 link-* 模式一致）
 *   4) audit detail：库存 actions 写裸 logOperation（{itemCount,storeId,...} / {changes:[keys]} / {} / {receiveQuantity}）；
 *      settings/stores 走 logUpdate（{_v:3,_t:'update',changes:{field:{from,to}}}）
 */

import { psql } from './scope-helpers'

export type InventoryCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'

const TABLE_MAP: Record<InventoryCategory, { header: string; items: string }> = {
  procurement: {
    header: 'inventory_procurement_orders',
    items: 'inventory_procurement_order_items',
  },
  sale: {
    header: 'inventory_sale_orders',
    items: 'inventory_sale_order_items',
  },
  transfer: {
    header: 'inventory_transfer_orders',
    items: 'inventory_transfer_order_items',
  },
  scrap: {
    header: 'inventory_scrap_orders',
    items: 'inventory_scrap_order_items',
  },
}

const sqlStr = (v: string | null | undefined) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const sqlNum = (v: number | null | undefined) => (v == null ? 'NULL' : String(v))

export interface FixtureItem {
  productCode: string
  productName: string
  quantity: number
  unitPrice?: number
  amount?: number
  scrapReason?: string // scrap 必填
}

export interface ProcurementFixtureOpts {
  id: string
  storeId: string
  docSubtype?: '院报货' | '院入库' | '退货出库'
  docDate?: string // YYYY-MM-DD
  remark?: string
  createdBy?: string
  status?: '草稿' | '已完成' | '已取消'
  items: FixtureItem[]
}

export function insertProcurementFixture(opts: ProcurementFixtureOpts): void {
  const docDate = opts.docDate ?? new Date().toISOString().slice(0, 10)
  const subtype = opts.docSubtype ?? '院入库'
  const status = opts.status ?? '已完成'
  const totalQty = opts.items.reduce((acc, it) => acc + it.quantity, 0)
  const createdBy = opts.createdBy ?? 'FY-TEST-ADM'

  psql(
    `INSERT INTO inventory_procurement_orders ` +
      `(id, doc_subtype, status, store_id, doc_date, total_quantity, is_completed, remark, created_by, created_at, updated_at) ` +
      `VALUES (${sqlStr(opts.id)}, '${subtype}', '${status}', ${sqlStr(opts.storeId)}, '${docDate}', ${totalQty}, false, ${sqlStr(opts.remark)}, '${createdBy}', NOW(), NOW())`,
  )
  for (const it of opts.items) {
    psql(
      `INSERT INTO inventory_procurement_order_items ` +
        `(order_id, product_code, product_name, quantity, unit_price, amount, is_gift, created_at) ` +
        `VALUES (${sqlStr(opts.id)}, ${sqlStr(it.productCode)}, ${sqlStr(it.productName)}, ${it.quantity}, ${sqlNum(it.unitPrice)}, ${sqlNum(it.amount)}, false, NOW())`,
    )
  }
}

export interface TransferFixtureOpts {
  id: string
  storeId: string // 发起方
  counterpartStoreId: string // 接收方
  docSubtype?: '调拨出库' | '调拨入库'
  docDate?: string
  remark?: string
  createdBy?: string
  status?: '草稿' | '已完成' | '已取消'
  items: FixtureItem[]
}

export function insertTransferFixture(opts: TransferFixtureOpts): void {
  const docDate = opts.docDate ?? new Date().toISOString().slice(0, 10)
  const subtype = opts.docSubtype ?? '调拨出库'
  const status = opts.status ?? '已完成'
  const totalQty = opts.items.reduce((acc, it) => acc + it.quantity, 0)
  const isDispatcher = subtype === '调拨出库'
  const createdBy = opts.createdBy ?? 'FY-TEST-ADM'

  psql(
    `INSERT INTO inventory_transfer_orders ` +
      `(id, doc_subtype, status, store_id, counterpart_store_id, is_dispatcher, doc_date, total_quantity, remark, created_by, created_at, updated_at) ` +
      `VALUES (${sqlStr(opts.id)}, '${subtype}', '${status}', ${sqlStr(opts.storeId)}, ${sqlStr(opts.counterpartStoreId)}, ${isDispatcher}, '${docDate}', ${totalQty}, ${sqlStr(opts.remark)}, '${createdBy}', NOW(), NOW())`,
  )
  for (const it of opts.items) {
    psql(
      `INSERT INTO inventory_transfer_order_items ` +
        `(order_id, product_code, product_name, quantity, unit_price, amount, is_gift, created_at) ` +
        `VALUES (${sqlStr(opts.id)}, ${sqlStr(it.productCode)}, ${sqlStr(it.productName)}, ${it.quantity}, ${sqlNum(it.unitPrice)}, ${sqlNum(it.amount)}, false, NOW())`,
    )
  }
}

export interface ScrapFixtureOpts {
  id: string
  storeId: string
  docDate?: string
  remark?: string
  createdBy?: string
  status?: '草稿' | '已完成' | '已取消'
  items: FixtureItem[] // scrapReason 必填
}

export function insertScrapFixture(opts: ScrapFixtureOpts): void {
  const docDate = opts.docDate ?? new Date().toISOString().slice(0, 10)
  const status = opts.status ?? '已完成'
  const totalQty = opts.items.reduce((acc, it) => acc + it.quantity, 0)
  const createdBy = opts.createdBy ?? 'FY-TEST-ADM'

  psql(
    `INSERT INTO inventory_scrap_orders ` +
      `(id, status, store_id, doc_date, total_quantity, remark, created_by, created_at, updated_at) ` +
      `VALUES (${sqlStr(opts.id)}, '${status}', ${sqlStr(opts.storeId)}, '${docDate}', ${totalQty}, ${sqlStr(opts.remark)}, '${createdBy}', NOW(), NOW())`,
  )
  for (const it of opts.items) {
    if (!it.scrapReason) throw new Error(`insertScrapFixture: items[].scrapReason 必填（${it.productCode}）`)
    psql(
      `INSERT INTO inventory_scrap_order_items ` +
        `(order_id, product_code, product_name, quantity, unit_price, amount, scrap_reason, is_gift, created_at) ` +
        `VALUES (${sqlStr(opts.id)}, ${sqlStr(it.productCode)}, ${sqlStr(it.productName)}, ${it.quantity}, ${sqlNum(it.unitPrice)}, ${sqlNum(it.amount)}, ${sqlStr(it.scrapReason)}, false, NOW())`,
    )
  }
}

export interface SaleFixtureOpts {
  id: string
  storeId: string
  docSubtype?: '销售出库' | '顾客退货'
  docDate?: string
  customerName?: string
  remark?: string
  createdBy?: string
  status?: '草稿' | '已完成' | '已取消'
  items: FixtureItem[]
}

export function insertSaleFixture(opts: SaleFixtureOpts): void {
  const docDate = opts.docDate ?? new Date().toISOString().slice(0, 10)
  const subtype = opts.docSubtype ?? '销售出库'
  const status = opts.status ?? '已完成'
  const totalQty = opts.items.reduce((acc, it) => acc + it.quantity, 0)
  const createdBy = opts.createdBy ?? 'FY-TEST-ADM'

  psql(
    `INSERT INTO inventory_sale_orders ` +
      `(id, doc_subtype, status, store_id, doc_date, total_quantity, customer_name, remark, created_by, created_at, updated_at) ` +
      `VALUES (${sqlStr(opts.id)}, '${subtype}', '${status}', ${sqlStr(opts.storeId)}, '${docDate}', ${totalQty}, ${sqlStr(opts.customerName)}, ${sqlStr(opts.remark)}, '${createdBy}', NOW(), NOW())`,
  )
  for (const it of opts.items) {
    psql(
      `INSERT INTO inventory_sale_order_items ` +
        `(order_id, product_code, product_name, quantity, unit_price, amount, is_gift, created_at) ` +
        `VALUES (${sqlStr(opts.id)}, ${sqlStr(it.productCode)}, ${sqlStr(it.productName)}, ${it.quantity}, ${sqlNum(it.unitPrice)}, ${sqlNum(it.amount)}, false, NOW())`,
    )
  }
}

function psqlSafe(sql: string): void {
  try {
    psql(sql)
  } catch (e) {
    // cleanup 阶段网络/PG 抖动不影响断言结果，吞掉错误避免 finally 抛 fail
    console.warn(`[inventory cleanup] psql swallowed: ${(e as Error).message.slice(0, 120)}`)
  }
}

/**
 * 删除指定 id 的库存单据（items 走 ON DELETE CASCADE）。
 * 多条 id 一次清。容忍不存在。
 */
export function deleteInventoryByIds(category: InventoryCategory, ids: string[]): void {
  if (ids.length === 0) return
  const list = ids.map(sqlStr).join(', ')
  psqlSafe(`DELETE FROM ${TABLE_MAP[category].header} WHERE id IN (${list})`)
}

/**
 * 按 id 前缀清残留（用于 spec 自洁——`TE2L48-PROC-*`）。
 * 注意：仅清 inventory 4 类，operation_logs 单独清。
 */
export function cleanupInventoryByPrefix(prefix: string): void {
  for (const cat of Object.keys(TABLE_MAP) as InventoryCategory[]) {
    psqlSafe(`DELETE FROM ${TABLE_MAP[cat].header} WHERE id LIKE '${prefix.replace(/'/g, "''")}%'`)
  }
}

/** 清 operation_logs 中 target_id 匹配前缀的所有审计（与 inventory 一起清，避免堆积）。 */
export function cleanupAuditByPrefix(prefix: string): void {
  psqlSafe(`DELETE FROM operation_logs WHERE target_id LIKE '${prefix.replace(/'/g, "''")}%'`)
}

export interface InventoryHeaderRow {
  id: string
  status: string
  storeId: string
  counterpartStoreId?: string | null
  isDispatcher?: boolean | null
  totalQuantity: number | null
  receiveQuantity?: number | null
  confirmedAt?: string | null
  itemRowCount: number
  itemQuantitySum: number | null
}

/** 读 header + items 聚合，验头尾一致性用。 */
export function getInventoryHeader(category: InventoryCategory, id: string): InventoryHeaderRow | null {
  const headRow = psql(
    `SELECT id, status, store_id, total_quantity::text ` +
      (category === 'transfer'
        ? `, counterpart_store_id, is_dispatcher, receive_quantity::text, confirmed_at::text`
        : ``) +
      ` FROM ${TABLE_MAP[category].header} WHERE id = ${sqlStr(id)}`,
  )
  if (!headRow) return null
  const parts = headRow.split('|')
  const base: InventoryHeaderRow = {
    id: parts[0],
    status: parts[1],
    storeId: parts[2],
    totalQuantity: parts[3] === '' ? null : Number(parts[3]),
    itemRowCount: 0,
    itemQuantitySum: null,
  }
  if (category === 'transfer') {
    base.counterpartStoreId = parts[4] || null
    base.isDispatcher = parts[5] === 't'
    base.receiveQuantity = parts[6] === '' ? null : Number(parts[6])
    base.confirmedAt = parts[7] || null
  }
  const aggr = psql(
    `SELECT COUNT(*)::text || '|' || COALESCE(SUM(quantity)::text, '') FROM ${TABLE_MAP[category].items} WHERE order_id = ${sqlStr(id)}`,
  )
  const aggrParts = aggr.split('|')
  base.itemRowCount = Number(aggrParts[0] || 0)
  base.itemQuantitySum = aggrParts[1] ? Number(aggrParts[1]) : null
  return base
}

export interface AuditLogRow {
  action: string
  targetId: string
  detail: Record<string, unknown> | null
  operatorEmployeeId: string
  createdAt: string
}

/**
 * 读 operation_logs 中针对 (action, targetId) 的最新一条（按 created_at desc）。
 * detail 自动 JSON.parse；解析失败返回 null。
 */
export function readLatestAudit(action: string, targetId: string): AuditLogRow | null {
  const row = psql(
    `SELECT action, target_id, COALESCE(detail::text, ''), operator_employee_id, created_at::text ` +
      `FROM operation_logs ` +
      `WHERE action = ${sqlStr(action)} AND target_id = ${sqlStr(targetId)} ` +
      `ORDER BY created_at DESC LIMIT 1`,
  )
  if (!row) return null
  // psql -t -A 用 | 作字段分隔；detail 是 JSON 含 | 会破坏切分。
  // 改用倒序找最后 3 个 | 把后面 3 列拆出来，前面全是 detail。
  const idxAction = row.indexOf('|')
  if (idxAction < 0) return null
  const action_ = row.slice(0, idxAction)
  const rest1 = row.slice(idxAction + 1)
  const idxTarget = rest1.indexOf('|')
  if (idxTarget < 0) return null
  const targetId_ = rest1.slice(0, idxTarget)
  const rest2 = rest1.slice(idxTarget + 1)
  // rest2 = <detailJSON>|<operatorEmployeeId>|<createdAt>
  // detail JSON 中也可能含 |，从右侧切：最后 2 个 | 是分隔符
  const lastBar = rest2.lastIndexOf('|')
  if (lastBar < 0) return null
  const createdAt = rest2.slice(lastBar + 1)
  const rest3 = rest2.slice(0, lastBar)
  const prevBar = rest3.lastIndexOf('|')
  if (prevBar < 0) return null
  const operatorEmployeeId = rest3.slice(prevBar + 1)
  const detailStr = rest3.slice(0, prevBar)
  let detail: Record<string, unknown> | null = null
  if (detailStr) {
    try {
      detail = JSON.parse(detailStr)
    } catch {
      detail = null
    }
  }
  return {
    action: action_,
    targetId: targetId_,
    detail,
    operatorEmployeeId,
    createdAt,
  }
}

/** 生成命名空间唯一 id（带 timestamp + 短随机后缀）。 */
export function genFixtureId(prefix: string): string {
  const ts = Date.now().toString().slice(-9)
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')
  return `${prefix}-${ts}${rand}`
}
