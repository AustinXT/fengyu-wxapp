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
  // 供应链跨市场汇总单（#193）。**刻意不进 STAFF_VISIBLE / STAFF_CREATE_DOC_TYPES**：
  // 它是供应链办理台发起的跨市场单据，分院侧既不该建也不该看见。
  // 那两个集合不在 cross-end snapshot 的守护范围内，漏加不会红测试，所以把决策写在这儿。
  '市场报货汇总': 'MHZ',
  '品项公司报货需求': 'ZBH',
  // `供应链采购订单`（旧前缀 PCG）已并入 `采购订单`（#194，migration 0043/0044）；
  // 存量单号保留 PCG-*，新单一律 CGD-*。
  '采购订单': 'CGD',
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
/**
 * #350：`院顾客产品出库` 已移出 —— 顾客出库必须绑定销售单，只能由提货服务产生
 * （本端 `order.createPickup`、admin `createPickupRecord`，两者直写 GCK，不经本白名单）。
 * 通用入口建出的 GCK 不回写 picked_up_quantity、不写 pickup_records，会与提货重复扣库存。
 * admin `INVENTORY_GENERIC_DOC_TYPES` 同步移除，两端取舍由 cross-end-inventory-snapshot 钉住。
 */
const STAFF_CREATE_DOC_TYPES = new Set([
  '门店报货',
  '分院调货出库',
  '院顾客退货',
  '院退货',
  '院产品报损',
  '分院库存盘点',
])
const STAFF_RECEIVE_DOC_TYPES = new Set(['分院配货', '分院调货出库'])
const STAFF_VISIBLE_DOC_TYPE_LIST = Array.from(STAFF_VISIBLE_DOC_TYPES)

const NO_MOVEMENT_DOC_TYPES = new Set(['门店报货', '市场报货', '市场报货汇总', '品项公司报货需求', '采购订单'])
const RECEIVE_REQUIRED_DOC_TYPES = new Set(['品项公司发货', '分院配货', '分院调货出库', '市场间调货出库'])
const APPROVAL_DOC_TYPES = new Set(['市场退货', '院退货', '市场产品报损', '院产品报损'])
// 盘点单：只记录「账面 vs 实盘」，不产生任何 inventory_movements、不改 quantity_on_hand。
// 账面数按**主体 + SKU 汇总**记录（issue #131，甲方 2026-09-16 拍板 Q1：现场按商品数总盘、不分批次）。
// ⚠️ 与 admin 的 fengyu-admin/src/lib/inventory/stocktake.ts 是**独立副本**（四端禁共享目录），
// 由 __tests__/routes/cross-end-inventory-snapshot.test.js 的 §2 字面量 snapshot 守护。
// staff 侧只开放了「分院库存盘点」（见 STAFF_CREATE_DOC_TYPES），但集合保持两端逐字一致。
const STOCKTAKE_DOC_TYPES = new Set(['市场库存盘点', '分院库存盘点'])
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

/**
 * 建单明细数量规则（#351）：盘点单的数量是**实盘数**，0 = 账上有货、货架上一件没有，
 * 正是最该记下的盘亏，必须能录；其余类型仍要求 > 0。
 *
 * 留空（null / undefined / 空串）一律不合法：`Number(null)`、`Number('')` 都是 0，
 * 不先拦就会把「没填」当成「实盘 0」入库，凭空多出一笔盘亏。同理只收 number / string
 * （`false`、`[0]` 经 Number() 也是 0），且最多两位小数、不超过 numeric(12,2) 上限：
 * 列是 numeric(12,2)，0.004 落库会被舍成 0.00 —— 盘点单上就是一笔凭空的「实盘 0」。
 *
 * ⚠️ 函数体与 admin `lib/inventory/engine.ts` 的同名函数**逐字一致**，由
 * `cross-end-inventory-snapshot.test.js` §7 整段比对；DB 侧兜底是 trigger
 * `inventory_assert_doc_item_quantity`（非盘点类型 quantity <= 0 拒绝）。
 * `assertQty` 仍用于读库里已有的非盘点明细（院退货审批），不受本规则影响。
 */
function isValidDocItemQuantity(docType, quantity) {
  if (typeof quantity !== 'number' && typeof quantity !== 'string') return false
  if (typeof quantity === 'string' && quantity.trim() === '') return false
  const n = Number(quantity)
  if (!Number.isFinite(n) || n > 9999999999.99 || Number(n.toFixed(2)) !== n) return false
  return n > 0 || (n === 0 && STOCKTAKE_DOC_TYPES.has(docType))
}

