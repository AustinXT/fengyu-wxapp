/**
 * 门店库存只读路由（员工端）
 *
 * 4 类单据（采购入库 / 销售出库 / 调拨 / 报损）的 list + detail 查询。
 * 全员可查（仅 requireStaffBound），写入入口在 admin 后台。
 * 默认按 ctx.auth.effectiveStoreId 过滤本门店，管理层（headquarters/market）拉取全部 scope 内的。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')
const { expandScopeStoreIds } = require('../utils/scope')
const cloud = require('wx-server-sdk')

const INVENTORY_WRITE_ROLES = ['admin', 'manager', 'product']
const INVENTORY_APPROVER_ROLES = ['admin', 'finance']
const VALID_STORE_SCOPE_TYPES = new Set(['总部', '市场', '门店'])

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

const DOC_PREFIX = {
  '院报货': 'YBH',
  '院入库': 'YRK',
  '院顾客退货': 'GTH',
  '院顾客产品出库': 'GCK',
  '院退货': 'YTH',
  '院产品报损': 'YBS',
  '分院调货出库': 'DBO',
  '分院调货入库': 'DBI',
  '期初库存': 'QC',
}

function isValidDocType(docType) {
  return Object.prototype.hasOwnProperty.call(DOC_PREFIX, docType)
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function shanghaiYmd() {
  return shanghaiToday().replace(/-/g, '')
}

function rowsOf(result) {
  return Array.isArray(result) ? result : result.rows
}

function normalizeBatchNo(batchNo) {
  return String(batchNo || '').trim()
}

function normalizeDateKey(expiryDate) {
  return String(expiryDate || '').trim()
}

function assertQty(quantity) {
  const n = Number(quantity)
  if (!Number.isFinite(n) || n <= 0) throw new Error('INVALID_PARAMS: 明细数量必须大于0')
  return n
}

function requireStoreInScope(auth, storeId) {
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店')
  const ids = auth.scopeStoreIds || []
  if (!ids.includes(storeId)) throw new Error('PERMISSION_DENIED: 无权操作该门店库存')
}

async function resolveInventoryWriteStoreId(ctx, payload) {
  const storeId = payload.storeId || ctx.auth.effectiveStoreId
  await assertInventoryWriteStoreScope(pg, ctx.auth, storeId)
  return storeId
}

function defaultDocStatus(docType) {
  if (docType === '院退货' || docType === '院产品报损') return '待审批'
  if (docType === '分院调货出库') return '待收货'
  return '已完成'
}

function movementDirection(docType) {
  if (['院入库', '院顾客退货', '分院调货入库', '期初库存'].includes(docType)) return '入库'
  if (['院顾客产品出库', '分院调货出库'].includes(docType)) return '出库'
  return null
}

function approvalMovementDirection(docType) {
  return ['院退货', '院产品报损'].includes(docType) ? '出库' : null
}

function roleBindingsFor(auth, roles) {
  const allowed = new Set(roles)
  return (auth.roleBindings || []).filter((rb) => (
    rb
    && allowed.has(rb.role)
    && VALID_STORE_SCOPE_TYPES.has(rb.scopeType)
    && rb.scopeId
  ))
}

async function assertStoreCoveredByBindings(client, bindings, storeId, message) {
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店')
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error(message)
  }
  const coveredStoreIds = await expandScopeStoreIds(bindings, client)
  if (!coveredStoreIds.includes(storeId)) throw new Error(message)
}

async function assertInventoryWriteStoreScope(client, auth, storeId) {
  const bindings = roleBindingsFor(auth, INVENTORY_WRITE_ROLES)
  if (bindings.length === 0) {
    throw new Error('PERMISSION_DENIED: 无库存写入权限')
  }
  await assertStoreCoveredByBindings(
    client,
    bindings,
    storeId,
    'PERMISSION_DENIED: 无权操作该门店库存',
  )
}

function assertApprover(ctx) {
  const bindings = roleBindingsFor(ctx.auth, INVENTORY_APPROVER_ROLES)
  if (bindings.length === 0) {
    throw new Error('PERMISSION_DENIED: 仅市场财务或管理员可审批库存单据')
  }
}

async function assertApproverStoreScope(client, auth, storeId) {
  await assertStoreCoveredByBindings(
    client,
    roleBindingsFor(auth, INVENTORY_APPROVER_ROLES),
    storeId,
    'PERMISSION_DENIED: 无权审批该门店库存单据',
  )
}

async function generateDocNo(client, docType) {
  const prefix = DOC_PREFIX[docType]
  const ymd = shanghaiYmd()
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    `store_inventory_docs:${prefix}:${ymd}`,
  ])
  const latestRes = await client.query(
    `SELECT id
       FROM store_inventory_docs
      WHERE id LIKE $1
   ORDER BY id DESC
      LIMIT 1`,
    [`${prefix}-${ymd}-%`],
  )
  const latest = latestRes.rows[0]?.id
  const seq = latest ? Number(String(latest).slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function lockStockById(client, stockId, storeId) {
  const res = await client.query(
    `SELECT id, store_id, sku_id, sku_name, product_type, batch_no, expiry_date, quantity_on_hand
       FROM store_inventory_stocks
      WHERE id = $1 AND store_id = $2
      FOR UPDATE`,
    [stockId, storeId],
  )
  const r = res.rows[0]
  if (!r) throw new Error('NOT_FOUND: 库存记录不存在或不属于当前门店')
  return {
    id: Number(r.id),
    storeId: r.store_id,
    skuId: r.sku_id,
    skuName: r.sku_name,
    productType: r.product_type,
    batchNo: r.batch_no || '',
    expiryDate: r.expiry_date || null,
    quantityOnHand: Number(r.quantity_on_hand),
  }
}

async function ensureStockFromSku(client, storeId, item) {
  if (item.stockId) return lockStockById(client, item.stockId, storeId)
  const skuId = String(item.skuId || '').trim()
  if (!skuId) throw new Error('INVALID_PARAMS: 缺少 SKU 或库存记录')
  const skuRes = await client.query(
    `SELECT sku_id, spec_name, product_type
       FROM product_skus
      WHERE sku_id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [skuId],
  )
  const sku = skuRes.rows[0]
  if (!sku) throw new Error('NOT_FOUND: SKU 不存在或已删除')
  const batchNo = normalizeBatchNo(item.batchNo)
  const expiryDate = item.expiryDate || null
  const expiryDateKey = normalizeDateKey(expiryDate)
  const inserted = await client.query(
    `INSERT INTO store_inventory_stocks (
       store_id, sku_id, sku_name, product_type, batch_no, expiry_date, expiry_date_key, quantity_on_hand
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
     ON CONFLICT (store_id, sku_id, batch_no, expiry_date_key)
     DO UPDATE SET
       sku_name = EXCLUDED.sku_name,
       product_type = EXCLUDED.product_type,
       updated_at = NOW()
     RETURNING id`,
    [storeId, sku.sku_id, sku.spec_name, sku.product_type, batchNo, expiryDate, expiryDateKey],
  )
  return lockStockById(client, Number(inserted.rows[0].id), storeId)
}

async function applyMovement(client, params) {
  const before = Number(params.stock.quantityOnHand)
  const delta = params.direction === '入库' ? params.quantity : -params.quantity
  const after = before + delta
  if (after < 0) {
    throw new Error(`INVALID_STATE: 库存不足：${params.stock.skuName} 当前 ${before}`)
  }
  await client.query(
    `UPDATE store_inventory_stocks
        SET quantity_on_hand = $1,
            last_unit_price = COALESCE($2, last_unit_price),
            last_amount = COALESCE($3, last_amount),
            updated_at = NOW()
      WHERE id = $4`,
    [after, params.unitPrice ?? null, params.amount ?? null, params.stock.id],
  )
  await client.query(
    `INSERT INTO store_inventory_movements (
       movement_key, stock_id, store_id, sku_id, doc_id, doc_item_id,
       sale_order_id, sale_item_id, direction, quantity_delta,
       quantity_before, quantity_after, created_by, remark
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      params.movementKey,
      params.stock.id,
      params.stock.storeId,
      params.stock.skuId,
      params.docId,
      params.docItemId,
      params.saleOrderId || null,
      params.saleItemId || null,
      params.direction,
      delta,
      before,
      after,
      params.createdBy || null,
      params.remark || null,
    ],
  )
  params.stock.quantityOnHand = after
  return { before, after }
}

function buildStoreFilter(auth, cfg, paramIndexStart) {
  // 管理层（scopeStoreIds 全 null 或多店）→ ANY(array)；门店模式 → 单店等值或 OR
  const ids = auth.scopeStoreIds || []
  if (ids.length === 0) {
    return { sql: 'FALSE', params: [], nextIdx: paramIndexStart }
  }
  if (cfg.storeFilterMode === 'transfer') {
    return {
      sql: `(m.store_id = ANY($${paramIndexStart}::text[]) OR m.counterpart_store_id = ANY($${paramIndexStart}::text[]))`,
      params: [ids],
      nextIdx: paramIndexStart + 1,
    }
  }
  return {
    sql: `m.store_id = ANY($${paramIndexStart}::text[])`,
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
      conditions.push(`(m.store_id = $${idx} OR m.counterpart_store_id = $${idx})`)
    } else {
      conditions.push(`m.store_id = $${idx}`)
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
  const countSql = `SELECT COUNT(*)::int AS cnt FROM ${cfg.master} m ${whereSql}`

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

async function stockList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const {
    storeId,
    skuId,
    keyword,
    onlyPositive,
    page = 1,
    pageSize = 20,
  } = ctx.event.payload || {}
  const ids = ctx.auth.scopeStoreIds || []
  if (ids.length === 0) throw new Error('PERMISSION_DENIED: 当前账号无可见门店')
  if (storeId) requireStoreInScope(ctx.auth, storeId)

  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  const conditions = ['st.store_id = ANY($1::text[])']
  const params = [storeId ? [storeId] : ids]
  let idx = 2
  if (skuId) {
    conditions.push(`st.sku_id = $${idx}`)
    params.push(skuId)
    idx++
  }
  if (onlyPositive) {
    conditions.push('st.quantity_on_hand > 0')
  }
  if (keyword) {
    const escaped = String(keyword).replace(/[%_]/g, '\\$&')
    conditions.push(`(st.sku_id ILIKE $${idx} OR st.sku_name ILIKE $${idx} OR st.batch_no ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const rows = await pg.query(
    `SELECT st.id, st.store_id, s.store_name, st.sku_id, st.sku_name, st.product_type,
            st.batch_no, st.expiry_date, st.quantity_on_hand, st.remark, st.updated_at
       FROM store_inventory_stocks st
  LEFT JOIN stores s ON s.store_id = st.store_id
       ${whereSql}
   ORDER BY s.store_name, st.sku_name, st.batch_no
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt FROM store_inventory_stocks st ${whereSql}`,
    params,
  )
  ctx.result = {
    items: rows.map((r) => ({
      id: Number(r.id),
      storeId: r.store_id,
      storeName: r.store_name || null,
      skuId: r.sku_id,
      skuName: r.sku_name,
      productType: r.product_type,
      batchNo: r.batch_no || '',
      expiryDate: r.expiry_date || null,
      quantityOnHand: Number(r.quantity_on_hand),
      remark: r.remark || null,
      updatedAt: r.updated_at,
    })),
    total: countRows[0]?.cnt || 0,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit,
  }
  return ctx.result
}

async function docList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const {
    storeId,
    docType,
    status,
    startDate,
    endDate,
    keyword,
    page = 1,
    pageSize = 20,
  } = ctx.event.payload || {}
  const ids = ctx.auth.scopeStoreIds || []
  if (ids.length === 0) throw new Error('PERMISSION_DENIED: 当前账号无可见门店')
  if (storeId) requireStoreInScope(ctx.auth, storeId)

  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  const conditions = ['d.store_id = ANY($1::text[])']
  const params = [storeId ? [storeId] : ids]
  let idx = 2
  if (docType) {
    conditions.push(`d.doc_type = $${idx}`)
    params.push(docType)
    idx++
  }
  if (status) {
    conditions.push(`d.status = $${idx}`)
    params.push(status)
    idx++
  }
  if (startDate) {
    conditions.push(`d.doc_date >= $${idx}`)
    params.push(startDate)
    idx++
  }
  if (endDate) {
    conditions.push(`d.doc_date <= $${idx}`)
    params.push(endDate)
    idx++
  }
  if (keyword) {
    const escaped = String(keyword).replace(/[%_]/g, '\\$&')
    conditions.push(`(d.id ILIKE $${idx} OR d.customer_name ILIKE $${idx} OR d.remark ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const rows = await pg.query(
    `SELECT d.*, s.store_name
       FROM store_inventory_docs d
  LEFT JOIN stores s ON s.store_id = d.store_id
       ${whereSql}
   ORDER BY d.doc_date DESC, d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt FROM store_inventory_docs d ${whereSql}`,
    params,
  )
  ctx.result = {
    items: rows.map((r) => ({
      id: r.id,
      docType: r.doc_type,
      status: r.status,
      storeId: r.store_id,
      storeName: r.store_name || null,
      counterpartStoreId: r.counterpart_store_id || null,
      docDate: r.doc_date,
      totalQuantity: Number(r.total_quantity || 0),
      requestDocId: r.request_doc_id || null,
      relatedSaleOrderId: r.related_sale_order_id || null,
      customerName: r.customer_name || null,
      receiptAttachmentUrl: r.receipt_attachment_url || null,
      remark: r.remark || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: countRows[0]?.cnt || 0,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit,
  }
  return ctx.result
}

async function docDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { id } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少单据号')
  const ids = ctx.auth.scopeStoreIds || []
  const rows = await pg.query(
    `SELECT d.*, s.store_name
       FROM store_inventory_docs d
  LEFT JOIN stores s ON s.store_id = d.store_id
      WHERE d.id = $1 AND d.store_id = ANY($2::text[])
      LIMIT 1`,
    [id, ids],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 单据不存在或无权限')
  const r = rows[0]
  const items = await pg.query(
    `SELECT id, doc_id, stock_id, sku_id, sale_item_id, sku_name, batch_no, expiry_date,
            quantity, stock_snapshot, request_quantity, fulfilled_quantity,
            scrap_reason, item_usage, remark, created_at
       FROM store_inventory_doc_items
      WHERE doc_id = $1
   ORDER BY id`,
    [id],
  )
  ctx.result = {
    id: r.id,
    docType: r.doc_type,
    status: r.status,
    storeId: r.store_id,
    storeName: r.store_name || null,
    counterpartStoreId: r.counterpart_store_id || null,
    docDate: r.doc_date,
    totalQuantity: Number(r.total_quantity || 0),
    requestDocId: r.request_doc_id || null,
    relatedSaleOrderId: r.related_sale_order_id || null,
    customerName: r.customer_name || null,
    receiptAttachmentUrl: r.receipt_attachment_url || null,
    remark: r.remark || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    items: items.map((it) => ({
      id: Number(it.id),
      docId: it.doc_id,
      stockId: it.stock_id == null ? null : Number(it.stock_id),
      skuId: it.sku_id,
      saleItemId: it.sale_item_id || null,
      skuName: it.sku_name,
      batchNo: it.batch_no || '',
      expiryDate: it.expiry_date || null,
      quantity: Number(it.quantity),
      stockSnapshot: it.stock_snapshot == null ? null : Number(it.stock_snapshot),
      requestQuantity: it.request_quantity == null ? null : Number(it.request_quantity),
      fulfilledQuantity: it.fulfilled_quantity == null ? null : Number(it.fulfilled_quantity),
      scrapReason: it.scrap_reason || null,
      itemUsage: it.item_usage || null,
      remark: it.remark || null,
      createdAt: it.created_at,
    })),
  }
  return ctx.result
}

async function createDoc(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const payload = ctx.event.payload || {}
  const { docType, items = [] } = payload
  if (!isValidDocType(docType)) throw new Error('INVALID_PARAMS: 无效库存单据类型')
  if (!Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 至少需要一条明细')
  const storeId = await resolveInventoryWriteStoreId(ctx, payload)
  const status = defaultDocStatus(docType)
  const totalQuantity = items.reduce((acc, item) => acc + assertQty(item.quantity), 0)
  let docId

  await pg.transaction(async (client) => {
    docId = await generateDocNo(client, docType)
    await client.query(
      `INSERT INTO store_inventory_docs (
         id, doc_type, status, store_id, counterpart_store_id, doc_date, total_quantity,
         request_doc_id, related_sale_order_id, client_user_id, customer_name,
         receipt_attachment_url, remark, created_by, confirmed_by, confirmed_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               CASE WHEN $16::boolean THEN NOW() ELSE NULL END)`,
      [
        docId,
        docType,
        status,
        storeId,
        payload.counterpartStoreId || null,
        payload.docDate || shanghaiToday(),
        totalQuantity,
        payload.requestDocId || null,
        payload.relatedSaleOrderId || null,
        payload.clientUserId || null,
        payload.customerName || null,
        payload.receiptAttachmentUrl || null,
        payload.remark || null,
        ctx.auth.staffWfId,
        status === '已完成' || status === '待收货' ? ctx.auth.staffWfId : null,
        status === '已完成' || status === '待收货',
      ],
    )
    const direction = status === '草稿' || status === '待审批' ? null : movementDirection(docType)
    for (const item of items) {
      const qty = assertQty(item.quantity)
      const stock = await ensureStockFromSku(client, storeId, item)
      const inserted = await client.query(
        `INSERT INTO store_inventory_doc_items (
           doc_id, stock_id, sku_id, sale_item_id, sku_name, batch_no, expiry_date,
           quantity, stock_snapshot, request_quantity, fulfilled_quantity,
           scrap_reason, item_usage, remark
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          docId,
          stock.id,
          stock.skuId,
          item.saleItemId || null,
          stock.skuName,
          stock.batchNo,
          stock.expiryDate,
          qty,
          stock.quantityOnHand,
          item.requestQuantity || null,
          item.fulfilledQuantity || null,
          item.scrapReason || null,
          item.itemUsage || null,
          item.remark || null,
        ],
      )
      if (direction) {
        await applyMovement(client, {
          stock,
          docId,
          docItemId: Number(inserted.rows[0].id),
          direction,
          quantity: qty,
          createdBy: ctx.auth.staffWfId,
          movementKey: `doc:${docId}:item:${inserted.rows[0].id}`,
          saleOrderId: payload.relatedSaleOrderId || null,
          saleItemId: item.saleItemId || null,
          remark: payload.remark || null,
        })
      }
    }
  })

  ctx.result = { id: docId, message: '提交成功' }
  return ctx.result
}

async function approveDoc(ctx) {
  await requireStaffBound()(ctx, async () => {})
  assertApprover(ctx)
  const { id, auditRemark } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少单据号')
  await pg.transaction(async (client) => {
    const headRes = await client.query(
      `SELECT id, doc_type, status, store_id, related_sale_order_id
         FROM store_inventory_docs
        WHERE id = $1
        FOR UPDATE`,
      [id],
    )
    const head = headRes.rows[0]
    if (!head) throw new Error('NOT_FOUND: 单据不存在')
    await assertApproverStoreScope(client, ctx.auth, head.store_id)
    if (head.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以审批')
    const direction = approvalMovementDirection(head.doc_type)
    if (!direction) throw new Error('INVALID_STATE: 该单据类型不需要审批')
    const itemRes = await client.query(
      `SELECT id, stock_id, quantity, sale_item_id
         FROM store_inventory_doc_items
        WHERE doc_id = $1
     ORDER BY id`,
      [id],
    )
    for (const item of itemRes.rows) {
      const stock = await lockStockById(client, Number(item.stock_id), head.store_id)
      await applyMovement(client, {
        stock,
        docId: id,
        docItemId: Number(item.id),
        direction,
        quantity: Number(item.quantity),
        createdBy: ctx.auth.staffWfId,
        movementKey: `approve:${id}:item:${item.id}`,
        saleOrderId: head.related_sale_order_id || null,
        saleItemId: item.sale_item_id || null,
        remark: auditRemark || null,
      })
    }
    await client.query(
      `UPDATE store_inventory_docs
          SET status = '已完成',
              approved_by = $2,
              approved_at = NOW(),
              audit_remark = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, ctx.auth.staffWfId, auditRemark || null],
    )
  })
  ctx.result = { message: '审批通过' }
  return ctx.result
}

async function rejectDoc(ctx) {
  await requireStaffBound()(ctx, async () => {})
  assertApprover(ctx)
  const { id, auditRemark } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少单据号')
  await pg.transaction(async (client) => {
    const headRes = await client.query(
      `SELECT store_id, status
         FROM store_inventory_docs
        WHERE id = $1
        FOR UPDATE`,
      [id],
    )
    const doc = headRes.rows[0]
    if (!doc) throw new Error('NOT_FOUND: 单据不存在')
    await assertApproverStoreScope(client, ctx.auth, doc.store_id)
    if (doc.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以驳回')
    await client.query(
      `UPDATE store_inventory_docs
          SET status = '已驳回',
              rejected_by = $2,
              rejected_at = NOW(),
              audit_remark = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, ctx.auth.staffWfId, auditRemark || null],
    )
  })
  ctx.result = { message: '已驳回' }
  return ctx.result
}

async function confirmReceive(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { id, remark } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少调拨出库单号')
  let inboundDocId
  await pg.transaction(async (client) => {
    const headRes = await client.query(
      `SELECT id, status, store_id, counterpart_store_id, total_quantity, remark
         FROM store_inventory_docs
        WHERE id = $1 AND doc_type = '分院调货出库'
        FOR UPDATE`,
      [id],
    )
    const head = headRes.rows[0]
    if (!head) throw new Error('NOT_FOUND: 调拨出库单不存在')
    if (head.status !== '待收货') throw new Error('INVALID_STATE: 该调拨单不是待收货状态')
    if (!head.counterpart_store_id) throw new Error('INVALID_STATE: 调拨单缺少接收门店')
    await assertInventoryWriteStoreScope(client, ctx.auth, head.counterpart_store_id)
    inboundDocId = await generateDocNo(client, '分院调货入库')
    await client.query(
      `INSERT INTO store_inventory_docs (
         id, doc_type, status, store_id, counterpart_store_id, doc_date, total_quantity,
         request_doc_id, remark, created_by, confirmed_by, confirmed_at
       )
       VALUES ($1,'分院调货入库','已完成',$2,$3,$4,$5,$6,$7,$8,$8,NOW())`,
      [
        inboundDocId,
        head.counterpart_store_id,
        head.store_id,
        shanghaiToday(),
        head.total_quantity,
        id,
        remark || head.remark || null,
        ctx.auth.staffWfId,
      ],
    )
    const itemRes = await client.query(
      `SELECT sku_id, batch_no, expiry_date, quantity, remark
         FROM store_inventory_doc_items
        WHERE doc_id = $1
     ORDER BY id`,
      [id],
    )
    for (const item of itemRes.rows) {
      const stock = await ensureStockFromSku(client, head.counterpart_store_id, {
        skuId: item.sku_id,
        batchNo: item.batch_no,
        expiryDate: item.expiry_date,
        quantity: item.quantity,
      })
      const inserted = await client.query(
        `INSERT INTO store_inventory_doc_items (
           doc_id, stock_id, sku_id, sku_name, batch_no, expiry_date,
           quantity, stock_snapshot, remark
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          inboundDocId,
          stock.id,
          stock.skuId,
          stock.skuName,
          stock.batchNo,
          stock.expiryDate,
          item.quantity,
          stock.quantityOnHand,
          item.remark || null,
        ],
      )
      await applyMovement(client, {
        stock,
        docId: inboundDocId,
        docItemId: Number(inserted.rows[0].id),
        direction: '入库',
        quantity: Number(item.quantity),
        createdBy: ctx.auth.staffWfId,
        movementKey: `receive:${id}:item:${inserted.rows[0].id}`,
        remark: remark || null,
      })
    }
    await client.query(
      `UPDATE store_inventory_docs
          SET status = '已完成',
              confirmed_by = $2,
              confirmed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [id, ctx.auth.staffWfId],
    )
  })
  ctx.result = { inboundDocId, message: '收货成功' }
  return ctx.result
}

async function uploadReceipt(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { id, fileBase64, ext = 'jpg' } = ctx.event.payload || {}
  if (!id || !fileBase64) throw new Error('INVALID_PARAMS: 缺少单据号或附件内容')
  const rows = await pg.query(
    `SELECT store_id FROM store_inventory_docs WHERE id = $1 LIMIT 1`,
    [id],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 单据不存在')
  await assertInventoryWriteStoreScope(pg, ctx.auth, rows[0].store_id)
  const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg'
  const buffer = Buffer.from(String(fileBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
  const upload = await cloud.uploadFile({
    cloudPath: `inventory-receipts/${id}-${Date.now()}.${safeExt}`,
    fileContent: buffer,
  })
  await pg.query(
    `UPDATE store_inventory_docs
        SET receipt_attachment_url = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, upload.fileID],
  )
  ctx.result = { fileID: upload.fileID }
  return ctx.result
}

module.exports = {
  list,
  detail,
  stockList,
  docList,
  docDetail,
  createDoc,
  confirmReceive,
  approveDoc,
  rejectDoc,
  uploadReceipt,
}
