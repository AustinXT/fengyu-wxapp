/**
 * 门店库存路由（员工端）
 *
 * staff 端仅呈现门店层级库存，不暴露市场/总部库存主体，不返回价格/金额字段。
 * 仅提供 v3 单据和库存接口，禁止回退到 store_inventory_* 旧库存域。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')
const { expandScopeStoreIds } = require('../utils/scope')
const cloud = require('wx-server-sdk')

const VALID_STORE_SCOPE_TYPES = new Set(['总部', '市场', '门店'])
const WORKFINE_INVENTORY_CUTOVER_KEY = 'workfine_inventory'
const WORKFINE_INVENTORY_INITIALIZED_STATUS = '已初始化'

const DOC_PREFIX = {
  '门店报货': 'DBH',
  '市场报货': 'MBH',
  '品项公司报货需求': 'ZBH',
  '采购订单': 'CGD',
  '供应链采购订单': 'PCG',
  '供应链采购入库': 'GRK',
  '品项公司发货': 'GFH',
  '市场采购入库': 'MRK',
  '自采产品入库': 'ZRK',
  '分院配货': 'FPH',
  '院入库': 'YRK',
  '分院调货出库': 'DTO',
  '分院调货入库': 'DTI',
  '市场间调货出库': 'MTO',
  '市场间调货入库': 'MTI',
  '员工购出库': 'YGG',
  '供应链员工购出库': 'GYG',
  '内部领用': 'NLY',
  '非凤御市场出库': 'FFY',
  '院顾客退货': 'GTH',
  '市场退货': 'MTH',
  '市场退货入库': 'MTR',
  '供应链退货入库': 'GTR',
  '院退货': 'YTH',
  '院顾客产品出库': 'GCK',
  '市场产品报损': 'MBS',
  '院产品报损': 'YBS',
  '市场产品盘溢': 'MPY',
  '市场库存盘点': 'MPD',
  '分院库存盘点': 'YPD',
  '库存转换出库': 'ZHO',
  '库存转换入库': 'ZHI',
  '期初库存': 'QC',
}

const STAFF_VISIBLE_DOC_TYPES = new Set([
  '门店报货',
  '分院配货',
  '院入库',
  '分院调货出库',
  '分院调货入库',
  '院顾客退货',
  '院退货',
  '院顾客产品出库',
  '院产品报损',
  '分院库存盘点',
  '期初库存',
])
const STAFF_CREATE_DOC_TYPES = new Set([
  '门店报货',
  '分院调货出库',
  '院顾客退货',
  '院退货',
  '院顾客产品出库',
  '院产品报损',
  '分院库存盘点',
])
const STAFF_RECEIVE_DOC_TYPES = new Set(['分院配货', '分院调货出库'])
const STAFF_VISIBLE_DOC_TYPE_LIST = Array.from(STAFF_VISIBLE_DOC_TYPES)

const NO_MOVEMENT_DOC_TYPES = new Set(['门店报货', '市场报货', '品项公司报货需求', '采购订单', '供应链采购订单'])
const RECEIVE_REQUIRED_DOC_TYPES = new Set(['品项公司发货', '分院配货', '分院调货出库', '市场间调货出库'])
const APPROVAL_DOC_TYPES = new Set(['市场退货', '院退货', '市场产品报损', '院产品报损'])
const INBOUND_DOC_TYPES = new Set([
  '供应链采购入库',
  '市场采购入库',
  '自采产品入库',
  '院入库',
  '分院调货入库',
  '市场间调货入库',
  '院顾客退货',
  '市场退货入库',
  '供应链退货入库',
  '市场产品盘溢',
  '库存转换入库',
  '期初库存',
])
const OUTBOUND_DOC_TYPES = new Set([
  '员工购出库',
  '供应链员工购出库',
  '内部领用',
  '非凤御市场出库',
  '市场退货',
  '院退货',
  '院顾客产品出库',
  '市场产品报损',
  '院产品报损',
  '库存转换出库',
])
const RECEIVE_INBOUND_TYPE = {
  '品项公司发货': '市场采购入库',
  '分院配货': '院入库',
  '分院调货出库': '分院调货入库',
  '市场间调货出库': '市场间调货入库',
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

/**
 * WorkFine 期初库存必须完成导入和核验后，才允许产生新的库存业务流水。
 * 在调用方事务内以行锁读取，避免受控重置与库存写入并发交错。
 */
async function assertWorkfineInventoryInitialized(client) {
  const result = await client.query(
    `SELECT status
       FROM inventory_cutover_states
      WHERE cutover_key = $1
      FOR KEY SHARE`,
    [WORKFINE_INVENTORY_CUTOVER_KEY],
  )
  const state = result.rows[0]
  if (!state || state.status !== WORKFINE_INVENTORY_INITIALIZED_STATUS) {
    throw new Error('INVALID_STATE: WorkFine 库存期初尚未完成核验，暂不允许写入库存')
  }
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

function assertNoStaffMoneyFields(payload) {
  const seen = new WeakSet()
  const hasMoneyField = (value) => {
    if (!value || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(hasMoneyField)
    return Object.entries(value).some(([key, child]) => (
      /price|amount|cost|discount|money|金额|价格/i.test(key)
      || hasMoneyField(child)
    ))
  }
  if (hasMoneyField(payload)) {
    throw new Error('INVALID_PARAMS: staff 端不允许提交金额字段')
  }
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
  if (APPROVAL_DOC_TYPES.has(docType)) return '待审批'
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType)) return '待收货'
  return '已完成'
}

function movementDirection(docType) {
  if (INBOUND_DOC_TYPES.has(docType)) return '入库'
  if (OUTBOUND_DOC_TYPES.has(docType) || RECEIVE_REQUIRED_DOC_TYPES.has(docType)) return '出库'
  return null
}

function approvalMovementDirection(docType) {
  return APPROVAL_DOC_TYPES.has(docType) ? '出库' : null
}

