/**
 * 门店库存只读路由（员工端）
 *
 * 4 类单据（采购入库 / 销售出库 / 调拨 / 报损）的 list + detail 查询。
 * 全员可查（仅 requireStaffBound），写入入口在 admin 后台。
 * 默认按 ctx.auth.effectiveStoreId 过滤本门店，管理层（headquarters/market）拉取全部 scope 内的。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

const CATEGORY_CONFIG = {
  procurement: {
    master: 'inventory_procurement_orders',
    items: 'inventory_procurement_order_items',
    masterCols: [
      'doc_subtype',
      'is_completed',
      'source_date',
      'source_quantity',
      'signature_url',
      'related_doc_no',
    ],
    itemExtraCols: ['request_quantity'],
    hasSubtype: true,
  },
  sale: {
    master: 'inventory_sale_orders',
    items: 'inventory_sale_order_items',
    masterCols: ['doc_subtype', 'client_user_id', 'customer_name', 'related_sale_order_id'],
    itemExtraCols: [
      'sale_flow_no',
      'customer_remaining',
      'verification_name',
      'verification_code',
    ],
    hasSubtype: true,
  },
  transfer: {
    master: 'inventory_transfer_orders',
    items: 'inventory_transfer_order_items',
    masterCols: [
      'doc_subtype',
      'counterpart_store_id',
      'is_dispatcher',
      'receive_quantity',
    ],
    itemExtraCols: [],
    hasSubtype: true,
    /** 调拨需要 OR(本店是发出方, 本店是接收方) */
    storeFilterMode: 'transfer',
  },
  scrap: {
    master: 'inventory_scrap_orders',
    items: 'inventory_scrap_order_items',
    masterCols: [],
    itemExtraCols: ['scrap_reason', 'item_usage'],
    hasSubtype: false,
  },
}

function isValidCategory(c) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_CONFIG, c)
}

function buildStoreFilter(auth, cfg, paramIndexStart) {
  // 管理层（scopeStoreIds 全 null 或多店）→ ANY(array)；门店模式 → 单店等值或 OR
  const ids = auth.scopeStoreIds || []
  if (ids.length === 0) {
    return { sql: 'FALSE', params: [], nextIdx: paramIndexStart }
  }
  if (cfg.storeFilterMode === 'transfer') {
    return {
      sql: `(store_id = ANY($${paramIndexStart}::text[]) OR counterpart_store_id = ANY($${paramIndexStart}::text[]))`,
      params: [ids],
      nextIdx: paramIndexStart + 1,
    }
  }
  return {
    sql: `store_id = ANY($${paramIndexStart}::text[])`,
    params: [ids],
    nextIdx: paramIndexStart + 1,
  }
}