function assertDocItemQty(docType, quantity) {
  if (isValidDocItemQuantity(docType, quantity)) return Number(quantity)
  if (STOCKTAKE_DOC_TYPES.has(docType)) {
    throw new Error('INVALID_PARAMS: 请填写实盘数（0 或正数，最多两位小数；货架上没有就填 0）')
  }
  throw new Error('INVALID_PARAMS: 明细数量必须大于0')
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

/**
 * 审批/驳回的鉴权主体判定（#235）。
 *
 * 原先两处都写 `source_org_node_id || target_org_node_id`，拿「第一个非空的主体」当代表值
 * 去做 scope 判断，而不是按单据方向推导出**真正被扣减库存**的那一侧 —— 与 #200 修复前的
 * `createInventoryCoreDoc` 是同一个反模式。
 *
 * 它今天不可利用，靠的是两个巧合：能走到这两个函数的类型 =
 * `STAFF_VISIBLE_DOC_TYPES ∩ APPROVAL_DOC_TYPES` = {院退货, 院产品报损}，前者 source 恒非空、
 * 后者是同主体单据；且 `ensureStoreLocation` 强制 location_type='门店'，市场级单据进不来。
 * 一旦往任一集合里加入 source 可空或入库方向的类型，`||` 就会**无声**退化成按 target 鉴权。
 *
 * ⚠️ 方向必须用 `OUTBOUND_DOC_TYPES` 这个**独立分类器**判，不能从 `APPROVAL_DOC_TYPES` 自身派生。
 * 第一版写的是 `APPROVAL_DOC_TYPES.has(t) ? '出库' : null` 再断言「不是出库就抛」——
 * 那是个**恒真守卫**：方向由被守卫的集合自己算出来，第二个分支 provably dead。
 * 真有人往 `APPROVAL_DOC_TYPES` 加一个入库类型时它会静默放行，
 * 而那正是它声称要挡的场景。现在与 admin 侧 `engine.ts` 的
 * `if (!OUTBOUND_DOC_TYPES.has(head.doc_type)) throw` 同型（当前 APPROVAL ⊆ OUTBOUND，
 * 换判据对现网行为零影响，由 __tests__ 的不变量用例钉住）。
 *
 * 刻意**不写**「入库 → 取 target」的分支：那会是不可达代码（#237 同批刚清掉同类东西，
 * dead 分支会诱导后来者把它当活代码推理）。将来放开入库方向的审批类型时这里直接 fail-closed，
 * 逼改代码的人回来补主体推导。
 */
function assertApprovalOutboundDirection(docType) {
  if (!APPROVAL_DOC_TYPES.has(docType)) throw new Error('INVALID_STATE: APPROVAL_NOT_REQUIRED: 该单据类型不需要审批')
  if (!OUTBOUND_DOC_TYPES.has(docType)) {
    throw new Error('INVALID_STATE: APPROVAL_DIRECTION_UNSUPPORTED: 该单据暂不支持审批，请联系管理员')
  }
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
           OR loc.location_type IS DISTINCT FROM o.type::text
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

/**
 * 按 location_id 或 org_node_id 取库存主体（#251）。
 *
 * `OR` 是**有意的双 id 多态查找**，不能删：调用方两种 id 都会传进来 ——
 * `payload.sourceOrgNodeId` / `head.source_org_node_id` 是 org_node_id，而
 * `resolveStaffCreateLocations` 的 fallback 链（`ctx.auth.effectiveStoreId`、
 * `auth.inventoryStoreIds`）给的是 **store_id**。
 *
 * ⚠️ 但 OR 两侧**可以落在不同的两行上**，这正是 #251：
 *   - `location_id` 是主键、`org_node_id` 有 `uq_inventory_locations_org`，各自最多 1 行；
 *   - `syncInventoryLocations` 写的门店行是 `location_id = store_id`、`org_node_id = org-门店-*`
 *     （只有总部/市场行自指），于是**某个 store_id 恰好等于某个 `type='门店'` 的 org_nodes.id**
 *     时，行 X（by location_id）与行 Y（by org_node_id）是两个**不同门店**的主体。
 *
 * 本函数能看到的撞值**只可能是「门店 × 门店」**，两支的挡法不同，别混为一谈：
 *   - X 若是总部/市场自指行 → `X.org_node_id = X.location_id = $1`，与 `Y.org_node_id = $1`
 *     同值，**违反 `uq_inventory_locations_org`**（`ON CONFLICT (location_id)` 管不到
 *     org_node_id 的唯一冲突，所以这一支会在 UPSERT 期真的报错）；
 *   - Y 若是总部/市场自指行 → 两行 `location_id` 同值，但**不会报主键冲突** ——
 *     `syncInventoryLocations` 第二条 UPSERT 的 `ON CONFLICT (location_id) DO UPDATE`
 *     把那个自指行**静默改写成门店行**，最终只剩一行。读取端因此凑不出两行。
 *
 * ⚠️ 上面第二支不是「安全」，是**本函数的盲区**：市场/总部主体被无声顶替，`> 1` 守卫看不见，
 * 且下一轮同步试图恢复自指行时会因残留的 `store_id` 撞上 `inventory_validate_location_tree`
 * 的 `NEW.store_id IS NOT NULL` 校验而 RAISE EXCEPTION —— 那会让**全部库存操作持续失败**。
 * 它的成因与本 issue 同源（store_id 与 org_nodes.id 两个 id 空间无交叉唯一性），
 * 但修复位置在 sync/DB 层而非这里，已登记为 **#270**，勿在本函数里找它的解。
 *
 * 无 `ORDER BY` 的 `LIMIT 1` 在这种两行上取哪行不保证稳定，两次独立调用可能拿到不同门店，
 * 于是「按 A 鉴权、扣 B 的批次」。故：
 *
 *   1. **`throw` 是唯一的正确性保障**：命中两行即 `CONFLICT`，不猜。
 *      ⚠️ 别把它改软成「告警 + 取第一行」—— 撞值时**根本不存在语义正确的那一行**：
 *      一半调用点传的是 org_node_id（`head.source_org_node_id` 等），另一半传的是 store_id
 *      （`resolveStaffCreateLocations` 的 `fallbackStoreId` 链共四项：`payload.storeId`、
 *      `payload.locationId`、`ctx.auth.effectiveStoreId`、单元素时的 `scopedStoreIds[0]`，
 *      全是 store_id）。固定任何一侧优先，都会对另一半调用点**确定性地**返回另一家门店
 *      —— 稳定，但稳定地错，而且从此不再报错。
 *   2. `ORDER BY location_id` 按主键定序（非空、全序），**不暗示任何 id 空间的优先级** ——
 *      撞值时不存在语义正确的那一行，所以它只承诺「确定」，不承诺「对」。
 *      ⚠️ 别因为「2 行必抛、0/1 行与顺序无关」就删掉它：admin 侧的同签名副本带 `FOR UPDATE`，
 *      撞值时两行都会被锁，主键序保证并发事务的**加锁顺序一致**，那是实打实的防死锁作用
 *      （本端无锁，保持字面一致是为了两端可对照）。
 *   3. `LIMIT 2` —— 两侧各最多 1 行，2 是精确上界；回到 `LIMIT 1` 就永远看不见撞值。
 *   4. **停用行照样参与歧义判定**，`is_active` 只在唯一命中项上判。
 *      曾想「把闭店幽灵行过滤掉，免得它把撞值的在营门店锁死」，但那是错的：
 *      设 X 既是在营门店 A 的 `location_id`(=store_id)、又是**停用**门店 Y 的 `org_node_id`，
 *      调用方传 `head.source_org_node_id = X` 时意图明确是 Y（单据里存的就是 org_node_id），
 *      过滤掉 Y 会**静默返回 A**，随后按 A 鉴权、生成 A 的单据 —— 正是本 issue 的危害本体。
 *      停用状态并不能消除入参所属 id 空间的不确定性。
 *
 * 注：与 issue #251 正文的归因不同，这与 `stores.org_node_id` 是否 unique **无关**
 * （`inventory_locations.org_node_id` 早已 UNIQUE，那条路径是 UPSERT 期 fail-loud）。
 * 现网 dev/prod 双库实测撞值均为 0 行，本改动是加固。
 */
async function ensureInventoryLocation(locationId, requiredType = null, client = null) {
  await syncInventoryLocations(client)
  const rows = await queryRows(
    client,
    `SELECT location_id, location_type, parent_location_id, is_active, org_node_id
       FROM inventory_locations
      WHERE location_id = $1 OR org_node_id = $1
      ORDER BY location_id
      LIMIT 2`,
    [locationId],
  )
  if (rows.length === 0) throw new Error('NOT_FOUND: 库存主体不存在')
  if (rows.length > 1) {
    throw new Error('CONFLICT: LOCATION_ID_AMBIGUOUS: 库存主体标识冲突，请联系管理员')
  }
  const row = rows[0]
  // 注：单行停用时本端报 INVALID_STATE，admin `business.ts:loadLocation` 同一数据状态报
  // NOT_FOUND「库存主体不存在或已停用」。两端**决策一致（都拒绝）、错误码不同**，
  // 是各自沿用改动前的对外文案，不是跨端漂移 —— 别当不一致去「修齐」。
  if (row.is_active === false) throw new Error('INVALID_STATE: 库存主体已停用')
  if (requiredType && row.location_type !== requiredType) {
    throw new Error(`INVALID_PARAMS: 库存主体必须是${requiredType}`)
  }
  /**
   * ⚠️ 已知缺陷，**本次刻意不改**（#251 评审提出，范围外）：
   *
   * `org_node_id` 可空（`db/schema/inventory.ts` 无 `.notNull()`，来源 `stores.org_node_id`
   * 同样可空）。这类行只能靠 `location_id = $1` 入选，而下面的 `|| locationId` 会把
   * **入参的 store_id 当组织节点 id 返回**；返回值被 `resolveStaffCreateLocations`
   * 取作 `sourceOrgNodeId` / `targetOrgNodeId` 写进 `inventory_docs` —— 那两列对
   * `inventory_locations.org_node_id` 有 FK（`0039` 迁移），落库会被 FK 挡下、
   * 报一条指不到真正病根的约束错。正解是 fail-loud。
   *
   *（补了撞值守卫之后，「把错误主体钉进单据」那一支已**不可达**：FK 要放行就得存在另一行
   * `org_node_id = $1`，而那恰好就是 `rows.length === 2` → CONFLICT 的条件。
   * 所以本函数现在只会走出「FK 挡下」这一支。）
   *
   * 不在本 PR 改的原因：现网 dev/prod 实测 `org_node_id` 为空的主体行均为 **0**，
   * 属理论缺陷；而改成抛错会打红 13 个既有用例（它们的 mock 行压根不带 `org_node_id`，
   * 一直靠这个兜底跑过）。修它应当连同那批 mock 的保真度一起做，另开 issue。
   *
   * （`location_id` 那侧的兜底则是纯死代码：它是主键，不可能为空 —— 一并留待该 issue 清理。）
   */
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
  /**
   * #235：鉴权主体按**单据方向**推导，不用 `source || target` 取代表值。
   *
   * 这是与审批路径同一个签名的第二处（审批那两处已改）。今天它也只是「碰巧对」：
   * 上面的 switch 对每个类型硬性把另一端置 null，所以第一个非空的恰好就是对的那个。
   * 一旦 `STAFF_CREATE_DOC_TYPES` 加进一个两端都非空、方向为入库的类型，
   * 就会拿 source 鉴权却往无权的 target 加库存 —— 正是 #200 在 admin 修掉的那个洞。
   *
   * 6 个可建类型（#350 起）里只有「院顾客退货」是入库类（已逐一核对 INBOUND/OUTBOUND 归属）。
   */
  /**
   * ⚠️ 这里隐式依赖「非 INBOUND 即由出库方发起」。对 staff 的 6 个可建类型成立
   * （只有「院顾客退货」是 INBOUND），但**不要**把它当成通用的方向判据推广出去：
   * `OUTBOUND_DOC_TYPES` 并非全量方向枚举（例如「分院调货出库/入库」两者都不在里面），
   * 它实际扮演的是「审批方向分类器」。新增可建类型时必须回来核对这条三元。
   */
  const actingLocationId = INBOUND_DOC_TYPES.has(payload.docType)
    ? targetLocation?.location_id
    : sourceLocation?.location_id
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

/**
 * 不带批次的明细（门店报货 / 门店盘点）取 SKU 快照，并校验 SKU 归属——非供应链 SKU 只能在
 * 归属市场（及其门店）使用，与 admin `createDoc` 的 `assertSkuIdAvailableAtLocation` 同一道闸。
 * 两个候选接口（reportableSkuOptions / stocktakeSkuOptions）与这道闸同谓词
 * （供应链 OR 归属本店所属市场），候选能选到的建单一定收；抓包直传别的市场自采 SKU 时建单拦下。
 * `locationId` 契约同 `assertSkuAvailableAtLocation`：必须是 inventory_locations.location_id。
 * `reportableOnly`（门店报货）：同时要求 is_reportable，与 admin 门店报货 `loadSku(tx, skuId, true)`
 * 同口径——候选只出可报货 SKU，直调接口也不能把不可报货的 SKU 写进报货单（下游市场汇总会拒）。
 */
async function inventorySkuSnapshot(client, skuId, locationId, { reportableOnly = false } = {}) {
  const res = await client.query(
    `SELECT sku_id, product_name, spec_name, supplier, product_series, source_type, owner_market_id
       FROM inventory_skus
      WHERE sku_id = $1 AND is_active = true${reportableOnly ? ' AND is_reportable = true' : ''}
      LIMIT 1`,
    [skuId],
  )
  const r = res.rows[0]
  if (!r) {
    throw new Error(reportableOnly
      ? 'NOT_FOUND: 库存 SKU 不存在、已停用或不可报货'
      : 'NOT_FOUND: 库存 SKU 不存在或已停用')
  }
  await assertSkuAvailableAtLocation(client, r, locationId)
  return {
    skuId: r.sku_id,
    skuName: r.product_name,
    specName: r.spec_name || null,
    supplier: r.supplier || null,
    productSeries: r.product_series || null,
  }
}

/**
 * ⚠️ 入参契约：`locationId` 必须是 `ensureInventoryLocation` 返回行的 `location_id`
 * （已是主键值），**不能传 org_node_id**。
 *
 * 下面按 `location_id = $1` 单列查（主键，故确定、无 #251 的 OR 多态歧义），
 * 但这依赖的是**上游契约**而非函数自身保证：门店行的 `location_id`(=store_id) 与
 * `org_node_id`(=org-门店-*) 并不相等，一旦有人直传 `payload.sourceOrgNodeId`，
 * 这里会静默命中 0 行、抛出误导性的「库存主体不存在」，而不是「SKU 不可在该主体使用」。
 *
 * 现有三处调用方都传的是 `<location>.location_id`（`ensureInventoryLotFromSku` 的第二参），
 * 契约成立；新增调用点时务必沿用。
 */
async function assertSkuAvailableAtLocation(client, sku, locationId) {
  // source_type 是 NOT NULL（默认 供应链），`||` 兜底不可达，只为防御旧数据；判定与 admin 同义
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
    `SELECT sku_id, product_name, spec_name, supplier, supplier_id, product_series,
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
  // 批次键锚在 supplier_id 而不是名称（#132）：lotKey 的 supplier 段取 supplierId ?? supplier，
  // 单据头不带供应商的入库（内部领用 / 调货 / 报损…）若只落到文本，供应商一改名，
  // 同批号同效期同价的下一次入库就会算出新的 lot_key，把同一批实物拆成两行库存。
  const supplierId = String(trace?.supplierId || '').trim() || sku.supplier_id || null
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
    const escaped = String(keyword).replace(/[\\%_]/g, '\\$&')
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
   ORDER BY loc.location_type, loc.name, st.sku_name, st.batch_no, st.id
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
    // 与建单闸门 assertSkuAvailableAtLocation、admin listInventorySkus({ availableToMarketId }) 同义
    "(sku.source_type = '供应链' OR sku.owner_market_id = $2)",
  ]
  const params = [sourceOrgNodeId, source.parent_location_id]
  let idx = 3
  if (keyword) {
    const escaped = String(keyword).replace(/[\\%_]/g, '\\$&')
    conditions.push(`(sku.sku_id ILIKE $${idx} OR sku.product_code ILIKE $${idx} OR sku.product_name ILIKE $${idx} OR sku.spec_name ILIKE $${idx})`)
    params.push(`%${escaped}%`)
    idx++
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const countConditions = [
    'sku.is_active = true',
    'sku.is_reportable = true',
    "(sku.source_type = '供应链' OR sku.owner_market_id = $1)",
  ]
  const countParams = [source.parent_location_id]
  if (keyword) {
    const escaped = String(keyword).replace(/[\\%_]/g, '\\$&')
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
 * 门店盘点可选 SKU（#352）。
 *
 * 与 reportableSkuOptions 的差别在口径：盘点要能盘到本店手上的任何货，不限 is_reportable
 * （admin 盘点同样用全量 SKU 检索）。归属谓词与建单闸门 `assertSkuAvailableAtLocation`、
 * admin `listInventorySkus({ availableToMarketId })` 逐字同义：供应链 SKU 或归属本店所属市场——
 * 候选能选到的，createDoc 一定收；候选选不到的，createDoc 一定拒。
 *
 * 刻意**不下发账面数**：盘点是盲盘，录入时看到账面数就会照抄；账面数由 createDoc 在提交时记入
 * stock_snapshot。本店有货的 SKU 排在前面，免得在全量目录里翻找。
 */
async function stocktakeSkuOptions(ctx) {
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
    throw new Error('INVALID_STATE: 当前门店未关联市场，无法查询盘点 SKU')
  }

  const limit = Math.max(1, Math.min(100, parseInt(pageSize, 10) || 50))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit
  // 主查询与 count 共用同一组条件与参数（$1 = 市场，$2 = 关键词），口径不会漂；
  // 本店主体只在排序里用，放在最后一个参数。
  const conditions = [
    'sku.is_active = true',
    "(sku.source_type = '供应链' OR sku.owner_market_id = $1)",
  ]
  const params = [source.parent_location_id]
  if (keyword) {
    // 反斜杠也要转义：ILIKE 默认转义符就是 \，结尾单个 \ 会让 PG 直接报错
    const escaped = String(keyword).replace(/[\\%_]/g, '\\$&')
    conditions.push('(sku.sku_id ILIKE $2 OR sku.product_code ILIKE $2 OR sku.product_name ILIKE $2 OR sku.spec_name ILIKE $2)')
    params.push(`%${escaped}%`)
  }
  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const storeParamIndex = params.length + 1
  const rows = await pg.query(
    `SELECT sku.sku_id, sku.product_code, sku.product_name, sku.spec_name,
            sku.supplier, sku.product_series,
            EXISTS (
              SELECT 1 FROM inventory_stock_lots lot
               WHERE lot.sku_id = sku.sku_id
                 AND lot.location_id = $${storeParamIndex}
                 AND lot.quantity_on_hand > 0
            ) AS in_stock
       FROM inventory_skus sku
       ${whereSql}
   ORDER BY in_stock DESC, sku.product_name, sku.spec_name NULLS LAST, sku.sku_id
      LIMIT ${limit} OFFSET ${offset}`,
    [...params, source.location_id],
  )
  const countRows = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM inventory_skus sku
       ${whereSql}`,
    params,
  )

  ctx.result = {
    items: rows.map((row) => ({
      skuId: row.sku_id,
      productCode: row.product_code,
      skuName: row.product_name,
      specName: row.spec_name || null,
      supplier: row.supplier || null,
      productSeries: row.product_series || null,
      inStock: Boolean(row.in_stock),
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
    const escaped = String(keyword).replace(/[\\%_]/g, '\\$&')
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
   ORDER BY d.doc_date DESC, d.created_at DESC, d.id DESC
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
            source_loc.location_id AS source_store_loc_id,
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
    // 门店报货草稿（#348）：小程序据此判断「是不是当前门店的草稿」再给继续编辑 / 删除入口
    sourceLocationId: r.source_store_loc_id || null,
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

/**
 * 门店报货草稿（#348）：锁住并校验一张本门店的门店报货草稿。与 admin `lockStoreReplenishmentDraft` 同口径：
 * 非门店报货 NOT_FOUND；非草稿 INVALID_STATE（已删除 / 已提交分开提示）；换门店 INVALID_PARAMS；
 * 带血缘 / 预留的只可能是存量异常单，一律 INVALID_STATE 交人工处理。
 * `check` = 存草稿 / 提交时的额外校验（当前市场 + 打开草稿时的版本，版本**必填**）；删除不传（不比市场、不比版本）。
 */
async function lockStoreRequestDraft(client, draftId, sourceOrgNodeId, check = null) {
  const { rows } = await client.query(
    `SELECT id, doc_type, status, source_org_node_id, market_id,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
       FROM inventory_docs
      WHERE id = $1
        AND doc_type = '门店报货'
      FOR UPDATE`,
    [draftId],
  )
  const draft = rows[0]
  if (!draft || draft.doc_type !== '门店报货') throw new Error('NOT_FOUND: 门店报货草稿不存在')
  if (draft.status !== '草稿') {
    throw new Error(draft.status === '已取消'
      ? 'INVALID_STATE: 该门店报货草稿已删除'
      : 'INVALID_STATE: 门店报货已提交，不能再修改或删除')
  }
  if (sourceOrgNodeId !== undefined && draft.source_org_node_id !== sourceOrgNodeId) {
    throw new Error('INVALID_PARAMS: 草稿的报货门店不能修改')
  }
  // 草稿存续期间门店改挂了别的市场：单头市场归属不会随状态更新重算（与 admin 同口径）；删除不受此限
  if (check && draft.market_id !== check.marketId) {
    throw new Error('INVALID_STATE: 门店已更换所属市场，请删除该草稿后重新报货')
  }
  // 草稿乐观锁（与 admin assertDraftUnchanged 同口径）：版本必填，缺了不能退化成「不校验」
  if (check) {
    const expectedUpdatedAt = check.expectedUpdatedAt
    if (expectedUpdatedAt == null || expectedUpdatedAt === '') {
      throw new Error('INVALID_PARAMS: 缺少草稿版本，请重新打开草稿后再保存')
    }
    const expected = Date.parse(expectedUpdatedAt)
    if (Number.isNaN(expected)) throw new Error('INVALID_PARAMS: 草稿版本格式不正确')
    if (!draft.updated_at_iso || Date.parse(draft.updated_at_iso) !== expected) {
      throw new Error('CONFLICT: 草稿已被他人修改，请重新打开后再保存')
    }
  }
  const linked = await client.query(
    `SELECT (EXISTS (SELECT 1 FROM inventory_doc_links WHERE from_doc_id = $1 OR to_doc_id = $1)
          OR EXISTS (SELECT 1 FROM inventory_stock_reservations WHERE request_doc_id = $1)) AS linked`,
    [draftId],
  )
  if (linked.rows[0]?.linked) {
    throw new Error('INVALID_STATE: 该草稿已有上下游关联，不能按草稿修改或删除，请联系管理员处理')
  }
  return draft
}

/**
 * 建单 + 门店报货草稿（#348）共用一条写路径，明细校验只有一份：
 * - `draft: true` → 单头状态「草稿」、不确认（仅门店报货）；草稿不进任何下游（admin 汇总 / 市场报货 / 分院配货只认已完成）
 * - `draftId` → 在该草稿上原单号写入：明细整体重写；`draft: true` 仍是草稿，否则转「已完成」（提交，之后锁定）
 * `updateDraft` / `submitDraft` 只是固定这两个参数的入口。
 */
async function createDoc(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const payload = ctx.event.payload || {}
  const { docType, items = [] } = payload
  if (!isValidDocType(docType) || !isStaffCreateDocType(docType)) {
    throw new Error('INVALID_PARAMS: staff 端不支持创建该库存单据')
  }
  // draft 只收布尔：'true' / 1 这类真值若按 false 处理会静默落成不可逆的「已完成」
  if (payload.draft !== undefined && payload.draft !== null && typeof payload.draft !== 'boolean') {
    throw new Error('INVALID_PARAMS: 草稿参数格式不正确')
  }
  const asDraft = payload.draft === true
  const draftId = payload.draftId == null ? null : String(payload.draftId).trim()
  if (payload.draftId != null && !draftId) throw new Error('INVALID_PARAMS: 缺少草稿单号')
  if ((asDraft || draftId) && docType !== '门店报货') {
    throw new Error('INVALID_PARAMS: 只有门店报货支持草稿')
  }
  // 门店报货同一 SKU 只能一行（与 admin createStoreReplenishmentRequest 同文案）：两行同 SKU 的单
  // 会让市场汇总 / 分院配货各算一遍，admin 继续编辑时也会被拒
  if (docType === '门店报货' && Array.isArray(items)) {
    const seenReportSkus = new Set()
    for (const item of items) {
      const skuId = String(item?.skuId || '').trim()
      if (skuId && seenReportSkus.has(skuId)) throw new Error('INVALID_PARAMS: 同一 SKU 请合并为一条报货明细')
      seenReportSkus.add(skuId)
    }
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
    actingLocationId,
  } = await resolveStaffCreateLocations(ctx, payload)
  // 盘点单：一个 SKU 只能一行。账面数按「主体 + SKU 汇总」记，同 SKU 两行会各自
  // 拿到同一个完整账面数，差异直接变成重复计算的废数。放在开事务前拦，失败不占锁。
  const stocktakeSkuIds = []
  if (STOCKTAKE_DOC_TYPES.has(docType)) {
    const seen = new Set()
    for (const item of items) {
      const skuId = String(item.skuId || '').trim()
      if (!skuId) throw new Error('INVALID_PARAMS: 明细缺少库存 SKU')
      if (seen.has(skuId)) throw new Error('INVALID_PARAMS: 同一 SKU 请合并为一条盘点明细')
      seen.add(skuId)
      stocktakeSkuIds.push(skuId)
    }
  }
  const status = asDraft ? '草稿' : defaultDocStatus(docType)
  // 同一批次的待审批退货需按稳定顺序锁库存，降低多明细并发提交的死锁概率。
  const orderedItems = docType === '院退货'
    ? [...items].sort((left, right) => Number(left.lotId) - Number(right.lotId))
    : items
  const totalQuantity = orderedItems.reduce((acc, item) => acc + assertDocItemQty(docType, item.quantity), 0)
  const plan = movementPlan(docType, status)
  if (RECEIVE_REQUIRED_DOC_TYPES.has(docType) && !targetOrgNodeId) {
    throw new Error('INVALID_PARAMS: 待收货单据缺少接收主体')
  }
  if (plan?.role === 'source' && !sourceOrgNodeId) throw new Error('INVALID_PARAMS: 出库类单据缺少出库主体')
  if (plan?.role === 'target' && !targetOrgNodeId) throw new Error('INVALID_PARAMS: 入库类单据缺少入库主体')
  let docId

  let updatedAt = null
  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    if (docType === '门店报货') {
      // 市场归属在事务外按门店父级解析；这里对门店行取共享锁并复读父级：解析与写入之间门店被改挂市场时拒绝，
      // 且在本事务结束前挡住改挂（与 admin 的门店 → 市场 → 单据锁序同向）
      // 门店与市场两行一起复核（类型 / 启用 / 父级）：解析后门店被闭店或市场被停用也要拒，不能写出指向停用主体的单
      const { rows: endpointRows } = await client.query(
        `SELECT location_id, location_type, is_active, parent_location_id
           FROM inventory_locations
          WHERE location_id = ANY($1::text[])
          ORDER BY location_id
          FOR SHARE`,
        [[sourceLocationId, marketId].filter(Boolean)],
      )
      const storeRow = endpointRows.find((row) => row.location_id === sourceLocationId)
      const marketRow = endpointRows.find((row) => row.location_id === marketId)
      if (!storeRow || !marketRow || storeRow.location_type !== '门店' || marketRow.location_type !== '市场') {
        throw new Error('CONFLICT: 门店所属市场刚发生变化，请刷新后重试')
      }
      if (storeRow.is_active === false || marketRow.is_active === false) {
        throw new Error('INVALID_STATE: 库存主体已停用')
      }
      if ((storeRow.parent_location_id || null) !== marketId) {
        throw new Error('CONFLICT: 门店所属市场刚发生变化，请刷新后重试')
      }
    }
    if (draftId) {
      // 草稿没有血缘 / 预留 / 流水（lockStoreRequestDraft 已核对），明细整体重写；合计由明细 trigger 回填
      // `|| null`：解析不出门店节点时按 null 比对（fail-closed），不能退化成「跳过门店核对」
      await lockStoreRequestDraft(client, draftId, sourceOrgNodeId || null, {
        marketId: marketId || null,
        expectedUpdatedAt: payload.expectedUpdatedAt,
      })
      docId = draftId
      await client.query('DELETE FROM inventory_doc_items WHERE doc_id = $1', [draftId])
      await client.query(
        `UPDATE inventory_docs
            SET status = $2,
                doc_date = $3,
                total_quantity = $4,
                remark = $5,
                confirmed_by = $6,
                confirmed_at = CASE WHEN $7::boolean THEN NOW() ELSE NULL END,
                updated_at = NOW()
          WHERE id = $1`,
        [
          draftId,
          status,
          payload.docDate || shanghaiToday(),
          totalQuantity,
          payload.remark || null,
          status === '已完成' ? ctx.auth.staffWfId : null,
          status === '已完成',
        ],
      )
    } else {
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
    }
    // 盘点单账面数：**一次 GROUP BY 取齐**，不逐行查。
    // 两个理由：① 少 N 次事务内往返，事务持有时间短；② 同一张单所有行的账面数取自
    // **同一个语句快照**（逐条 SELECT 在 READ COMMITTED 下各取各的快照，一张「账面 vs 实盘」
    // 的单会失去单一时点语义）。
    // ⚠️ 别照搬 admin 那边「持有全局串行锁」的说法：staff 的
    // `assertWorkfineInventoryInitialized` 用的是 `FOR KEY SHARE`（共享锁，多个库存事务
    // 可同时持有、也挡不住普通 `quantity_on_hand` 更新）；admin 的 `cutover.ts` 才是
    // `FOR UPDATE`。两端锁强度不同，别互相套用结论。
    const bookQuantityBySkuId = new Map()
    if (stocktakeSkuIds.length > 0) {
      const { rows: bookRows } = await client.query(
        `SELECT sku_id, COALESCE(SUM(quantity_on_hand), 0) AS quantity
           FROM inventory_stock_lots
          WHERE location_id = $1 AND sku_id = ANY($2::text[])
          GROUP BY sku_id`,
        [actingLocationId, stocktakeSkuIds],
      )
      // 账面数刻意**不扣预留**（#131 Q0）：盘点比的是账面与货架上的实物，预留是承诺、货还在架上。
      for (const row of bookRows) bookQuantityBySkuId.set(row.sku_id, Number(row.quantity))
    }

    for (const item of orderedItems) {
      const qty = assertDocItemQty(docType, item.quantity)
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
        snapshot = await inventorySkuSnapshot(client, item.skuId, actingLocationId, {
          reportableOnly: docType === '门店报货',
        })
      }
      // 盘点单没有批次选择器，lot 恒为 null —— 账面数只能来自上面的汇总。
      // 一个批次都没有时 GROUP BY 不出行，落 0（不是 NULL）：账上就是 0，实盘有货即盘盈。
      const bookQuantity = STOCKTAKE_DOC_TYPES.has(docType)
        ? bookQuantityBySkuId.get(String(item.skuId || '').trim()) ?? 0
        : null
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
          lot ? lot.quantityOnHand : bookQuantity,
          // 门店报货的需求量 / 已配量与 admin 同口径（= 数量 / 0），不收客户端值 —— 它们参与市场汇总与分院配货的可配量（#348）
          docType === '门店报货' ? qty : item.requestQuantity || null,
          docType === '门店报货' ? 0 : item.fulfilledQuantity || null,
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
    // 草稿回传新版本号（事务内、持草稿行锁读取，拿到的一定是本次写入的版本）：
    // 留在编辑态的页面下一次保存拿它做乐观锁。提交后是终态，不需要版本
    if (asDraft) {
      const { rows: versionRows } = await client.query(
        `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
           FROM inventory_docs WHERE id = $1`,
        [docId],
      )
      updatedAt = versionRows[0]?.updated_at_iso || null
    }
  })

  ctx.result = { id: docId, draft: asDraft, updatedAt, message: asDraft ? '草稿已保存' : '提交成功' }
  return ctx.result
}

/** 更新门店报货草稿（#348）：payload 与 createDoc 相同，另带 `draftId`；仍是草稿。 */
async function updateDraft(ctx) {
  const payload = ctx.event.payload || {}
  if (!payload.draftId) throw new Error('INVALID_PARAMS: 缺少草稿单号')
  ctx.event.payload = { ...payload, draft: true }
  return createDoc(ctx)
}

/** 提交门店报货草稿（#348）：按当前明细重写并转「已完成」，之后锁定（提交即终态）。 */
async function submitDraft(ctx) {
  const payload = ctx.event.payload || {}
  if (!payload.draftId) throw new Error('INVALID_PARAMS: 缺少草稿单号')
  ctx.event.payload = { ...payload, draft: false }
  return createDoc(ctx)
}

/**
 * 删除门店报货草稿（#348）= 草稿 → 已取消（不物理删除：单号按当天最大号 +1 生成，删了会被复用；且保留审计）。
 * 只能删本人有门店库存写权限的门店的草稿；不校验门店是否启用。
 */
async function deleteDraft(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const payload = ctx.event.payload || {}
  const draftId = String(payload.id || payload.draftId || '').trim()
  if (!draftId) throw new Error('INVALID_PARAMS: 缺少草稿单号')
  const reason = String(payload.reason || '').trim() || '删除草稿'
  await pg.transaction(async (client) => {
    await assertWorkfineInventoryInitialized(client)
    // 先无锁取门店做 scope 断言，再锁单判状态：越权的人拿不到别店单据的锁，也探不出它的状态
    const { rows } = await client.query(
      `SELECT loc.location_id
         FROM inventory_docs d
         JOIN inventory_locations loc ON loc.org_node_id = d.source_org_node_id AND loc.location_type = '门店'
        WHERE d.id = $1 AND d.doc_type = '门店报货'
        ORDER BY loc.location_id
        LIMIT 1`,
      [draftId],
    )
    if (!rows[0]) throw new Error('NOT_FOUND: 门店报货草稿不存在')
    await assertInventoryWriteStoreScope(client, ctx.auth, rows[0].location_id)
    await lockStoreRequestDraft(client, draftId, undefined)
    await client.query(
      `UPDATE inventory_docs
          SET status = '已取消',
              cancellation_reason = $2,
              cancelled_by = $3,
              cancelled_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [draftId, reason, ctx.auth.staffWfId],
    )
  })
  ctx.result = { id: draftId, message: '草稿已删除' }
  return ctx.result
}

async function approveStoreReturnForRestock(client, head, ctx, auditRemark, actingStore) {
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
  // #235：与 approveDoc 鉴权用的是同一个主体（出库方门店），由调用方传入复用。
  // ensureStoreLocation 内部还会跑一次 syncInventoryLocations，重复调用纯属浪费；
  // 更要紧的是两次独立调用曾可能返回**不同门店**的主体，那会变成「按 A 鉴权、扣 B 的批次」。
  // 复用同一结果把这个窗口一并关掉。
  //
  // ⚠️ 归因订正（#251）：该不确定性**不是**「同一 org_node 挂两个 store」造成的
  //（`inventory_locations.org_node_id` 早有 UNIQUE，那条路径在 UPSERT 期就 fail-loud），
  // 而是 `location_id = $1 OR org_node_id = $1` 的两侧可落在两行上 —— 详见
  // `ensureInventoryLocation` 的函数注释。函数本身已在 #251 补了 ORDER BY + 撞值抛 CONFLICT，
  // 这里的复用仍然保留：它同时省掉一次 syncInventoryLocations，且语义上就该是同一个主体。
  const sourceLocation = actingStore
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
    /**
     * 次序：source 空检查 → ensure → 鉴权 → status → 方向守卫。
     *
     * 空检查必须在 `ensureStoreLocation` 之前（传 null 进去会抛误导性的「库存主体不存在」），
     * 而 ensure 又必须在鉴权之前（`assertApproverStoreScope` 吃的是 location_id）——
     * 这是 staff 与 admin 的结构性差异：admin 直接拿 org_node_id 鉴权，能把 ensure 排到鉴权之后。
     *
     * 方向守卫刻意放在鉴权**之后**：它一度被提到最前面，结果让无权调用者能区分
     * 「该单不属可审批类型」（INVALID_STATE）与「无权审批该门店」（PERMISSION_DENIED），
     * 凭空多泄漏 1 bit。现在恢复成与旧行为一致。
     *
     * ⚠️ 但**不能**说成「无权者一律先拿 PERMISSION_DENIED」：source 空检查仍在鉴权之前，
     * 所以「source 为空」这一位对无权者仍可见（codex 谱系指出注释与实现不符）。
     * 保持现状是权衡后的选择：
     *   - 去掉空检查 → `ensureStoreLocation(null)` 抛 `NOT_FOUND: 库存主体不存在`，
     *     同样可区分，只是换了个错误码，白白损失一条可读的诊断信息；
     *   - 按「先用 target 做一次仅用于信息披露控制的 scope gate」来堵 → 要在这里写出
     *     「拿 target 鉴权」的代码路径，而那正是本 issue 要消灭的东西，后来者极易误读误用。
     * 而这一位在**当前所有可达类型上不可达**：`STAFF_VISIBLE ∩ APPROVAL` = {院退货, 院产品报损}，
     * 前者 source 恒非空、后者同主体，source 为空只可能是数据异常。已补用例钉住
     * 「source 为空且 target 也无权」时同样不产生任何副作用。
     */
    if (!head.source_org_node_id) throw new Error('INVALID_STATE: 待审批单据缺少出库主体')
    const actingStore = await ensureStoreLocation(head.source_org_node_id, client)
    await assertApproverStoreScope(client, ctx.auth, actingStore.location_id)
    if (head.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以审批')
    assertApprovalOutboundDirection(head.doc_type)
    const direction = '出库'
    if (head.doc_type === '院退货') {
      await approveStoreReturnForRestock(client, head, ctx, auditRemark, actingStore)
      return
    }
    const itemRes = await client.query(
      `SELECT id, lot_id, quantity, sale_item_id
         FROM inventory_doc_items
        WHERE doc_id = $1
     ORDER BY id`,
      [id],
    )
    // 与上面鉴权用的是同一个主体（出库方），复用结果——ensureStoreLocation 内部还会跑一次
    // syncInventoryLocations，重复调用纯属浪费。
    const sourceLocation = actingStore
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
    // 次序同 approveDoc：方向守卫在鉴权之后，避免多泄漏「是否可审批类型」这 1 bit
    if (!doc.source_org_node_id) throw new Error('INVALID_STATE: 待审批单据缺少出库主体')
    const actingStore = await ensureStoreLocation(doc.source_org_node_id, client)
    await assertApproverStoreScope(client, ctx.auth, actingStore.location_id)
    if (doc.status !== '待审批') throw new Error('INVALID_STATE: 只有待审批单据可以驳回')
    assertApprovalOutboundDirection(doc.doc_type)
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
  stocktakeSkuOptions,
  storeOptions,
  docOrgOptions,
  docList,
  docDetail,
  createDoc,
  updateDraft,
  submitDraft,
  deleteDraft,
  confirmReceive,
  approveDoc,
  rejectDoc,
  uploadReceipt,
}
