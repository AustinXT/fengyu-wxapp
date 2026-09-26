#!/usr/bin/env bun
/**
 * inventory.docList / inventory.docDetail 冒烟（门店库存单据只读，店长视角）
 *
 * 覆盖员工端实际使用的 v3 单据接口，而不是已保留的旧 inventory.list/detail 兼容路由。
 * 夹具构造一张已完成的“院入库”单，验证店长按库存主体可见、无效单据类型被拒绝，
 * 以及详情能够返回 v3 单据头和批次明细。
 *
 * #352 门店盘点：盘点 SKU 候选（不限可报货、不带账面数）→ 建盘点单（一个实盘=账面、一个实盘 0）
 * → SQL 断言 stock_snapshot = 该店该 SKU 在手量汇总、不产流水、在手量不变 → 列表 / 详情可见；
 * 同 SKU 两行、实盘留空被拒。
 * ⚠️ 实盘 0 依赖迁移 0053（#351 放宽 quantity CHECK）；目标库没迁 0053 时这一步会被 CHECK 拒绝。
 * 盘点身份是**只绑门店库存员、不是店长**的测试员工（默认门店库存员 can_access_admin=false，
 * 只能在小程序盘点）。
 * 账面非零：共享 dev 库上批次余额只能经 append-only 的 inventory_movements 入账、删不掉，
 * 所以默认夹具账面恒 0（只能验证「无批次落 0」）。在**私有 docker 库**上设
 * SMOKE_INVENTORY_SEED_STOCK=<私有库库名>，会绕过余额守护给两个 SKU 灌非零余额（SKU1 两个批次 5+3，
 * SKU2 一个批次 4），验证账面 = 多批次汇总、实盘 0 记盘亏。
 * #358 确认收货只收剩余量（仅私有库，会写删不掉的流水）：分院配货已收 3/10 → 入 7、血缘 7、fulfilled 10。
 * 私有库判定不只看 localhost（SSH 端口转发的共享库也是 localhost）：还要求连上的 current_database()
 * 与该变量值相同，且不是共享库名 fengyu_wxapp。
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_MARKET_ORG_ID, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID,
  pgQuery, closePool, getPool, testPhone,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestPermissionRole, cleanupTestData,
} from './helpers/fixtures.mjs'

const INV_DOC_ID = `${NS}_INV_PROC_1`
const INV_SKU_ID = `${NS}_INV_SKU_1`
// 盘点第二个 SKU：非可报货、本店没有任何批次（账面 0）
const INV_SKU_ID_2 = `${NS}_INV_SKU_2`
// 只绑门店库存员（不是店长）的盘点员工
const INV_OPERATOR_EMP_ID = `${NS}_INVOP`
const INV_OPERATOR_OPENID = `${NS}_INVOP_OPENID`

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function createInventoryFixture() {
  await pgQuery(
    `INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id)
     SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id
       FROM stores s
       LEFT JOIN org_nodes o ON o.id = s.org_node_id
      WHERE s.store_id = $1
     ON CONFLICT (location_id) DO UPDATE
       SET location_type = EXCLUDED.location_type,
           name = EXCLUDED.name,
           org_node_id = EXCLUDED.org_node_id,
           store_id = EXCLUDED.store_id,
           parent_location_id = EXCLUDED.parent_location_id,
           updated_at = NOW()`,
    [TEST_STORE_ID],
  )
  await pgQuery(
    // market_purchase_price_mode 必须显式给：0039 的 trigger
    // trg_inventory_skus_validate_market_price_mode 对非「公式」模式要求同时有
    // market_purchase_price 与 override_reason，而这三列的默认值都是 NULL ——
    // 不写就会在建夹具阶段抛「手工覆盖市场进货价必须填写价格和原因」。
    // 这里走「公式」：trigger 自己用 accounting_price × discount 算出进货价。
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, retail_price, is_active,
       accounting_price, market_purchase_discount, market_purchase_price_mode
     )
     VALUES ($1, $2, $3, '默认规格', 100, true, 50, 0.8, '公式')
     ON CONFLICT (sku_id) DO UPDATE
       SET product_code = EXCLUDED.product_code,
           product_name = EXCLUDED.product_name,
           spec_name = EXCLUDED.spec_name,
           retail_price = EXCLUDED.retail_price,
           accounting_price = EXCLUDED.accounting_price,
           market_purchase_discount = EXCLUDED.market_purchase_discount,
           market_purchase_price_mode = EXCLUDED.market_purchase_price_mode,
           is_active = true,
           updated_at = NOW()`,
    [INV_SKU_ID, `${NS}_PCODE_1`, `${NS}_采购商品`],
  )
  await pgQuery(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, retail_price, is_active, is_reportable,
       accounting_price, market_purchase_discount, market_purchase_price_mode
     )
     VALUES ($1, $2, $3, '默认规格', 100, true, false, 50, 0.8, '公式')
     ON CONFLICT (sku_id) DO UPDATE
       SET is_active = true, is_reportable = false, updated_at = NOW()`,
    [INV_SKU_ID_2, `${NS}_PCODE_2`, `${NS}_盘点商品`],
  )
  const lots = await pgQuery(
    // 余额必须是 0 且不能在 DO UPDATE 里改：0009 的
    // trg_inventory_stock_lots_guard_balance 要求新批次从零起步、余额只能经
    // inventory_movements 写入。而 movements 是 append-only（删不掉），在共享
    // dev 库里入账会给 cleanupTestData 留下删不掉的残留 —— 所以这里不入账。
    // 本 smoke 只测 docList / docDetail 两个只读接口，明细数量取自
    // inventory_doc_items（不受余额守护约束），零余额批次完全够用。
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, spec_name, batch_no, expiry_date_key,
       is_gift, quantity_on_hand, store_standard_unit_price, store_actual_unit_price
     )
     VALUES ($1, $2, $2 || '|INV||||100', $3, '默认规格', 'INV', '', false, 0, 100, 100)
     ON CONFLICT (location_id, lot_key)
     DO UPDATE SET sku_name = EXCLUDED.sku_name,
                   spec_name = EXCLUDED.spec_name,
                   updated_at = NOW()
     RETURNING id`,
    [TEST_STORE_ID, INV_SKU_ID, `${NS}_采购商品`],
  )
  const lotId = lots[0]?.id
  await pgQuery(
    `INSERT INTO inventory_docs (
       id, doc_type, status, target_org_node_id, doc_date, total_quantity,
       remark, created_by, confirmed_by, confirmed_at
     )
     VALUES ($1, '院入库', '已完成', $2, CURRENT_DATE, 5, $3, $4, $4, NOW())
     ON CONFLICT (id) DO UPDATE
       SET target_org_node_id = EXCLUDED.target_org_node_id,
           total_quantity = EXCLUDED.total_quantity,
           status = EXCLUDED.status,
           updated_at = NOW()`,
    [INV_DOC_ID, TEST_STORE_ORG_ID, `${NS}_采购备注`, TEST_MANAGER_EMP_ID],
  )
  await pgQuery(
    `INSERT INTO inventory_doc_items (
       doc_id, lot_id, sku_id, sku_name, spec_name, batch_no, is_gift,
       quantity, stock_snapshot, standard_unit_price, actual_unit_price, amount
     )
     SELECT $1, $2, $3, $4, '默认规格', 'INV', false, 5, 0, 100, 100, 500
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_doc_items WHERE doc_id = $1 AND sku_id = $3
      )`,
    [INV_DOC_ID, lotId, INV_SKU_ID, `${NS}_采购商品`],
  )
}

async function main() {
  rec('[smoke-inventory] start')
  await purgePrivateInventoryLedger()
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  // 门店库存单据的可见性挂在库存角色上：middleware/auth.js 只给带
  // inventory:store_operate / market_operate / market_approve 的绑定填
  // auth.inventoryStoreIds，而 buildInventoryLocationScope 在该集合为空时直接
  // 退化成 WHERE FALSE。只有 manager 角色的店长查不到任何库存单据（设计如此），
  // 所以夹具必须显式补一条门店库存员绑定。
  await createTestPermissionRole({
    employeeId: TEST_MANAGER_EMP_ID,
    role: 'inventory_store_operator',
    scopeId: TEST_STORE_ORG_ID,
  })
  await createInventoryFixture()

  const errors = []
  const rList = await invokeStaffApi('inventory.docList', {
    _testOpenid: TEST_MANAGER_OPENID,
    docType: '院入库',
    page: 1,
    pageSize: 20,
  })
  if (rList.code !== 0) {
    errors.push(`inventory.docList code=${rList.code} msg=${rList.message}`)
  } else {
    const items = rList.data?.items || []
    const found = items.find((item) => item.id === INV_DOC_ID)
    if (!found) {
      errors.push(`inventory.docList 应含本店单据 ${INV_DOC_ID}，实际 ${items.length} 项`)
    } else {
      if (found.targetOrgNodeId !== TEST_STORE_ORG_ID) {
        errors.push(`list.targetOrgNodeId=${found.targetOrgNodeId}，期望 ${TEST_STORE_ORG_ID}`)
      }
      if (found.docType !== '院入库') errors.push(`list.docType=${found.docType}，期望 院入库`)
      if (found.status !== '已完成') errors.push(`list.status=${found.status}，期望 已完成`)
      if (errors.length === 0) rec(`  ✓ inventory.docList 含本店 v3 单据（接收主体=${found.targetOrgNodeName}）`)
    }
  }

  const rBad = await invokeStaffApi('inventory.docList', {
    _testOpenid: TEST_MANAGER_OPENID,
    docType: 'not_a_doc_type',
  })
  if (rBad.code !== -400) {
    errors.push(`非法 docType 期望 code=-400，实际 code=${rBad.code} msg=${rBad.message}`)
  } else {
    rec('  ✓ inventory.docList 非法 docType → INVALID_PARAMS')
  }

  const rDetail = await invokeStaffApi('inventory.docDetail', {
    _testOpenid: TEST_MANAGER_OPENID,
    id: INV_DOC_ID,
  })
  if (rDetail.code !== 0) {
    errors.push(`inventory.docDetail code=${rDetail.code} msg=${rDetail.message}`)
  } else {
    const detail = rDetail.data || {}
    if (detail.id !== INV_DOC_ID) errors.push(`detail.id=${detail.id}，期望 ${INV_DOC_ID}`)
    if (detail.targetOrgNodeId !== TEST_STORE_ORG_ID) {
      errors.push(`detail.targetOrgNodeId=${detail.targetOrgNodeId}，期望 ${TEST_STORE_ORG_ID}`)
    }
    const item = (detail.items || []).find((row) => row.skuId === INV_SKU_ID)
    if (!item) {
      errors.push(`detail.items 应含 ${INV_SKU_ID}`)
    } else if (Number(item.quantity) !== 5) {
      errors.push(`detail.items 数量=${item.quantity}，期望 5`)
    }
    if (errors.length === 0) rec(`  ✓ inventory.docDetail 返回单据头 + ${(detail.items || []).length} 行 v3 明细`)
  }

  await stocktakeFlow(errors)
  await receiveRemainderFlow(errors)

  if (errors.length) {
    rec('  ✗ FAIL')
    for (const error of errors) rec(`    - ${error}`)
    return
  }
  pass = true
  exitCode = 0
  rec('  ✅ PASS')
}

/**
 * 仅私有库：绕过余额守护灌非零余额（见文件头）。共享 dev 库上 movements 删不掉，不能走正规入账。
 * 返回是否已灌数。
 */