function roleBindingsForAction(auth, action) {
  return (auth.roleBindings || []).filter((rb) => (
    rb
    && (rb.isSuperAdmin || (Array.isArray(rb.actions) && rb.actions.includes(action)))
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
  const bindings = roleBindingsForAction(auth, 'inventory:store_operate')
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

async function assertAnyInventoryWriteStoreScope(client, auth, storeIds) {
  const requestedStoreIds = Array.from(new Set((storeIds || []).filter(Boolean)))
  if (requestedStoreIds.length === 0) throw new Error('INVALID_PARAMS: 缺少门店')
  const bindings = roleBindingsForAction(auth, 'inventory:store_operate')
  if (bindings.length === 0) {
    throw new Error('PERMISSION_DENIED: 无库存写入权限')
  }
  const coveredStoreIds = await expandScopeStoreIds(bindings, client)
  if (!requestedStoreIds.some((storeId) => coveredStoreIds.includes(storeId))) {
    throw new Error('PERMISSION_DENIED: 无权操作该门店库存')
  }
}

function assertApprover(ctx) {
  const bindings = approverBindingsFor(ctx.auth)
  if (bindings.length === 0) {
    throw new Error('PERMISSION_DENIED: 仅市场财务或管理员可审批库存单据')
  }
}

function approverBindingsFor(auth) {
  return roleBindingsForAction(auth, 'inventory:market_approve')
}

async function assertApproverStoreScope(client, auth, storeId) {
  await assertStoreCoveredByBindings(
    client,
    approverBindingsFor(auth),
    storeId,
    'PERMISSION_DENIED: 无权审批该门店库存单据',
  )
}

function isStaffVisibleDocType(docType) {
  return STAFF_VISIBLE_DOC_TYPES.has(docType)
}

function isStaffCreateDocType(docType) {
  return STAFF_CREATE_DOC_TYPES.has(docType)
}

async function generateDocNo(client, docType) {
  const prefix = DOC_PREFIX[docType]
  const ymd = shanghaiYmd()
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    `inventory_docs:${prefix}:${ymd}`,
  ])
  const latestRes = await client.query(
    `SELECT id
       FROM inventory_docs
      WHERE id LIKE $1
   ORDER BY id DESC
      LIMIT 1`,
    [`${prefix}-${ymd}-%`],
  )
  const latest = latestRes.rows[0]?.id
  const seq = latest ? Number(String(latest).slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

// client 可选：事务内必须传入 tx client——否则 UPSERT 走全局池第二连接，
// 会与事务已锁的 inventory_locations 行互相等待（自锁挂到云函数超时）。
// 热路径短路：migration 0009 的 org_nodes / stores 触发器（INSERT + 相关列 UPDATE）
// 已实时维护 inventory_locations，本函数只是漂移自愈兜底。先跑只读反连接探测，
// 无缺失/漂移时跳过两条全表 UPSERT；探测无结果或结果异常时保守回退旧行为。
// ⚠ 与 admin engine.ts 的 syncInventoryLocations 保持字面一致（各自副本，
// 由 cross-end-inventory-snapshot.test.js 守护）。
async function syncInventoryLocations(client = null) {
  const q = client || pg
  const probeRows = await queryRows(client, `
    SELECT EXISTS (
      SELECT 1
        FROM org_nodes o
        LEFT JOIN inventory_locations loc ON loc.location_id = o.id
       WHERE o.type IN ('总部','市场')
         AND (loc.location_id IS NULL
           OR loc.location_type IS DISTINCT FROM o.type
           OR loc.name IS DISTINCT FROM o.name
           OR loc.org_node_id IS DISTINCT FROM o.id
           OR loc.parent_location_id IS DISTINCT FROM o.parent_id
           OR loc.is_active IS DISTINCT FROM o.is_active)
      UNION ALL
      SELECT 1
        FROM stores s
        LEFT JOIN org_nodes o ON o.id = s.org_node_id
        LEFT JOIN inventory_locations loc ON loc.location_id = s.store_id
       WHERE loc.location_id IS NULL
         OR loc.location_type IS DISTINCT FROM '门店'
         OR loc.name IS DISTINCT FROM s.store_name
         OR loc.org_node_id IS DISTINCT FROM s.org_node_id
         OR loc.store_id IS DISTINCT FROM s.store_id
         OR loc.parent_location_id IS DISTINCT FROM o.parent_id
         OR loc.is_active IS DISTINCT FROM (COALESCE(o.is_active, false) AND NOT s.is_closed)
    ) AS drifted
  `, [])
  if (probeRows?.[0]?.drifted === false) return
  await q.query(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id, is_active)
    SELECT id, type, name, id, parent_id, is_active
      FROM org_nodes
     WHERE type IN ('总部','市场')
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
  `)
  await q.query(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active)
    SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id,
           COALESCE(o.is_active, false) AND NOT s.is_closed
      FROM stores s
      LEFT JOIN org_nodes o ON o.id = s.org_node_id
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
  `)
}

function scopedInventoryLocationIds(auth) {
  return Array.from(new Set((auth.inventoryStoreIds || []).filter(Boolean)))
}

// 组织树后代展开（带 path 环守卫，写法对齐 utils/scope.js 的 descendants CTE）。
// 返回可内联的 IN (...) 片段；调用方按 startIndex 顺序追加 orgNodeId 参数。
// org_nodes 万一成环时靠 NOT id = ANY(path) 终止，而不是无限递归拖死云函数。
function descendantOrgNodeIdsSql(startIndex) {
  return `(
    WITH RECURSIVE selected(id, path) AS (
      SELECT id, ARRAY[id] FROM org_nodes WHERE id = $${startIndex}
      UNION ALL
      SELECT child.id, selected.path || child.id
        FROM org_nodes child
        JOIN selected ON child.parent_id = selected.id
       WHERE NOT child.id = ANY(selected.path)
    )
    SELECT id FROM selected WHERE id IN (SELECT org_node_id FROM inventory_locations)
  )`
}

function buildInventoryLocationScope(auth, alias, startIndex) {
  const ids = scopedInventoryLocationIds(auth)
  if (ids.length === 0) return { sql: 'FALSE', params: [], nextIdx: startIndex }
  return {
    sql: `(
      ${alias}.source_org_node_id IN (
        SELECT org_node_id FROM inventory_locations WHERE location_id = ANY($${startIndex}::text[])
      )
      OR ${alias}.target_org_node_id IN (
        SELECT org_node_id FROM inventory_locations WHERE location_id = ANY($${startIndex}::text[])
      )
    )`,
    params: [ids],
    nextIdx: startIndex + 1,
  }
}

function requireInventoryLocationInScope(auth, locationId) {
  if (!locationId) throw new Error('INVALID_PARAMS: 缺少库存主体')
  const ids = scopedInventoryLocationIds(auth)
  if (!ids.includes(locationId)) {
    throw new Error('PERMISSION_DENIED: 无权操作该库存主体')
  }
}

function requireAnyInventoryLocationInScope(auth, locationIds) {
  const validLocationIds = locationIds.filter(Boolean)
  if (validLocationIds.length === 0) throw new Error('INVALID_PARAMS: 缺少库存主体')
  const ids = scopedInventoryLocationIds(auth)
  if (!validLocationIds.some((locationId) => ids.includes(locationId))) {
    throw new Error('PERMISSION_DENIED: 无权操作该库存主体')
  }
}

// pg.query 返回 rows 数组、tx client.query 返回完整 result——统一取 rows。
function queryRows(client, sql, params) {
  return client ? client.query(sql, params).then((res) => res.rows) : pg.query(sql, params)
}

async function ensureInventoryLocation(locationId, requiredType = null, client = null) {
  await syncInventoryLocations(client)
  const rows = await queryRows(
    client,
    `SELECT location_id, location_type, parent_location_id, is_active, org_node_id
       FROM inventory_locations
      WHERE location_id = $1 OR org_node_id = $1
      LIMIT 1`,
    [locationId],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 库存主体不存在')
  const row = rows[0]
  if (row.is_active === false) throw new Error('INVALID_STATE: 库存主体已停用')
  if (requiredType && row.location_type !== requiredType) {
    throw new Error(`INVALID_PARAMS: 库存主体必须是${requiredType}`)
  }
  return {
    ...row,
    location_id: row.location_id || locationId,
    org_node_id: row.org_node_id || locationId,
  }
}

async function ensureStoreLocation(locationId, client = null) {
  return ensureInventoryLocation(locationId, '门店', client)
}

async function ensureSameMarketStores(sourceOrgNodeId, targetOrgNodeId) {
  if (sourceOrgNodeId === targetOrgNodeId) {
    throw new Error('INVALID_PARAMS: 调拨接收门店不能与发起门店相同')
  }
  const rows = await pg.query(
    `SELECT s.location_id, s.parent_location_id, s.location_type, s.is_active
       FROM inventory_locations s
      WHERE s.location_id = ANY($1::text[])
      ORDER BY s.location_id`,
    [[sourceOrgNodeId, targetOrgNodeId]],
  )
  if (rows.length !== 2) throw new Error('NOT_FOUND: 调拨门店不存在')
  const byId = new Map(rows.map((row) => [row.location_id, row]))
  const source = byId.get(sourceOrgNodeId)
  const target = byId.get(targetOrgNodeId)
  if (!source || !target) throw new Error('NOT_FOUND: 调拨门店不存在')
  if (source.location_type !== '门店' || target.location_type !== '门店') {
    throw new Error('INVALID_PARAMS: 调拨只能发生在门店之间')
  }
  if (source.is_active === false || target.is_active === false) {
    throw new Error('INVALID_STATE: 调拨门店已停用')
  }
  if (!source.parent_location_id || !target.parent_location_id) {
    throw new Error('PERMISSION_DENIED: 调拨门店必须属于同一市场')
  }
  if ((source.parent_location_id || '') !== (target.parent_location_id || '')) {
    throw new Error('PERMISSION_DENIED: 调拨门店必须属于同一市场')
  }
}

async function resolveStaffCreateLocations(ctx, payload) {
  const scopedStoreIds = scopedInventoryLocationIds(ctx.auth)
  const fallbackStoreId =
    payload.storeId ||
    payload.locationId ||
    ctx.auth.effectiveStoreId ||
    (scopedStoreIds.length === 1 ? scopedStoreIds[0] : null)

  let sourceEndpointId = payload.sourceOrgNodeId || null
  let targetEndpointId = payload.targetOrgNodeId || null
  let marketId = null

  switch (payload.docType) {
    case '门店报货':
      sourceEndpointId = sourceEndpointId || fallbackStoreId
      // 门店报货的市场归属由发起门店的组织父级确定，不能相信客户端提交的主体。
      // 市场汇总和分院配货均依赖该关联，故同时保存 target_org_node_id 与 market_id。
      targetEndpointId = null
      break
    case '分院调货出库':
      sourceEndpointId = sourceEndpointId || fallbackStoreId
      if (!targetEndpointId) throw new Error('INVALID_PARAMS: 调货出库缺少接收门店')
      break
    case '院顾客退货':
      sourceEndpointId = null
      targetEndpointId = targetEndpointId || fallbackStoreId
      break
    case '院退货':
    case '院顾客产品出库':
    case '院产品报损':
      sourceEndpointId = sourceEndpointId || fallbackStoreId
      targetEndpointId = null
      break
    case '分院库存盘点':
      sourceEndpointId = sourceEndpointId || fallbackStoreId
      targetEndpointId = null
      break
    default:
      throw new Error('INVALID_PARAMS: staff 端不支持创建该库存单据')
  }

  const sourceLocation = sourceEndpointId ? await ensureStoreLocation(sourceEndpointId) : null
  let targetLocation = targetEndpointId ? await ensureStoreLocation(targetEndpointId) : null
  const actingLocationId = sourceLocation?.location_id || targetLocation?.location_id
  await assertInventoryWriteStoreScope(pg, ctx.auth, actingLocationId)
  if (payload.docType === '门店报货') {
    marketId = sourceLocation?.parent_location_id || null
    if (!marketId) throw new Error('INVALID_STATE: 门店未归属市场，不能提交报货')
    targetLocation = await ensureInventoryLocation(marketId, '市场')
  } else if (payload.docType === '院退货') {
    // 门店退货只能回到所属市场，客户端不能指定或伪造回库主体。
    marketId = sourceLocation?.parent_location_id || null
    if (!marketId) throw new Error('INVALID_STATE: 门店未归属市场，不能提交退货')
    targetLocation = await ensureInventoryLocation(marketId, '市场')
  }
  if (payload.docType === '分院调货出库') {
    await ensureSameMarketStores(sourceLocation.location_id, targetLocation.location_id)
  }
  let sourceOrgNodeId = sourceLocation?.org_node_id || null
  let targetOrgNodeId = targetLocation?.org_node_id || null
  if (['院产品报损', '分院库存盘点'].includes(payload.docType)) {
    const orgNodeId = sourceOrgNodeId || targetOrgNodeId
    sourceOrgNodeId = orgNodeId
    targetOrgNodeId = orgNodeId
  }
  return {
    sourceOrgNodeId,
    targetOrgNodeId,
    sourceLocationId: sourceLocation?.location_id || null,
    targetLocationId: targetLocation?.location_id || null,
    marketId,
    actingLocationId,
  }
}

function actingLocationId(payload) {
  const docType = payload.docType
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType) || OUTBOUND_DOC_TYPES.has(docType)) {
    return payload.sourceOrgNodeId || payload.locationId || payload.storeId || null
  }
  if (INBOUND_DOC_TYPES.has(docType)) {
    return payload.targetOrgNodeId || payload.locationId || payload.storeId || null
  }
  return payload.sourceOrgNodeId || payload.targetOrgNodeId || payload.locationId || payload.storeId || null
}

function movementPlan(docType, status) {
  if (['草稿', '待审批', '已驳回', '已取消'].includes(status)) return null
  if (NO_MOVEMENT_DOC_TYPES.has(docType)) return null
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType)) return { role: 'source', direction: '出库' }
  if (INBOUND_DOC_TYPES.has(docType)) return { role: 'target', direction: '入库' }
  if (OUTBOUND_DOC_TYPES.has(docType)) return { role: 'source', direction: '出库' }
  return null
}

function moneyOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function lotKey(skuId, item) {
  const priceKey = (v) => {
    const n = moneyOrNull(v)
    return n == null ? '' : n.toFixed(4)
  }
  return [
    skuId,
    normalizeBatchNo(item.batchNo),
    normalizeDateKey(item.expiryDate),
    item.isGift ? 'gift' : 'normal',
    priceKey(item.supplyChainUnitCost),
    priceKey(item.marketActualUnitPrice),
    priceKey(item.storeActualUnitPrice),
    `supplier:${item.supplierId || item.supplier || ''}`,
    `source:${item.sourceDocId || ''}`,
  ].join('|')
}

async function lockInventoryLotById(client, lotId, locationId) {
  const res = await client.query(
    `SELECT id, location_id, sku_id, sku_name, spec_name, supplier, supplier_id, product_series,
            batch_no, expiry_date, is_gift, quantity_on_hand,
            supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
            market_actual_unit_price, store_standard_unit_price, store_unit_discount,
            store_actual_unit_price, source_doc_id
       FROM inventory_stock_lots
      WHERE id = $1
        AND ($2::text IS NULL OR location_id = $2)
      FOR UPDATE`,
    [lotId, locationId || null],
  )
  const r = res.rows[0]
  if (!r) throw new Error('NOT_FOUND: 库存批次不存在或不属于当前库存主体')
  return {
    id: Number(r.id),
    locationId: r.location_id,
    skuId: r.sku_id,
    skuName: r.sku_name,
    specName: r.spec_name || null,
    supplier: r.supplier || null,
    supplierId: r.supplier_id || null,
    productSeries: r.product_series || null,
    batchNo: r.batch_no || '',
    expiryDate: r.expiry_date || null,
    isGift: Boolean(r.is_gift),
    quantityOnHand: Number(r.quantity_on_hand),
    supplyChainUnitCost: moneyOrNull(r.supply_chain_unit_cost),
    marketStandardUnitPrice: moneyOrNull(r.market_standard_unit_price),
    marketUnitDiscount: moneyOrNull(r.market_unit_discount),
    marketActualUnitPrice: moneyOrNull(r.market_actual_unit_price),
    storeStandardUnitPrice: moneyOrNull(r.store_standard_unit_price),
    storeUnitDiscount: moneyOrNull(r.store_unit_discount),
    storeActualUnitPrice: moneyOrNull(r.store_actual_unit_price),
    sourceDocId: r.source_doc_id || null,
  }
}

async function inventorySkuSnapshot(client, skuId) {
  const res = await client.query(
    `SELECT sku_id, product_name, spec_name, supplier, product_series
       FROM inventory_skus
      WHERE sku_id = $1 AND is_active = true
      LIMIT 1`,
    [skuId],
  )
  const r = res.rows[0]
  if (!r) throw new Error('NOT_FOUND: 库存 SKU 不存在或已停用')
  return {
    skuId: r.sku_id,
    skuName: r.product_name,
    specName: r.spec_name || null,
    supplier: r.supplier || null,
    productSeries: r.product_series || null,
  }
}

async function assertSkuAvailableAtLocation(client, sku, locationId) {
  const sourceType = sku.source_type || '供应链'
  if (sourceType === '供应链') return
  const locationRes = await client.query(
    `SELECT location_id, location_type, parent_location_id
       FROM inventory_locations
      WHERE location_id = $1
      LIMIT 1`,
    [locationId],
  )
  const location = locationRes.rows[0]
  if (!location) throw new Error('NOT_FOUND: 库存主体不存在')
  const marketId = location.location_type === '市场'
    ? location.location_id
    : location.location_type === '门店'
      ? location.parent_location_id
      : null
  if (!marketId || sku.owner_market_id !== marketId) {
    throw new Error(`INVALID_STATE: ${sourceType} SKU ${sku.product_name} 仅可在归属市场使用`)
  }
}

async function ensureInventoryLotFromSku(client, locationId, item, trace, priceSnapshot = {}) {
  const skuId = String(item.skuId || '').trim()
  if (!skuId) throw new Error('INVALID_PARAMS: 缺少库存 SKU')
  const skuRes = await client.query(
    `SELECT sku_id, product_name, spec_name, supplier, product_series,
            source_type, owner_market_id, supply_chain_purchase_price,
            market_purchase_price, store_purchase_price
       FROM inventory_skus
      WHERE sku_id = $1 AND is_active = true
      LIMIT 1`,
    [skuId],
  )
  const sku = skuRes.rows[0]
  if (!sku) throw new Error('NOT_FOUND: 库存 SKU 不存在或已停用')
  await assertSkuAvailableAtLocation(client, sku, locationId)
  const batchNo = normalizeBatchNo(item.batchNo)
  const expiryDate = item.expiryDate || null
  const supplyChainUnitCost = moneyOrNull(priceSnapshot.supplyChainUnitCost) ?? moneyOrNull(sku.supply_chain_purchase_price)
  const marketStandardUnitPrice = moneyOrNull(priceSnapshot.marketStandardUnitPrice) ?? moneyOrNull(sku.market_purchase_price)
  const marketUnitDiscount = moneyOrNull(priceSnapshot.marketUnitDiscount)
  const marketActualUnitPrice = moneyOrNull(priceSnapshot.marketActualUnitPrice) ?? (
    marketStandardUnitPrice == null ? null : marketStandardUnitPrice - Number(marketUnitDiscount || 0)
  )
  const storeStandardUnitPrice = moneyOrNull(priceSnapshot.storeStandardUnitPrice) ?? moneyOrNull(sku.store_purchase_price)
  const storeUnitDiscount = moneyOrNull(priceSnapshot.storeUnitDiscount)
  const storeActualUnitPrice = moneyOrNull(priceSnapshot.storeActualUnitPrice) ?? (
    storeStandardUnitPrice == null ? null : storeStandardUnitPrice - Number(storeUnitDiscount || 0)
  )
  const sourceDocId = String(trace?.sourceDocId || '').trim()
  if (!sourceDocId) throw new Error('INVALID_PARAMS: 缺少批次来源单据')
  const supplierId = String(trace?.supplierId || '').trim() || null
  const supplier = String(trace?.supplier || '').trim() || sku.supplier || null
  const key = lotKey(skuId, {
    ...item,
    batchNo,
    expiryDate,
    supplyChainUnitCost,
    marketActualUnitPrice,
    storeActualUnitPrice,
    supplier,
    supplierId,
    sourceDocId,
  })
  const inserted = await client.query(
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, spec_name, supplier, supplier_id, product_series,
       batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
       supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
       market_actual_unit_price, store_standard_unit_price, store_unit_discount,
       store_actual_unit_price, source_doc_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (location_id, lot_key)
     DO UPDATE SET
       sku_name = EXCLUDED.sku_name,
       spec_name = EXCLUDED.spec_name,
       supplier = EXCLUDED.supplier,
       supplier_id = COALESCE(EXCLUDED.supplier_id, inventory_stock_lots.supplier_id),
       product_series = EXCLUDED.product_series,
       updated_at = NOW()
     RETURNING id`,
    [
      locationId,
      sku.sku_id,
      key,
      sku.product_name,
      sku.spec_name,
      supplier,
      supplierId,
      sku.product_series,
      batchNo,
      expiryDate,
      expiryDate || '',
      Boolean(item.isGift),
      supplyChainUnitCost,
      marketStandardUnitPrice,
      marketUnitDiscount,
      marketActualUnitPrice,
      storeStandardUnitPrice,
      storeUnitDiscount,
      storeActualUnitPrice,
      sourceDocId,
    ],
  )
  return lockInventoryLotById(client, Number(inserted.rows[0].id), locationId)
}

async function applyInventoryMovement(client, params) {
  const before = Number(params.lot.quantityOnHand)
  const delta = params.direction === '出库' ? -params.quantity : params.quantity
  const after = Math.round((before + delta) * 100) / 100
  if (params.direction === '出库') {
    const reservationRes = await client.query(
      `SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
         FROM inventory_stock_reservations
        WHERE lot_id = $1
          AND status = '已预留'`,
      [params.lot.id],
    )
    const reserved = Number(reservationRes.rows[0]?.quantity ?? 0)
    const available = before - reserved
    if (params.quantity > available) {
      throw new Error(`INVALID_STATE: 库存不足：${params.lot.skuName} 可用 ${Math.max(available, 0)}`)
    }
  }
  if (after < 0) {
    throw new Error(`INVALID_STATE: 库存不足：${params.lot.skuName} 当前 ${before}`)
  }
  await client.query(
    `INSERT INTO inventory_movements (
       movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id,
       direction, quantity_delta, quantity_before, quantity_after, created_by, remark
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      params.movementKey,
      params.lot.id,
      params.lot.locationId,
      params.lot.skuId,
      params.docId,
      params.docItemId,
      params.direction,
      delta,
      before,
      after,
      params.createdBy || null,
      params.remark || null,
    ],
  )
  params.lot.quantityOnHand = after
}