async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const {
    docCategory,
    page = 1,
    pageSize = 20,
    docSubtype,
    status,
    storeId,
    startDate,
    endDate,
    keyword,
  } = ctx.event.payload || {}

  if (!isValidCategory(docCategory)) {
    throw new Error('INVALID_PARAMS: docCategory 必须是 procurement/sale/transfer/scrap')
  }
  const cfg = CATEGORY_CONFIG[docCategory]
  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit

  const conditions = []
  const params = []
  let idx = 1

  // scope 过滤
  const scope = buildStoreFilter(ctx.auth, cfg, idx)
  conditions.push(scope.sql)
  params.push(...scope.params)
  idx = scope.nextIdx

  if (storeId) {
    if (cfg.storeFilterMode === 'transfer') {
      conditions.push(`(store_id = $${idx} OR counterpart_store_id = $${idx})`)
    } else {
      conditions.push(`store_id = $${idx}`)
    }
    params.push(storeId)
    idx++
  }
  if (cfg.hasSubtype && docSubtype) {
    conditions.push(`doc_subtype = $${idx}`)
    params.push(docSubtype)
    idx++
  }
  if (status) {
    conditions.push(`status = $${idx}`)
    params.push(status)
    idx++
  }
  if (startDate) {
    conditions.push(`doc_date >= $${idx}`)
    params.push(startDate)
    idx++
  }
  if (endDate) {
    conditions.push(`doc_date <= $${idx}`)
    params.push(endDate)
    idx++
  }
  if (keyword) {
    const escaped = String(keyword).replace(/[%_]/g, '\\$&')
    conditions.push(`(id ILIKE $${idx} OR remark ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const masterSelectCols = [
    'id',
    'status',
    'store_id',
    'doc_date',
    'total_quantity',
    'remark',
    'created_by',
    'confirmed_by',
    'confirmed_at',
    'created_at',
    'updated_at',
    ...cfg.masterCols,
  ]

  const dataSql = `
    SELECT ${masterSelectCols.map((c) => `m.${c}`).join(', ')},
           s.store_name AS store_name,
           ${
             cfg.storeFilterMode === 'transfer'
               ? `(SELECT store_name FROM stores WHERE store_id = m.counterpart_store_id) AS counterpart_store_name,`
               : ''
           }
           (SELECT name FROM staff_wechat_users WHERE employee_id = m.created_by) AS created_by_name
      FROM ${cfg.master} m
 LEFT JOIN stores s ON s.store_id = m.store_id
       ${whereSql}
  ORDER BY m.doc_date DESC, m.created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `
  const countSql = `SELECT COUNT(*)::int AS cnt FROM ${cfg.master} ${whereSql}`

  const [rows, countRow] = await Promise.all([
    pg.query(dataSql, params),
    pg.query(countSql, params),
  ])

  ctx.result = {
    items: rows.map((r) => ({
      id: r.id,
      docSubtype: r.doc_subtype ?? null,
      status: r.status,
      storeId: r.store_id,
      storeName: r.store_name ?? null,
      docDate: r.doc_date,
      totalQuantity: r.total_quantity == null ? null : Number(r.total_quantity),
      remark: r.remark ?? null,
      createdBy: r.created_by,
      createdByName: r.created_by_name ?? null,
      confirmedBy: r.confirmed_by ?? null,
      confirmedAt: r.confirmed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // 类型特有扩展
      isCompleted: r.is_completed ?? null,
      sourceDate: r.source_date ?? null,
      sourceQuantity: r.source_quantity == null ? null : Number(r.source_quantity),
      signatureUrl: r.signature_url ?? null,
      relatedDocNo: r.related_doc_no ?? null,
      clientUserId: r.client_user_id ?? null,
      customerName: r.customer_name ?? null,
      relatedSaleOrderId: r.related_sale_order_id ?? null,
      counterpartStoreId: r.counterpart_store_id ?? null,
      counterpartStoreName: r.counterpart_store_name ?? null,
      isDispatcher: r.is_dispatcher ?? null,
      receiveQuantity: r.receive_quantity == null ? null : Number(r.receive_quantity),
    })),
    total: countRow[0]?.cnt ?? 0,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit,
  }
  return ctx.result
}

async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { docCategory, id } = ctx.event.payload || {}
  if (!isValidCategory(docCategory)) {
    throw new Error('INVALID_PARAMS: docCategory 必须是 procurement/sale/transfer/scrap')
  }
  if (!id) throw new Error('INVALID_PARAMS: 缺少单据号')

  const cfg = CATEGORY_CONFIG[docCategory]
  const ids = ctx.auth.scopeStoreIds || []
  if (ids.length === 0) throw new Error('PERMISSION_DENIED: 当前账号无可见门店')

  let scopeSql, scopeParams
  if (cfg.storeFilterMode === 'transfer') {
    scopeSql =
      '(m.store_id = ANY($2::text[]) OR m.counterpart_store_id = ANY($2::text[]))'
    scopeParams = [id, ids]
  } else {
    scopeSql = 'm.store_id = ANY($2::text[])'
    scopeParams = [id, ids]
  }

  const masterCols = [
    'id',
    'status',
    'store_id',
    'doc_date',
    'total_quantity',
    'remark',
    'created_by',
    'confirmed_by',
    'confirmed_at',
    'created_at',
    'updated_at',
    ...cfg.masterCols,
  ]
  const headRows = await pg.query(
    `SELECT ${masterCols.map((c) => `m.${c}`).join(', ')},
            s.store_name AS store_name,
            ${
              cfg.storeFilterMode === 'transfer'
                ? `(SELECT store_name FROM stores WHERE store_id = m.counterpart_store_id) AS counterpart_store_name,`
                : ''
            }
            (SELECT name FROM staff_wechat_users WHERE employee_id = m.created_by) AS created_by_name,
            (SELECT name FROM staff_wechat_users WHERE employee_id = m.confirmed_by) AS confirmed_by_name
       FROM ${cfg.master} m
  LEFT JOIN stores s ON s.store_id = m.store_id
      WHERE m.id = $1 AND ${scopeSql}
      LIMIT 1`,
    scopeParams,
  )
  if (headRows.length === 0) throw new Error('NOT_FOUND: 单据不存在或无权限')
  const r = headRows[0]

  const itemCols = [
    'id',
    'order_id',
    'product_code',
    'product_name',
    'spec_name',
    'manufacturer',
    'product_series',
    'batch_no',
    'expiry_date',
    'is_gift',
    'quantity',
    'stock_on_hand',
    'unit_price',
    'amount',
    'remark',
    'created_at',
    ...cfg.itemExtraCols,
  ]
  const itemRows = await pg.query(
    `SELECT ${itemCols.join(', ')} FROM ${cfg.items} WHERE order_id = $1 ORDER BY id`,
    [id],
  )

  ctx.result = {
    id: r.id,
    docSubtype: r.doc_subtype ?? null,
    status: r.status,
    storeId: r.store_id,
    storeName: r.store_name ?? null,
    docDate: r.doc_date,
    totalQuantity: r.total_quantity == null ? null : Number(r.total_quantity),
    remark: r.remark ?? null,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    confirmedBy: r.confirmed_by ?? null,
    confirmedByName: r.confirmed_by_name ?? null,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isCompleted: r.is_completed ?? null,
    sourceDate: r.source_date ?? null,
    sourceQuantity: r.source_quantity == null ? null : Number(r.source_quantity),
    signatureUrl: r.signature_url ?? null,
    relatedDocNo: r.related_doc_no ?? null,
    clientUserId: r.client_user_id ?? null,
    customerName: r.customer_name ?? null,
    relatedSaleOrderId: r.related_sale_order_id ?? null,
    counterpartStoreId: r.counterpart_store_id ?? null,
    counterpartStoreName: r.counterpart_store_name ?? null,
    isDispatcher: r.is_dispatcher ?? null,
    receiveQuantity: r.receive_quantity == null ? null : Number(r.receive_quantity),
    items: itemRows.map((it) => ({
      id: it.id,
      orderId: it.order_id,
      productCode: it.product_code,
      productName: it.product_name,
      specName: it.spec_name ?? null,
      manufacturer: it.manufacturer ?? null,
      productSeries: it.product_series ?? null,
      batchNo: it.batch_no ?? null,
      expiryDate: it.expiry_date,
      isGift: it.is_gift,
      quantity: Number(it.quantity),
      stockOnHand: it.stock_on_hand == null ? null : Number(it.stock_on_hand),
      unitPrice: it.unit_price == null ? null : Number(it.unit_price),
      amount: it.amount == null ? null : Number(it.amount),
      remark: it.remark ?? null,
      requestQuantity: it.request_quantity == null ? null : Number(it.request_quantity),
      saleFlowNo: it.sale_flow_no ?? null,
      customerRemaining:
        it.customer_remaining == null ? null : Number(it.customer_remaining),
      verificationName: it.verification_name ?? null,
      verificationCode: it.verification_code ?? null,
      scrapReason: it.scrap_reason ?? null,
      itemUsage: it.item_usage ?? null,
      createdAt: it.created_at,
    })),
  }
  return ctx.result
}

module.exports = {
  list,
  detail,
}