/** 本流程在私有库上补的期初状态行：结束时删掉，不留全局副作用 */
let insertedCutover = false

/** 共享库（dev / prod）的库名：灌数模式遇到一律拒绝 */
const SHARED_DATABASE_NAMES = new Set(['fengyu_wxapp'])

/**
 * 灌数模式只允许显式点名的私有库：SMOKE_INVENTORY_SEED_STOCK 的值必须等于连上的库名，
 * 且 host 为 localhost、库名不是共享库名。任一不满足直接抛错（不静默降级为普通跑法）。
 */
async function isPrivateSeedRun() {
  const expected = process.env.SMOKE_INVENTORY_SEED_STOCK
  if (!expected) return false
  const host = new URL(process.env.PG_CONNECTION_STRING).hostname
  const [{ db }] = await pgQuery('SELECT current_database() AS db')
  if (!['localhost', '127.0.0.1'].includes(host) || db !== expected || SHARED_DATABASE_NAMES.has(db)) {
    throw new Error(`SMOKE_INVENTORY_SEED_STOCK 只允许点名的私有库：host=${host} db=${db} 期望=${expected}`)
  }
  return true
}

async function seedStocktakeBook() {
  if (!(await isPrivateSeedRun())) return false
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL session_replication_role = 'replica'")
    const lots = [
      [INV_SKU_ID, 'INV', 5],
      [INV_SKU_ID, 'INV2', 3],
      [INV_SKU_ID_2, 'INV3', 4],
    ]
    for (const [skuId, batchNo, qty] of lots) {
      await client.query(
        `INSERT INTO inventory_stock_lots (
           location_id, sku_id, lot_key, sku_name, spec_name, batch_no, expiry_date_key, is_gift, quantity_on_hand
         )
         VALUES ($1, $2, $2 || '|' || $3 || '||||100', $2, '默认规格', $3, '', false, $4)
         ON CONFLICT (location_id, lot_key) DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand`,
        [TEST_STORE_ID, skuId, batchNo, qty],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** #352：门店库存员在小程序做门店盘点的整条后端链路 */
async function stocktakeFlow(errors) {
  const before = errors.length
  await createTestStaff({
    employeeId: INV_OPERATOR_EMP_ID,
    openid: INV_OPERATOR_OPENID,
    phone: testPhone(13),
    name: `${NS}_库存员`,
    isManager: false,
    positionName: '门店库存员',
    skills: [],
  })
  await createTestPermissionRole({
    employeeId: INV_OPERATOR_EMP_ID,
    role: 'inventory_store_operator',
    scopeId: TEST_STORE_ORG_ID,
  })
  // createDoc 要求 WorkFine 期初已核验。这是全局业务闸门：共享库上**只读检查**，不满足就失败，
  // 绝不替它补「已初始化」（缺行本身就表示期初没做，补了等于永久打开全库的库存写闸）。
  // 只有私有 localhost 库（灌数模式）才临时补行，并在本流程结束时删掉自己补的那行。
  const cutover = await pgQuery(`SELECT status FROM inventory_cutover_states WHERE cutover_key = 'workfine_inventory'`)
  if (!cutover[0] && (await isPrivateSeedRun())) {
    await pgQuery(`INSERT INTO inventory_cutover_states (cutover_key, status) VALUES ('workfine_inventory', '已初始化')`)
    insertedCutover = true
  } else if (cutover[0]?.status !== '已初始化') {
    errors.push(`目标库 WorkFine 库存期初状态为「${cutover[0]?.status ?? '缺失'}」，盘点建单会被拒；请在已核验的库上跑`)
    return
  }
  const seeded = await seedStocktakeBook()
  const bookOf = async (skuId) => {
    const rows = await pgQuery(
      `SELECT COALESCE(SUM(quantity_on_hand), 0)::numeric AS q
         FROM inventory_stock_lots WHERE location_id = $1 AND sku_id = $2`,
      [TEST_STORE_ID, skuId],
    )
    return Number(rows[0].q)
  }
  const book1 = await bookOf(INV_SKU_ID)
  const book2 = await bookOf(INV_SKU_ID_2)
  if (seeded && (book1 !== 8 || book2 !== 4)) errors.push(`灌数后账面应为 8 / 4，实际 ${book1} / ${book2}`)
  if (!seeded) rec('  · 未设 SMOKE_INVENTORY_SEED_STOCK=<私有库名>：夹具账面恒 0，只验证「无批次落 0」，多批次汇总由私有库跑法覆盖')

  const rOpts = await invokeStaffApi('inventory.stocktakeSkuOptions', {
    _testOpenid: INV_OPERATOR_OPENID,
    locationId: TEST_STORE_ID,
    keyword: NS,
    pageSize: 20,
  })
  if (rOpts.code !== 0) {
    errors.push(`stocktakeSkuOptions code=${rOpts.code} msg=${rOpts.message}`)
    return
  }
  const optIds = (rOpts.data?.items || []).map((item) => item.skuId)
  if (!optIds.includes(INV_SKU_ID_2)) errors.push(`盘点候选应含非可报货 SKU ${INV_SKU_ID_2}，实际 ${optIds.join(',')}`)
  if (JSON.stringify(rOpts.data).match(/stockReference|price|amount|quantity/i)) {
    errors.push('盘点候选不应下发账面数 / 金额字段')
  }

  const create = (items) => invokeStaffApi('inventory.createDoc', {
    _testOpenid: INV_OPERATOR_OPENID,
    _loginLevel: 'store',
    _currentStoreId: TEST_STORE_ID,
    docType: '分院库存盘点',
    storeId: TEST_STORE_ID,
    items,
  })

  const rDup = await create([{ skuId: INV_SKU_ID, quantity: 1 }, { skuId: INV_SKU_ID, quantity: 2 }])
  if (rDup.code !== -400) errors.push(`同 SKU 两行应 -400，实际 code=${rDup.code} msg=${rDup.message}`)
  const rBlank = await create([{ skuId: INV_SKU_ID, quantity: '' }])
  if (rBlank.code !== -400) errors.push(`实盘留空应 -400，实际 code=${rBlank.code} msg=${rBlank.message}`)

  const rCreate = await create([
    { skuId: INV_SKU_ID, quantity: book1 },
    { skuId: INV_SKU_ID_2, quantity: 0 },
  ])
  if (rCreate.code !== 0) {
    errors.push(`盘点建单 code=${rCreate.code} msg=${rCreate.message}`)
    return
  }
  const docId = rCreate.data?.id
  const itemRows = await pgQuery(
    `SELECT sku_id, quantity::numeric AS quantity, stock_snapshot::numeric AS stock_snapshot
       FROM inventory_doc_items WHERE doc_id = $1 ORDER BY sku_id`,
    [docId],
  )
  // 先严格判 NULL：Number(null) 是 0，账面 0 的夹具上「stock_snapshot 恒 NULL」的回归会被当成 0 放过
  for (const row of itemRows) {
    if (row.stock_snapshot === null) errors.push(`${row.sku_id} 的 stock_snapshot 是 NULL（账面没记）`)
  }
  const snapshotBySku = Object.fromEntries(itemRows.map((row) => [row.sku_id, row.stock_snapshot === null ? null : Number(row.stock_snapshot)]))
  if (itemRows.length !== 2) errors.push(`盘点明细应 2 行，实际 ${itemRows.length}`)
  if (snapshotBySku[INV_SKU_ID] !== book1) errors.push(`${INV_SKU_ID} 账面=${snapshotBySku[INV_SKU_ID]}，期望在手汇总 ${book1}`)
  if (snapshotBySku[INV_SKU_ID_2] !== book2) errors.push(`${INV_SKU_ID_2} 账面=${snapshotBySku[INV_SKU_ID_2]}，期望在手汇总 ${book2}`)

  const movements = await pgQuery('SELECT COUNT(*)::int AS cnt FROM inventory_movements WHERE doc_id = $1', [docId])
  if (movements[0].cnt !== 0) errors.push(`盘点单不应产生流水，实际 ${movements[0].cnt} 条`)
  if (await bookOf(INV_SKU_ID) !== book1 || await bookOf(INV_SKU_ID_2) !== book2) {
    errors.push('盘点后门店在手量发生了变化')
  }

  const rList = await invokeStaffApi('inventory.docList', {
    _testOpenid: INV_OPERATOR_OPENID,
    docTypes: ['分院库存盘点'],
    page: 1,
    pageSize: 20,
  })
  if (!(rList.data?.items || []).some((item) => item.id === docId)) {
    errors.push(`盘点分类列表应含 ${docId}（code=${rList.code} msg=${rList.message}）`)
  }
  const rDetail = await invokeStaffApi('inventory.docDetail', { _testOpenid: INV_OPERATOR_OPENID, id: docId })
  const detailItems = rDetail.data?.items || []
  const zeroRow = detailItems.find((item) => item.skuId === INV_SKU_ID_2)
  if (rDetail.data?.docType !== '分院库存盘点' || !zeroRow || zeroRow.quantity !== 0 || zeroRow.stockSnapshot !== book2) {
    errors.push(`盘点详情应返回实盘 0 / 账面 ${book2}：${JSON.stringify(zeroRow)}`)
  }
  if (errors.length === before) {
    rec(`  ✓ 门店盘点 ${docId}（库存员身份，账面 ${book1}/${book2}${seeded ? '，多批次汇总' : ''}）：候选含非可报货 SKU、账面=在手汇总、无流水、列表/详情可见；重复 SKU / 留空被拒`)
  }
}

/**
 * #358 仅私有库：admin 早先放行过部分收货的分院配货（A 发 10 已收 3、B 发 4 已收满），
 * 小程序 confirmReceive 只收剩余 7 —— 血缘 7、来源 fulfilled 回写 10、单据已完成、流水 +7。
 * 会写 append-only 的 inventory_movements，共享库上删不掉，所以只在点名私有库时跑。
 * 同时是 ensureInventoryLotFromSku 列序（#358 修的 42804）在真 PG 上的唯一覆盖。
 */
let ranPrivateLedgerFlow = false

/**
 * 仅点名私有库：在 session_replication_role=replica 下删掉本命名空间的库存流水与单据血缘
 * （流水 append-only 触发器、血缘守卫在共享库上删不掉）。之后 cleanupTestData 照常删单据 / 批次。
 * 共享库上直接返回，绝不关触发器。
 */
async function purgePrivateInventoryLedger() {
  if (!(await isPrivateSeedRun())) return
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL session_replication_role = 'replica'")
    const nsDocs = `SELECT id FROM inventory_docs
                     WHERE id LIKE $1 OR source_org_node_id LIKE $1 OR target_org_node_id LIKE $1 OR created_by LIKE $1`
    await client.query(
      `DELETE FROM inventory_movements
        WHERE location_id LIKE $1 OR sku_id LIKE $1 OR doc_id IN (${nsDocs})`,
      [`${NS}%`],
    )
    await client.query(
      `DELETE FROM inventory_doc_links WHERE from_doc_id IN (${nsDocs}) OR to_doc_id IN (${nsDocs})`,
      [`${NS}%`],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function receiveRemainderFlow(errors) {
  if (!(await isPrivateSeedRun())) {
    rec('  · 未设 SMOKE_INVENTORY_SEED_STOCK=<私有库名>：跳过确认收货剩余量（会写删不掉的流水）')
    return
  }
  ranPrivateLedgerFlow = true
  const before = errors.length
  const fphId = `${NS}_INV_FPH_358`
  const oldInboundId = `${NS}_INV_YRK_358`
  const [srcLot] = await pgQuery(
    `INSERT INTO inventory_stock_lots (location_id, sku_id, lot_key, sku_name, spec_name, batch_no,
       expiry_date_key, is_gift, quantity_on_hand, market_actual_unit_price, store_standard_unit_price, store_actual_unit_price)
     VALUES ($1, $2, $2 || '|FPH358', $3, '默认规格', 'FPH358', '', false, 0, 40, 100, 100)
     ON CONFLICT (location_id, lot_key) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [TEST_MARKET_ORG_ID, INV_SKU_ID, `${NS}_采购商品`],
  )
  const insertDoc = (id, docType, status) => pgQuery(
    `INSERT INTO inventory_docs (id, doc_type, status, source_org_node_id, target_org_node_id, market_id, doc_date, total_quantity, created_by)
     VALUES ($1, $2, $3, $4, $5, $4, CURRENT_DATE, 0, $6)`,
    [id, docType, status, TEST_MARKET_ORG_ID, TEST_STORE_ORG_ID, TEST_MANAGER_EMP_ID],
  )
  await insertDoc(fphId, '分院配货', '待收货')
  await insertDoc(oldInboundId, '院入库', '已完成')
  const itemIds = []
  for (const [quantity, fulfilled] of [[10, 3], [4, 4]]) {
    const [row] = await pgQuery(
      `INSERT INTO inventory_doc_items (doc_id, lot_id, sku_id, sku_name, spec_name, batch_no, is_gift, quantity,
         stock_snapshot, fulfilled_quantity, standard_unit_price, unit_discount, actual_unit_price,
         store_standard_unit_price, store_unit_discount, store_actual_unit_price, market_actual_unit_price)
       VALUES ($1, $2, $3, $4, '默认规格', 'FPH358', false, $5, 0, $6, 100, 0, 100, 100, 0, 100, 40) RETURNING id`,
      [fphId, srcLot.id, INV_SKU_ID, `${NS}_采购商品`, quantity, fulfilled],
    )
    const [old] = await pgQuery(
      `INSERT INTO inventory_doc_items (doc_id, sku_id, sku_name, is_gift, quantity, stock_snapshot, actual_unit_price)
       VALUES ($1, $2, $3, false, $4, 0, 100) RETURNING id`,
      [oldInboundId, INV_SKU_ID, `${NS}_采购商品`, fulfilled],
    )
    await pgQuery(
      `INSERT INTO inventory_doc_links (from_doc_id, to_doc_id, relation_type, from_item_id, to_item_id, quantity)
       VALUES ($1, $2, '发货收货', $3, $4, $5)`,
      [fphId, oldInboundId, row.id, old.id, fulfilled],
    )
    itemIds.push(Number(row.id))
  }

  const r = await invokeStaffApi('inventory.confirmReceive', { _testOpenid: TEST_MANAGER_OPENID, id: fphId })
  if (r.code !== 0) {
    errors.push(`confirmReceive 剩余量 code=${r.code} msg=${r.message}`)
    return
  }
  const inboundId = r.data?.inboundDocId
  const [head] = await pgQuery('SELECT total_quantity, total_amount FROM inventory_docs WHERE id = $1', [inboundId])
  if (Number(head?.total_quantity) !== 7 || Number(head?.total_amount) !== 700) {
    errors.push(`入库单表头应为 7 件 / 700 元，实际 ${head?.total_quantity} / ${head?.total_amount}`)
  }
  const links = await pgQuery(
    `SELECT from_item_id, quantity FROM inventory_doc_links WHERE to_doc_id = $1 AND relation_type = '发货收货'`,
    [inboundId],
  )
  if (links.length !== 1 || Number(links[0].from_item_id) !== itemIds[0] || Number(links[0].quantity) !== 7) {
    errors.push(`发货收货血缘应只有 A 行 7，实际 ${JSON.stringify(links)}`)
  }
  const source = await pgQuery('SELECT fulfilled_quantity FROM inventory_doc_items WHERE doc_id = $1 ORDER BY id', [fphId])
  if (source.map((row) => Number(row.fulfilled_quantity)).join(',') !== '10,4') {
    errors.push(`来源 fulfilled 应回写为 10,4，实际 ${source.map((row) => row.fulfilled_quantity).join(',')}`)
  }
  const [fph] = await pgQuery('SELECT status FROM inventory_docs WHERE id = $1', [fphId])
  if (fph?.status !== '已完成') errors.push(`分院配货应已完成，实际 ${fph?.status}`)
  const moves = await pgQuery('SELECT quantity_delta FROM inventory_movements WHERE doc_id = $1', [inboundId])
  if (moves.length !== 1 || Number(moves[0].quantity_delta) !== 7) {
    errors.push(`入库流水应为 +7 一条，实际 ${JSON.stringify(moves)}`)
  }
  const again = await invokeStaffApi('inventory.confirmReceive', { _testOpenid: TEST_MANAGER_OPENID, id: fphId })
  if (again.code === 0) errors.push('已完成的分院配货再收货应被拒')
  if (errors.length === before) {
    rec(`  ✓ 确认收货只收剩余量（#358）：${fphId} 已收 3/10 → 入 7、血缘 7、fulfilled 10、单据已完成、流水 +7；再收被拒`)
  }
}

try {
  await main()
} catch (error) {
  console.error('EXCEPTION:', error.message)
} finally {
  // 私有库跑法写过 append-only 的库存流水：先在点名私有库上受控清掉，再走常规清理；
  // 清理失败不能报 PASS，否则下次在同一库上重跑会卡在开头的清理（#358 codex R1）
  try {
    await purgePrivateInventoryLedger()
    await cleanupTestData(NS)
  } catch (error) {
    if (ranPrivateLedgerFlow) {
      console.error(`私有库清理失败：${error.message}`)
      pass = false
      exitCode = 1
    }
  }
  if (insertedCutover) {
    // 清理失败不能报 PASS：残留的「已初始化」行会被后续跑法当成真实期初状态
    try {
      await pgQuery(`DELETE FROM inventory_cutover_states WHERE cutover_key = 'workfine_inventory' AND status = '已初始化'`)
      const left = await pgQuery(`SELECT 1 FROM inventory_cutover_states WHERE cutover_key = 'workfine_inventory'`)
      if (left.length > 0) throw new Error('删除后仍存在')
    } catch (error) {
      console.error(`清理临时期初状态失败：${error.message}`)
      pass = false
      exitCode = 1
    }
  }
  await closePool()
  console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