async function assertInventoryLotAvailableForReservation(client, lot, quantity) {
  const reservationRes = await client.query(
    `SELECT COALESCE(SUM(quantity - fulfilled_quantity - released_quantity), 0) AS quantity
       FROM inventory_stock_reservations
      WHERE lot_id = $1
        AND status = '已预留'`,
    [lot.id],
  )
  const reserved = Number(reservationRes.rows[0]?.quantity ?? 0)
  const available = Number(lot.quantityOnHand) - reserved
  if (quantity > available) {
    throw new Error(`INVALID_STATE: 库存不足：${lot.skuName} 可用 ${Math.max(available, 0)}`)
  }
}

async function loadInventoryDocLineage(auth, docId) {
  const upstreamScope = buildInventoryLocationScope(auth, 'from_doc', 2)
  const downstreamScope = buildInventoryLocationScope(auth, 'to_doc', upstreamScope.nextIdx)
  const result = await pg.query(
    `SELECT
       CASE WHEN link.from_doc_id = $1 THEN '下游' ELSE '上游' END AS direction,
       link.relation_type,
       CASE WHEN link.from_doc_id = $1 THEN to_doc.id ELSE from_doc.id END AS doc_id,
       CASE WHEN link.from_doc_id = $1 THEN to_doc.doc_type ELSE from_doc.doc_type END AS doc_type,
       CASE WHEN link.from_doc_id = $1 THEN to_doc.status ELSE from_doc.status END AS status,
       CASE WHEN link.from_doc_id = $1 THEN to_doc.doc_date ELSE from_doc.doc_date END AS doc_date,
       CASE WHEN link.from_doc_id = $1 THEN to_doc.total_quantity ELSE from_doc.total_quantity END AS total_quantity,
       COALESCE(SUM(link.quantity), 0) AS linked_quantity,
       MAX(link.created_at) AS linked_at
     FROM inventory_doc_links link
     JOIN inventory_docs from_doc ON from_doc.id = link.from_doc_id
     JOIN inventory_docs to_doc ON to_doc.id = link.to_doc_id
    WHERE (
      (link.from_doc_id = $1 AND ${downstreamScope.sql})
      OR (link.to_doc_id = $1 AND ${upstreamScope.sql})
    )
    GROUP BY
      link.from_doc_id, link.to_doc_id, link.relation_type,
      from_doc.id, from_doc.doc_type, from_doc.status, from_doc.doc_date, from_doc.total_quantity,
      to_doc.id, to_doc.doc_type, to_doc.status, to_doc.doc_date, to_doc.total_quantity
    ORDER BY linked_at DESC, link.relation_type ASC`,
    [docId, ...upstreamScope.params, ...downstreamScope.params],
  )
  return result.map((row) => ({
    direction: row.direction,
    relationType: row.relation_type,
    docId: row.doc_id,
    docType: row.doc_type,
    status: row.status,
    docDate: row.doc_date,
    totalQuantity: Number(row.total_quantity || 0),
    linkedQuantity: Number(row.linked_quantity || 0),
  }))
}

async function resolveStoreReturnTargetMarket(client, sourceOrgNodeId, targetOrgNodeId) {
  const result = await client.query(
    `SELECT market.org_node_id AS market_id
       FROM inventory_locations source
       JOIN inventory_locations market
         ON market.location_id = source.parent_location_id
        AND market.location_type = '市场'
        AND market.is_active = true
      WHERE source.org_node_id = $1
        AND source.location_type = '门店'
        AND source.is_active = true
      FOR UPDATE OF source, market`,
    [sourceOrgNodeId],
  )
  const marketId = result.rows[0]?.market_id || null
  if (!marketId) throw new Error('INVALID_STATE: 门店未归属有效市场，不能审批退货')
  if (targetOrgNodeId && targetOrgNodeId !== marketId) {
    throw new Error('INVALID_STATE: 院退货回库主体与门店所属市场不一致')
  }
  return marketId
}

async function stockList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const {
    locationId,
    locationType,
    skuId,
    keyword,
    onlyPositive,
    page = 1,
    pageSize = 20,
  } = ctx.event.payload || {}
  await syncInventoryLocations()
  if (locationId) requireInventoryLocationInScope(ctx.auth, locationId)
  if (locationType && locationType !== '门店') {
    throw new Error('INVALID_PARAMS: staff 端只能查询门店库存')
  }
  const scopedIds = scopedInventoryLocationIds(ctx.auth)

  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  const conditions = [`loc.location_type = '门店'`]
  const params = []
  let idx = 1
  if (scopedIds.length === 0) conditions.push('FALSE')
  else {
    conditions.push(`st.location_id = ANY($${idx}::text[])`)
    params.push(scopedIds)
    idx++
  }
  if (locationId) {
    conditions.push(`st.location_id = $${idx}`)
    params.push(locationId)
    idx++
  }
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
    conditions.push(`(st.sku_id ILIKE $${idx} OR st.sku_name ILIKE $${idx} OR st.batch_no ILIKE $${idx} OR loc.name ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await pg.query(
    `SELECT st.id, st.location_id, loc.name AS location_name, loc.location_type,
            st.sku_id, st.sku_name, st.spec_name, st.supplier, st.product_series,
            st.batch_no, st.expiry_date, st.is_gift, st.quantity_on_hand, st.remark, st.updated_at
       FROM inventory_stock_lots st
  LEFT JOIN inventory_locations loc ON loc.location_id = st.location_id
       ${whereSql}
   ORDER BY loc.location_type, loc.name, st.sku_name, st.batch_no
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM inventory_stock_lots st
  LEFT JOIN inventory_locations loc ON loc.location_id = st.location_id
       ${whereSql}`,
    params,
  )
  ctx.result = {
    items: rows.map((r) => ({
      id: Number(r.id),
      locationId: r.location_id,
      locationName: r.location_name || null,
      locationType: r.location_type || null,
      skuId: r.sku_id,
      skuName: r.sku_name,
      specName: r.spec_name || null,
      supplier: r.supplier || null,
      productSeries: r.product_series || null,
      batchNo: r.batch_no || '',
      expiryDate: r.expiry_date || null,
      isGift: Boolean(r.is_gift),
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

/**
 * 门店报货可选 SKU。
 *
 * 员工端只需要商品识别信息和本店库存参考，价格体系留在服务端库存域，不能下发给小程序。
 */
async function reportableSkuOptions(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const {
    locationId,
    keyword,
    page = 1,
    pageSize = 50,
  } = ctx.event.payload || {}

  await syncInventoryLocations()
  const sourceOrgNodeId = locationId || ctx.auth.effectiveStoreId
  await assertInventoryWriteStoreScope(pg, ctx.auth, sourceOrgNodeId)
  const source = await ensureStoreLocation(sourceOrgNodeId)
  if (!source.parent_location_id) {
    throw new Error('INVALID_STATE: 当前门店未关联市场，无法查询可报货 SKU')
  }

  const limit = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 50))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  const conditions = [
    'sku.is_active = true',
    'sku.is_reportable = true',
    '(sku.owner_market_id IS NULL OR sku.owner_market_id = $2)',
  ]
  const params = [sourceOrgNodeId, source.parent_location_id]
  let idx = 3
  if (keyword) {
    const escaped = String(keyword).replace(/[%_]/g, '\\$&')
    conditions.push(`(sku.sku_id ILIKE $${idx} OR sku.product_code ILIKE $${idx} OR sku.product_name ILIKE $${idx} OR sku.spec_name ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const countConditions = [
    'sku.is_active = true',
    'sku.is_reportable = true',
    '(sku.owner_market_id IS NULL OR sku.owner_market_id = $1)',
  ]
  const countParams = [source.parent_location_id]
  if (keyword) {
    const escaped = String(keyword).replace(/[%_]/g, '\\$&')
    countConditions.push('(sku.sku_id ILIKE $2 OR sku.product_code ILIKE $2 OR sku.product_name ILIKE $2 OR sku.spec_name ILIKE $2)')
    countParams.push(`%${escaped}%`)
  }
  const countWhereSql = `WHERE ${countConditions.join(' AND ')}`
  const rows = await pg.query(
    `SELECT sku.sku_id, sku.product_code, sku.product_name, sku.spec_name,
            sku.supplier, sku.product_series,
            COALESCE(SUM(lot.quantity_on_hand), 0) AS stock_reference
       FROM inventory_skus sku
  LEFT JOIN inventory_stock_lots lot
         ON lot.sku_id = sku.sku_id
        AND lot.location_id = $1
       ${whereSql}
   GROUP BY sku.sku_id, sku.product_code, sku.product_name, sku.spec_name,
            sku.supplier, sku.product_series
   ORDER BY sku.product_name, sku.spec_name NULLS LAST, sku.sku_id
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM inventory_skus sku
       ${countWhereSql}`,
    countParams,
  )

  ctx.result = {
    items: rows.map((row) => ({
      skuId: row.sku_id,
      productCode: row.product_code,
      skuName: row.product_name,
      specName: row.spec_name || null,
      supplier: row.supplier || null,
      productSeries: row.product_series || null,
      stockReference: Number(row.stock_reference || 0),
    })),
    total: Number(countRows[0]?.cnt || 0),
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit,
  }
  return ctx.result
}

/**
 * 同市场门店调货的接收门店选择器。
 *
 * 仅验证发起门店的库存写权限；接收门店可不在发起人的可见范围内，但必须与发起门店同市场。
 */
async function storeOptions(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { sourceStoreId } = ctx.event.payload || {}
  await syncInventoryLocations()
  const sourceId = sourceStoreId || ctx.auth.effectiveStoreId
  await assertInventoryWriteStoreScope(pg, ctx.auth, sourceId)
  const source = await ensureStoreLocation(sourceId)
  if (!source.parent_location_id) {
    throw new Error('INVALID_STATE: 当前门店未关联市场，无法发起调货')
  }

  const rows = await pg.query(
    `SELECT loc.location_id, loc.org_node_id, loc.name
       FROM inventory_locations loc
       JOIN stores s ON s.store_id = loc.store_id
      WHERE loc.location_type = '门店'
        AND loc.parent_location_id = $1
        AND loc.location_id <> $2
        AND loc.is_active = true
        AND s.is_closed = false
   ORDER BY loc.name, loc.location_id`,
    [source.parent_location_id, sourceId],
  )
  ctx.result = {
    items: rows.map((row) => ({
      storeId: row.location_id,
      orgNodeId: row.org_node_id,
      storeName: row.name,
    })),
  }
  return ctx.result
}

async function docOrgOptions(ctx) {
  await requireStaffBound()(ctx, async () => {})
  await syncInventoryLocations()
  const scopedStoreIds = scopedInventoryLocationIds(ctx.auth)
  if (scopedStoreIds.length === 0) {
    ctx.result = { items: [] }
    return ctx.result
  }
  const rows = await pg.query(
    `WITH RECURSIVE visible_nodes AS (
       SELECT node.id, node.parent_id, node.type, node.name, node.is_active
         FROM inventory_locations loc
         JOIN org_nodes node ON node.id = loc.org_node_id
        WHERE loc.location_id = ANY($1::text[])
       UNION
       SELECT parent.id, parent.parent_id, parent.type, parent.name, parent.is_active
         FROM org_nodes parent
         JOIN visible_nodes child ON child.parent_id = parent.id
     )
     SELECT DISTINCT id, parent_id, type, name, is_active
       FROM visible_nodes
      WHERE type IN ('总部','市场','门店')
   ORDER BY CASE type WHEN '总部' THEN 1 WHEN '市场' THEN 2 ELSE 3 END, name, id`,
    [scopedStoreIds],
  )
  ctx.result = {
    items: rows.map((row) => ({
      orgNodeId: row.id,
      parentOrgNodeId: row.parent_id || null,
      orgNodeType: row.type,
      name: row.name,
      isActive: row.is_active !== false,
    })),
  }
  return ctx.result
}

async function docList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const {
    orgNodeId,
    docType,
    docTypes,
    status,
    startDate,
    endDate,
    keyword,
    page = 1,
    pageSize = 20,
  } = ctx.event.payload || {}
  await syncInventoryLocations()
  if (docType && !isStaffVisibleDocType(docType)) {
    throw new Error('INVALID_PARAMS: staff 端不支持查询该库存单据')
  }
  if (docType && docTypes !== undefined) {
    throw new Error('INVALID_PARAMS: 不能同时指定 docType 和 docTypes')
  }
  if (docTypes !== undefined && !Array.isArray(docTypes)) {
    throw new Error('INVALID_PARAMS: docTypes 必须是数组')
  }
  const requestedDocTypes = Array.isArray(docTypes)
    ? Array.from(new Set(docTypes.filter((type) => typeof type === 'string' && type.trim())))
    : []
  if (requestedDocTypes.some((type) => !isStaffVisibleDocType(type))) {
    throw new Error('INVALID_PARAMS: staff 端不支持查询该库存单据')
  }

  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  const conditions = []
  const params = []
  let idx = 1
  const scope = buildInventoryLocationScope(ctx.auth, 'd', idx)
  conditions.push(scope.sql)
  params.push(...scope.params)
  idx = scope.nextIdx
  if (docType) {
    conditions.push(`d.doc_type = $${idx}`)
    params.push(docType)
    idx++
  } else if (requestedDocTypes.length > 0) {
    conditions.push(`d.doc_type = ANY($${idx}::text[])`)
    params.push(requestedDocTypes)
    idx++
  } else {
    conditions.push(`d.doc_type = ANY($${idx}::text[])`)
    params.push(STAFF_VISIBLE_DOC_TYPE_LIST)
    idx++
  }
  if (orgNodeId) {
    conditions.push(`(
      d.source_org_node_id IN ${descendantOrgNodeIdsSql(idx)}
      OR d.target_org_node_id IN ${descendantOrgNodeIdsSql(idx)}
    )`)
    params.push(orgNodeId)
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
    conditions.push(`(d.id ILIKE $${idx} OR d.customer_name ILIKE $${idx} OR d.employee_name ILIKE $${idx} OR d.remark ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const rows = await pg.query(
    `SELECT d.id, d.doc_type, d.status, d.source_org_node_id, d.target_org_node_id,
            d.doc_date, d.related_sale_order_id,
            d.customer_name, d.employee_name, d.supplier_name, d.logistics_company,
            d.tracking_no, d.total_quantity, d.remark, d.created_at, d.updated_at,
            source_loc.name AS source_location_name, source_loc.location_type AS source_location_type,
            target_loc.name AS target_location_name, target_loc.location_type AS target_location_type
       FROM inventory_docs d
  LEFT JOIN inventory_locations source_loc ON source_loc.org_node_id = d.source_org_node_id
  LEFT JOIN inventory_locations target_loc ON target_loc.org_node_id = d.target_org_node_id
       ${whereSql}
   ORDER BY d.doc_date DESC, d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt FROM inventory_docs d ${whereSql}`,
    params,
  )
  ctx.result = {
    items: rows.map((r) => ({
      id: r.id,
      docType: r.doc_type,
      status: r.status,
      sourceOrgNodeId: r.source_org_node_id || null,
      sourceOrgNodeName: r.source_location_name || null,
      sourceOrgNodeType: r.source_location_type || null,
      targetOrgNodeId: r.target_org_node_id || null,
      targetOrgNodeName: r.target_location_name || null,
      targetOrgNodeType: r.target_location_type || null,
      docDate: r.doc_date,
      totalQuantity: Number(r.total_quantity || 0),
      relatedSaleOrderId: r.related_sale_order_id || null,
      customerName: r.customer_name || null,
      employeeName: r.employee_name || null,
      supplierName: r.supplier_name || null,
      logisticsCompany: r.logistics_company || null,
      trackingNo: r.tracking_no || null,
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
  await syncInventoryLocations()
  const scope = buildInventoryLocationScope(ctx.auth, 'd', 2)
  const docTypeParamIndex = scope.nextIdx
  const rows = await pg.query(
    `SELECT d.id, d.doc_type, d.status, d.source_org_node_id, d.target_org_node_id,
            d.doc_date, d.related_sale_order_id,
            d.customer_name, d.employee_name, d.supplier_name, d.logistics_company,
            d.tracking_no, d.total_quantity, d.remark, d.audit_remark,
            d.confirmed_at, d.approved_at, d.rejected_at, d.created_at, d.updated_at,
            source_loc.name AS source_location_name, source_loc.location_type AS source_location_type,
            target_loc.name AS target_location_name, target_loc.location_type AS target_location_type
       FROM inventory_docs d
  LEFT JOIN inventory_locations source_loc ON source_loc.org_node_id = d.source_org_node_id
  LEFT JOIN inventory_locations target_loc ON target_loc.org_node_id = d.target_org_node_id
      WHERE d.id = $1
        AND ${scope.sql}
        AND d.doc_type = ANY($${docTypeParamIndex}::text[])
      LIMIT 1`,
    [id, ...scope.params, STAFF_VISIBLE_DOC_TYPE_LIST],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 单据不存在或无权限')
  const r = rows[0]
  const [items, lineage] = await Promise.all([
    pg.query(
    `SELECT id, doc_id, lot_id, sku_id, sale_item_id, sku_name, spec_name,
            supplier, product_series, batch_no, expiry_date, is_gift,
            quantity, stock_snapshot, request_quantity, fulfilled_quantity,
            reason, remark, created_at
       FROM inventory_doc_items
      WHERE doc_id = $1
   ORDER BY id`,
      [id],
    ),
    loadInventoryDocLineage(ctx.auth, id),
  ])
  ctx.result = {
    id: r.id,
    docType: r.doc_type,
    status: r.status,
    sourceOrgNodeId: r.source_org_node_id || null,
    sourceOrgNodeName: r.source_location_name || null,
    sourceOrgNodeType: r.source_location_type || null,
    targetOrgNodeId: r.target_org_node_id || null,
    targetOrgNodeName: r.target_location_name || null,
    targetOrgNodeType: r.target_location_type || null,
    docDate: r.doc_date,
    totalQuantity: Number(r.total_quantity || 0),
    relatedSaleOrderId: r.related_sale_order_id || null,
    customerName: r.customer_name || null,
    employeeName: r.employee_name || null,
    supplierName: r.supplier_name || null,
    logisticsCompany: r.logistics_company || null,
    trackingNo: r.tracking_no || null,
    remark: r.remark || null,
    auditRemark: r.audit_remark || null,
    confirmedAt: r.confirmed_at || null,
    approvedAt: r.approved_at || null,
    rejectedAt: r.rejected_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lineage,
    items: items.map((it) => ({
      id: Number(it.id),
      docId: it.doc_id,
      lotId: it.lot_id == null ? null : Number(it.lot_id),
      skuId: it.sku_id,
      saleItemId: it.sale_item_id || null,
      skuName: it.sku_name,
      specName: it.spec_name || null,
      supplier: it.supplier || null,
      productSeries: it.product_series || null,
      batchNo: it.batch_no || '',
      expiryDate: it.expiry_date || null,
      isGift: Boolean(it.is_gift),
      quantity: Number(it.quantity),
      stockSnapshot: it.stock_snapshot == null ? null : Number(it.stock_snapshot),
      requestQuantity: it.request_quantity == null ? null : Number(it.request_quantity),
      fulfilledQuantity: it.fulfilled_quantity == null ? null : Number(it.fulfilled_quantity),
      reason: it.reason || null,
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
  if (!isValidDocType(docType) || !isStaffCreateDocType(docType)) {
    throw new Error('INVALID_PARAMS: staff 端不支持创建该库存单据')
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 至少需要一条明细')
  assertNoStaffMoneyFields(payload)
  if (docType === '院产品报损' && items.some((item) => !String(item.reason || item.scrapReason || '').trim())) {
    throw new Error('INVALID_PARAMS: 报损明细必须填写原因')
  }
  await syncInventoryLocations()
  const {
    sourceOrgNodeId,
    targetOrgNodeId,
    sourceLocationId,
    targetLocationId,
    marketId,
  } = await resolveStaffCreateLocations(ctx, payload)
  const status = defaultDocStatus(docType)
  // 同一批次的待审批退货需按稳定顺序锁库存，降低多明细并发提交的死锁概率。
  const orderedItems = docType === '院退货'
    ? [...items].sort((left, right) => Number(left.lotId) - Number(right.lotId))
    : items
  const totalQuantity = orderedItems.reduce((acc, item) => acc + assertQty(item.quantity), 0)
  const plan = movementPlan(docType, status)
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType) && !targetOrgNodeId) {
    throw new Error('INVALID_PARAMS: 待收货单据缺少接收主体')
  }
  if (plan?.role === 'source' && !sourceOrgNodeId) throw new Error('INVALID_PARAMS: 出库类单据缺少出库主体')
  if (plan?.role === 'target' && !targetOrgNodeId) throw new Error('INVALID_PARAMS: 入库类单据缺少入库主体')
  let docId

  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    docId = await generateDocNo(client, docType)
    await client.query(
      `INSERT INTO inventory_docs (
         id, doc_type, status, source_org_node_id, target_org_node_id, doc_date, total_quantity,
         related_sale_order_id, client_user_id, customer_name,
         employee_id, employee_name, supplier_name, logistics_company, tracking_no,
         receipt_attachment_url, remark, created_by, confirmed_by, confirmed_at, market_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               CASE WHEN $20::boolean THEN NOW() ELSE NULL END,$21)`,
      [
        docId,
        docType,
        status,
        sourceOrgNodeId,
        targetOrgNodeId,
        payload.docDate || shanghaiToday(),
        totalQuantity,
        payload.relatedSaleOrderId || null,
        payload.clientUserId || null,
        payload.customerName || null,
        payload.employeeId || null,
        payload.employeeName || null,
        payload.supplierName || null,
        payload.logisticsCompany || null,
        payload.trackingNo || null,
        payload.receiptAttachmentUrl || null,
        payload.remark || null,
        ctx.auth.staffWfId,
        status === '已完成' || status === '待收货' ? ctx.auth.staffWfId : null,
        status === '已完成' || status === '待收货',
        marketId,
      ],
    )
    for (const item of orderedItems) {
      const qty = assertQty(item.quantity)
      let lot = null
      let snapshot
      const shouldCaptureSourceLot =
        plan?.role === 'source' ||
        (status === '待审批' && OUTBOUND_DOC_TYPES.has(docType))

      if (shouldCaptureSourceLot) {
        if (!item.lotId) throw new Error('INVALID_PARAMS: 出库类明细必须选择库存批次')
        lot = await lockInventoryLotById(client, Number(item.lotId), sourceLocationId)
        snapshot = lot
      } else if (plan?.role === 'target') {
        lot = await ensureInventoryLotFromSku(client, targetLocationId, item, {
          sourceDocId: docId,
          supplierId: item.supplierId || payload.supplierId || null,
          supplier: item.supplier || payload.supplierName || null,
        })
        snapshot = lot
      } else {
        if (!item.skuId) throw new Error('INVALID_PARAMS: 明细缺少库存 SKU')
        snapshot = await inventorySkuSnapshot(client, item.skuId)
      }
      const standardUnitPrice = lot?.storeStandardUnitPrice ?? null
      const unitDiscount = lot?.storeUnitDiscount ?? null
      const actualUnitPrice = lot?.storeActualUnitPrice ?? null
      const amount = actualUnitPrice == null ? null : Math.round(actualUnitPrice * qty * 100) / 100
      const inserted = await client.query(
        `INSERT INTO inventory_doc_items (
           doc_id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity, stock_snapshot,
           request_quantity, fulfilled_quantity, standard_unit_price, unit_discount,
           actual_unit_price, amount, supply_chain_unit_cost, market_standard_unit_price,
           market_unit_discount, market_actual_unit_price, store_standard_unit_price,
           store_unit_discount, store_actual_unit_price, reason, remark
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         RETURNING id`,
        [
          docId,
          lot?.id || null,
          snapshot.skuId,
          item.saleItemId || null,
          snapshot.skuName,
          snapshot.specName || null,
          snapshot.supplier || null,
          snapshot.productSeries || null,
          lot?.batchNo || item.batchNo || '',
          lot?.expiryDate || item.expiryDate || null,
          lot?.isGift ?? Boolean(item.isGift),
          qty,
          lot ? lot.quantityOnHand : null,
          item.requestQuantity || null,
          item.fulfilledQuantity || null,
          standardUnitPrice,
          unitDiscount,
          actualUnitPrice,
          amount,
          lot?.supplyChainUnitCost ?? null,
          lot?.marketStandardUnitPrice ?? null,
          lot?.marketUnitDiscount ?? null,
          lot?.marketActualUnitPrice ?? null,
          lot?.storeStandardUnitPrice ?? null,
          lot?.storeUnitDiscount ?? null,
          lot?.storeActualUnitPrice ?? null,
          item.reason || item.scrapReason || null,
          item.remark || null,
        ],
      )
      if (docType === '院退货' && lot) {
        await assertInventoryLotAvailableForReservation(client, lot, qty)
        await client.query(
          `INSERT INTO inventory_stock_reservations (
             request_doc_id, request_item_id, lot_id, location_id, sku_id, quantity,
             fulfilled_quantity, released_quantity, status, created_by
           )
           VALUES ($1,$2,$3,$4,$5,$6,0,0,'已预留',$7)`,
          [
            docId,
            Number(inserted.rows[0].id),
            lot.id,
            sourceLocationId,
            lot.skuId,
            qty,
            ctx.auth.staffWfId,
          ],
        )
      }
      if (plan && lot) {
        await applyInventoryMovement(client, {
          lot,
          docId,
          docItemId: Number(inserted.rows[0].id),
          direction: plan.direction,
          quantity: qty,
          createdBy: ctx.auth.staffWfId,
          movementKey: `doc:${docId}:item:${inserted.rows[0].id}:${plan.direction}`,
          remark: payload.remark || null,
        })
      }
    }
  })

  ctx.result = { id: docId, message: '提交成功' }
  return ctx.result
}

async function approveStoreReturnForRestock(client, head, ctx, auditRemark) {
  if (!head.source_org_node_id) throw new Error('INVALID_STATE: 院退货单缺少门店退货主体')
  const targetOrgNodeId = await resolveStoreReturnTargetMarket(
    client,
    head.source_org_node_id,
    head.target_org_node_id,
  )
  if (head.target_org_node_id !== targetOrgNodeId || head.market_id !== targetOrgNodeId) {
    await client.query(
      `UPDATE inventory_docs
          SET target_org_node_id = $2,
              market_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [head.id, targetOrgNodeId],
    )
  }
  const sourceLocation = await ensureStoreLocation(head.source_org_node_id, client)
  const targetLocation = await ensureInventoryLocation(targetOrgNodeId, '市场', client)

  const itemRes = await client.query(
    `SELECT id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier, product_series,
            batch_no, expiry_date, is_gift, quantity, standard_unit_price, unit_discount,
            actual_unit_price, amount, supply_chain_unit_cost, market_standard_unit_price,
            market_unit_discount, market_actual_unit_price, store_standard_unit_price,
            store_unit_discount, store_actual_unit_price, reason, remark
       FROM inventory_doc_items
      WHERE doc_id = $1
   ORDER BY lot_id, id
      FOR UPDATE`,
    [head.id],
  )
  if (itemRes.rows.length === 0) throw new Error('INVALID_STATE: 院退货单没有可回库明细')

  const totalQuantity = itemRes.rows.reduce((total, item) => total + assertQty(item.quantity), 0)
  const inboundDocId = await generateDocNo(client, '市场退货入库')
  await client.query(
      `INSERT INTO inventory_docs (
       id, doc_type, status, source_org_node_id, target_org_node_id, market_id,
       doc_date, total_quantity, remark, created_by, confirmed_by, confirmed_at
     )
     VALUES ($1,'市场退货入库','已完成',$2,$3,$3,$4,$5,$6,$7,$7,NOW())`,
    [
      inboundDocId,
      head.source_org_node_id,
      targetOrgNodeId,
      shanghaiToday(),
      totalQuantity,
      auditRemark || null,
      ctx.auth.staffWfId,
    ],
  )

  for (const item of itemRes.rows) {
    if (!item.lot_id) throw new Error('INVALID_STATE: 退货明细缺少来源批次')
    const quantity = assertQty(item.quantity)
    const sourceLot = await lockInventoryLotById(
      client,
      Number(item.lot_id),
      sourceLocation.location_id,
    )
    const reservationRes = await client.query(
      `SELECT id, quantity, fulfilled_quantity, released_quantity
         FROM inventory_stock_reservations
        WHERE request_doc_id = $1
          AND request_item_id = $2
          AND lot_id = $3
          AND status = '已预留'
        FOR UPDATE`,
      [head.id, Number(item.id), sourceLot.id],
    )
    const reservation = reservationRes.rows[0]
    if (!reservation) throw new Error('CONFLICT: 退货库存预留已失效，请刷新后重试')
    const reservedAvailable =
      Number(reservation.quantity) - Number(reservation.fulfilled_quantity) - Number(reservation.released_quantity)
    if (quantity > reservedAvailable) throw new Error('CONFLICT: 退货库存预留数量不足')

    // 先完成本单预留，出库校验只会扣除其他未完成预留。
    const reservationUpdated = await client.query(
      `UPDATE inventory_stock_reservations
          SET fulfilled_quantity = $2,
              status = '已完成',
              updated_at = NOW()
        WHERE id = $1
          AND status = '已预留'`,
      [Number(reservation.id), quantity],
    )
    if (reservationUpdated.rowCount === 0) {
      throw new Error('CONFLICT: 退货库存预留已被其他操作处理')
    }

    const priceSnapshot = {
      supplyChainUnitCost: item.supply_chain_unit_cost ?? sourceLot.supplyChainUnitCost,
      marketStandardUnitPrice: item.market_standard_unit_price ?? sourceLot.marketStandardUnitPrice,
      marketUnitDiscount: item.market_unit_discount ?? sourceLot.marketUnitDiscount,
      marketActualUnitPrice: item.market_actual_unit_price ?? sourceLot.marketActualUnitPrice,
      storeStandardUnitPrice: item.store_standard_unit_price ?? sourceLot.storeStandardUnitPrice,
      storeUnitDiscount: item.store_unit_discount ?? sourceLot.storeUnitDiscount,
      storeActualUnitPrice: item.store_actual_unit_price ?? sourceLot.storeActualUnitPrice,
    }
    const targetLot = await ensureInventoryLotFromSku(
      client,
      targetLocation.location_id,
      {
        skuId: sourceLot.skuId,
        batchNo: sourceLot.batchNo,
        expiryDate: sourceLot.expiryDate,
        isGift: sourceLot.isGift,
      },
      {
        // 回库批次沿用来源批次的供应商和最初来源，避免同批号跨供应商合并。
        sourceDocId: sourceLot.sourceDocId || inboundDocId,
        supplierId: sourceLot.supplierId,
        supplier: sourceLot.supplier,
      },
      priceSnapshot,
    )
    const standardUnitPrice = item.standard_unit_price ?? sourceLot.storeStandardUnitPrice ?? null
    const unitDiscount = item.unit_discount ?? sourceLot.storeUnitDiscount ?? null
    const actualUnitPrice = item.actual_unit_price ?? sourceLot.storeActualUnitPrice ?? null
    const amount = actualUnitPrice == null
      ? null
      : Math.round(Number(actualUnitPrice) * quantity * 100) / 100
    const inboundItemRes = await client.query(
      `INSERT INTO inventory_doc_items (
         doc_id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier, product_series,
         batch_no, expiry_date, is_gift, quantity, stock_snapshot,
         standard_unit_price, unit_discount, actual_unit_price, amount,
         supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
         market_actual_unit_price, store_standard_unit_price, store_unit_discount,
         store_actual_unit_price, reason, remark
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING id`,
      [
        inboundDocId,
        targetLot.id,
        targetLot.skuId,
        item.sale_item_id || null,
        targetLot.skuName,
        targetLot.specName || item.spec_name || null,
        targetLot.supplier || item.supplier || null,
        targetLot.productSeries || item.product_series || null,
        targetLot.batchNo,
        targetLot.expiryDate,
        targetLot.isGift,
        quantity,
        targetLot.quantityOnHand,
        standardUnitPrice,
        unitDiscount,
        actualUnitPrice,
        amount,
        priceSnapshot.supplyChainUnitCost ?? null,
        priceSnapshot.marketStandardUnitPrice ?? null,
        priceSnapshot.marketUnitDiscount ?? null,
        priceSnapshot.marketActualUnitPrice ?? null,
        priceSnapshot.storeStandardUnitPrice ?? null,
        priceSnapshot.storeUnitDiscount ?? null,
        priceSnapshot.storeActualUnitPrice ?? null,
        item.reason || null,
        item.remark || null,
      ],
    )
    const inboundItemId = Number(inboundItemRes.rows[0]?.id)
    if (!Number.isInteger(inboundItemId) || inboundItemId <= 0) {
      throw new Error('CONFLICT: 市场退货入库明细创建失败')
    }
    await applyInventoryMovement(client, {
      lot: sourceLot,
      docId: head.id,
      docItemId: Number(item.id),
      direction: '出库',
      quantity,
      createdBy: ctx.auth.staffWfId,
      movementKey: `return:${head.id}:item:${item.id}`,
      remark: auditRemark || null,
    })
    await applyInventoryMovement(client, {
      lot: targetLot,
      docId: inboundDocId,
      docItemId: inboundItemId,
      direction: '入库',
      quantity,
      createdBy: ctx.auth.staffWfId,
      movementKey: `return-receipt:${head.id}:item:${inboundItemId}`,
      remark: auditRemark || null,
    })
    await client.query(
      `INSERT INTO inventory_doc_links (
         from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity
       ) VALUES ($1,$2,'退货回库',$3,$4,$5)`,
      [head.id, inboundDocId, Number(item.id), inboundItemId, quantity],
    )
    await client.query(
      `UPDATE inventory_doc_items
          SET fulfilled_quantity = $2
        WHERE id = $1`,
      [Number(item.id), quantity],
    )
  }

  await client.query(
    `UPDATE inventory_docs
        SET status = '已完成',
            total_quantity = $2,
            approved_by = $3,
            approved_at = NOW(),
            audit_remark = $4,
            updated_at = NOW()
      WHERE id = $1
        AND status = '待审批'`,
    [head.id, totalQuantity, ctx.auth.staffWfId, auditRemark || null],
  )
}

async function approveDoc(ctx) {
  await requireStaffBound()(ctx, async () => {})
  assertApprover(ctx)
  const { id, auditRemark } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少单据号')
  await syncInventoryLocations()
  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    const headRes = await client.query(
      `SELECT id, doc_type, status, source_org_node_id, target_org_node_id, market_id,
              total_quantity, related_sale_order_id
         FROM inventory_docs
        WHERE id = $1
          AND doc_type = ANY($2::text[])
        FOR UPDATE`,
      [id, STAFF_VISIBLE_DOC_TYPE_LIST],
    )
    const head = headRes.rows[0]
    if (!head) throw new Error('NOT_FOUND: 单据不存在')
    const acting = head.source_org_node_id || head.target_org_node_id
    const actingStore = await ensureStoreLocation(acting, client)
    await assertApproverStoreScope(client, ctx.auth, actingStore.location_id)
    if (head.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以审批')
    const direction = approvalMovementDirection(head.doc_type)
    if (!direction) throw new Error('INVALID_STATE: 该单据类型不需要审批')
    if (head.doc_type === '院退货') {
      await approveStoreReturnForRestock(client, head, ctx, auditRemark)
      return
    }
    const itemRes = await client.query(
      `SELECT id, lot_id, quantity, sale_item_id
         FROM inventory_doc_items
        WHERE doc_id = $1
     ORDER BY id`,
      [id],
    )
    const sourceLocation = await ensureStoreLocation(head.source_org_node_id, client)
    for (const item of itemRes.rows) {
      if (!item.lot_id) throw new Error('INVALID_STATE: 审批出库明细缺少库存批次')
      const lot = await lockInventoryLotById(client, Number(item.lot_id), sourceLocation.location_id)
      await applyInventoryMovement(client, {
        lot,
        docId: id,
        docItemId: Number(item.id),
        direction,
        quantity: Number(item.quantity),
        createdBy: ctx.auth.staffWfId,
        movementKey: `approve:${id}:item:${item.id}:${direction}`,
        remark: auditRemark || null,
      })
    }
    await client.query(
      `UPDATE inventory_docs
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
  await syncInventoryLocations()
  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    const headRes = await client.query(
      `SELECT doc_type, source_org_node_id, target_org_node_id, status
         FROM inventory_docs
        WHERE id = $1
          AND doc_type = ANY($2::text[])
        FOR UPDATE`,
      [id, STAFF_VISIBLE_DOC_TYPE_LIST],
    )
    const doc = headRes.rows[0]
    if (!doc) throw new Error('NOT_FOUND: 单据不存在')
    const acting = doc.source_org_node_id || doc.target_org_node_id
    const actingStore = await ensureStoreLocation(acting, client)
    await assertApproverStoreScope(client, ctx.auth, actingStore.location_id)
    if (doc.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以驳回')
    if (!approvalMovementDirection(doc.doc_type)) throw new Error('INVALID_STATE: 该单据类型不需要审批')
    if (doc.doc_type === '院退货') {
      await client.query(
        `UPDATE inventory_stock_reservations
            SET released_quantity = quantity,
                status = '已释放',
                updated_at = NOW()
          WHERE request_doc_id = $1
            AND status = '已预留'`,
        [id],
      )
    }
    const updated = await client.query(
      `UPDATE inventory_docs
          SET status = '已驳回',
              rejected_by = $2,
              rejected_at = NOW(),
              audit_remark = $3,
              updated_at = NOW()
        WHERE id = $1
          AND status = '待审批'`,
      [id, ctx.auth.staffWfId, auditRemark || null],
    )
    if (updated.rowCount === 0) {
      throw new Error('CONFLICT: 单据状态已被其他操作修改')
    }
  })
  ctx.result = { message: '已驳回' }
  return ctx.result
}

async function confirmReceive(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { id, remark } = ctx.event.payload || {}
  if (!id) throw new Error('INVALID_PARAMS: 缺少待收货单号')
  let inboundDocId
  await syncInventoryLocations()
  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    const headRes = await client.query(
      `SELECT id, doc_type, status, source_org_node_id, target_org_node_id,
              supplier_id, supplier_name, total_quantity, total_amount, market_id, remark
         FROM inventory_docs
        WHERE id = $1
          AND doc_type = ANY($2::text[])
        FOR UPDATE`,
      [id, Array.from(STAFF_RECEIVE_DOC_TYPES)],
    )
    const head = headRes.rows[0]
    if (!head) throw new Error('NOT_FOUND: 待收货单据不存在')
    if (head.status !== '待收货') throw new Error('INVALID_STATE: 该单据不是待收货状态')
    if (!head.target_org_node_id) throw new Error('INVALID_STATE: 待收货单据缺少入库门店')
    const sourceLocation = head.source_org_node_id
      ? await ensureInventoryLocation(head.source_org_node_id, null, client)
      : null
    const targetLocation = await ensureStoreLocation(head.target_org_node_id, client)
    await assertInventoryWriteStoreScope(client, ctx.auth, targetLocation.location_id)
    const inboundType = RECEIVE_INBOUND_TYPE[head.doc_type]
    if (!inboundType) throw new Error('INVALID_STATE: 该单据不支持收货')
    inboundDocId = await generateDocNo(client, inboundType)
    await client.query(
      `INSERT INTO inventory_docs (
         id, doc_type, status, source_org_node_id, target_org_node_id, doc_date, total_quantity,
         total_amount, market_id, remark, created_by, confirmed_by, confirmed_at
       )
       VALUES ($1,$2,'已完成',$3,$4,$5,$6,$7,$8,$9,$10,$10,NOW())`,
      [
        inboundDocId,
        inboundType,
        head.source_org_node_id,
        head.target_org_node_id,
        shanghaiToday(),
        head.total_quantity,
        head.total_amount,
        head.market_id,
        remark || head.remark || null,
        ctx.auth.staffWfId,
      ],
    )
    const itemRes = await client.query(
      `SELECT id AS source_item_id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier, product_series,
              batch_no, expiry_date, is_gift, quantity, request_quantity,
              fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price,
              amount, supply_chain_unit_cost, market_standard_unit_price,
              market_unit_discount, market_actual_unit_price, store_standard_unit_price,
              store_unit_discount, store_actual_unit_price, reason, remark
         FROM inventory_doc_items
        WHERE doc_id = $1
     ORDER BY id`,
      [id],
    )
    for (const item of itemRes.rows) {
      const sourceLot = item.lot_id == null
        ? null
        : await lockInventoryLotById(client, Number(item.lot_id), sourceLocation.location_id)
      const lot = await ensureInventoryLotFromSku(client, targetLocation.location_id, {
        skuId: item.sku_id,
        batchNo: item.batch_no,
        expiryDate: item.expiry_date,
        isGift: item.is_gift,
        quantity: item.quantity,
      }, {
        // 有来源批次时保留其真实供应链路；采购订单首入库以订单为来源。
        sourceDocId: sourceLot?.sourceDocId || id,
        supplierId: sourceLot?.supplierId || head.supplier_id || null,
        supplier: sourceLot?.supplier || head.supplier_name || item.supplier || null,
      }, {
        supplyChainUnitCost: item.supply_chain_unit_cost,
        marketStandardUnitPrice: item.market_standard_unit_price,
        marketUnitDiscount: item.market_unit_discount,
        marketActualUnitPrice: item.market_actual_unit_price,
        storeStandardUnitPrice: item.store_standard_unit_price,
        storeUnitDiscount: item.store_unit_discount,
        storeActualUnitPrice: item.store_actual_unit_price,
      })
      const inserted = await client.query(
        `INSERT INTO inventory_doc_items (
           doc_id, lot_id, sku_id, sale_item_id, sku_name, spec_name, supplier, product_series,
           batch_no, expiry_date, is_gift, quantity, stock_snapshot,
           request_quantity, fulfilled_quantity, standard_unit_price, unit_discount,
           actual_unit_price, amount, supply_chain_unit_cost, market_standard_unit_price,
           market_unit_discount, market_actual_unit_price, store_standard_unit_price,
           store_unit_discount, store_actual_unit_price, reason, remark
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         RETURNING id`,
        [
          inboundDocId,
          lot.id,
          lot.skuId,
          item.sale_item_id || null,
          lot.skuName,
          lot.specName || item.spec_name || null,
          lot.supplier || item.supplier || null,
          lot.productSeries || item.product_series || null,
          lot.batchNo,
          lot.expiryDate,
          lot.isGift,
          Number(item.quantity),
          lot.quantityOnHand,
          item.request_quantity == null ? null : Number(item.request_quantity),
          item.fulfilled_quantity == null ? null : Number(item.fulfilled_quantity),
          item.standard_unit_price ?? null,
          item.unit_discount ?? null,
          item.actual_unit_price ?? null,
          item.amount ?? null,
          item.supply_chain_unit_cost ?? lot.supplyChainUnitCost ?? null,
          item.market_standard_unit_price ?? lot.marketStandardUnitPrice ?? null,
          item.market_unit_discount ?? lot.marketUnitDiscount ?? null,
          item.market_actual_unit_price ?? lot.marketActualUnitPrice ?? null,
          item.store_standard_unit_price ?? lot.storeStandardUnitPrice ?? null,
          item.store_unit_discount ?? lot.storeUnitDiscount ?? null,
          item.store_actual_unit_price ?? lot.storeActualUnitPrice ?? null,
          item.reason || null,
          item.remark || null,
        ],
      )
      await applyInventoryMovement(client, {
        lot,
        docId: inboundDocId,
        docItemId: Number(inserted.rows[0].id),
        direction: '入库',
        quantity: Number(item.quantity),
        createdBy: ctx.auth.staffWfId,
        movementKey: `receive:${id}:item:${inserted.rows[0].id}:入库`,
        remark: remark || null,
      })
      await client.query(
        `INSERT INTO inventory_doc_links (
           from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity
         ) VALUES ($1,$2,'发货收货',$3,$4,$5)`,
        [id, inboundDocId, Number(item.source_item_id), Number(inserted.rows[0].id), Number(item.quantity)],
      )
    }
    const completed = await client.query(
      `UPDATE inventory_docs
          SET status = '已完成',
              confirmed_by = $2,
              confirmed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND status = '待收货'`,
      [id, ctx.auth.staffWfId],
    )
    if (completed.rowCount === 0) {
      throw new Error('CONFLICT: 单据状态已被其他操作修改')
    }
  })
  ctx.result = { inboundDocId, message: '收货成功' }
  return ctx.result
}

async function uploadReceipt(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { id, fileBase64, ext = 'jpg' } = ctx.event.payload || {}
  if (!id || !fileBase64) throw new Error('INVALID_PARAMS: 缺少单据号或附件内容')
  await syncInventoryLocations()
  const rows = await pg.query(
    `SELECT source_org_node_id, target_org_node_id
       FROM inventory_docs
      WHERE id = $1
        AND doc_type = ANY($2::text[])
      LIMIT 1`,
    [id, STAFF_VISIBLE_DOC_TYPE_LIST],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 单据不存在')
  const storeLocations = await pg.query(
    `SELECT location_id
       FROM inventory_locations
      WHERE location_type = '门店'
        AND org_node_id = ANY($1::text[])`,
    [[rows[0].source_org_node_id, rows[0].target_org_node_id].filter(Boolean)],
  )
  await assertAnyInventoryWriteStoreScope(pg, ctx.auth, [
    ...storeLocations.map((row) => row.location_id),
  ])
  const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg'
  const buffer = Buffer.from(String(fileBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
  const upload = await cloud.uploadFile({
    cloudPath: `inventory-receipts/${id}-${Date.now()}.${safeExt}`,
    fileContent: buffer,
  })
  await pg.query(
    `UPDATE inventory_docs
        SET receipt_attachment_url = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, upload.fileID],
  )
  ctx.result = { fileID: upload.fileID }
  return ctx.result
}

module.exports = {
  stockList,
  reportableSkuOptions,
  storeOptions,
  docOrgOptions,
  docList,
  docDetail,
  createDoc,
  confirmReceive,
  approveDoc,
  rejectDoc,
  uploadReceipt,
}
