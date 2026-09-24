#!/usr/bin/env bun
/**
 * order 提货流程冒烟（家居产品分次提货）
 *
 * 覆盖 routes/order.js 三个 action：
 *   - order.availablePickupItems  — 列出顾客可提货的家居产品销售明细（requireManager）
 *   - order.createPickup          — 记一次提货（requireStaffBound，原子累加 picked_up_quantity + 写 pickup_records）
 *   - order.pickupRecordsList     — 提货记录分页列表（requireManager，按 scopeStoreIds 过滤本门店）
 *
 * 业务语义（关键）：
 *   "提货" = 家居产品（product_type='家居产品'）按数量分次自提，不涉及储值卡/次数/服务单，
 *   同时从 inventory_stock_lots 扣减对应 SKU 库存，并写入 v3 库存单和库存流水。
 *   可提数量 = sale_items.quantity - sale_items.picked_up_quantity；实际提货还必须满足门店库存足量。
 *
 *   前置数据：必须有一张"已支付"销售单，含 1 行 product_type='家居产品' 的购买明细
 *   （item_direction='购买'、store_id=本店、quantity>picked_up_quantity）。
 *   本 smoke 会额外种一条 inventory_stock_lots 批次库存，验证提货时按购买 SKU 扣减库存。
 *
 * 验证点：
 *   1. availablePickupItems（提货前）→ 列出该家居明细，remaining=quantity=3
 *   2. createPickup（提 2 件）→ 成功；DB 断言 sale_items.picked_up_quantity=2、
 *      pickup_records 新增 1 行（pickup_quantity=2、store_id/client_user_id/confirmed_by 正确）；
 *      返回 pickedUp=2 / remaining=1
 *   3. availablePickupItems（提 2 后）→ remaining 降为 1（仍可见，因还没提满）
 *   4. createPickup（再提 1 件，带 idempotencyKey）→ picked_up_quantity=3（提满）
 *   5. createPickup（重放同 idempotencyKey）→ 幂等返回，picked_up_quantity 不再增长（仍=3）
 *   6. createPickup（超量再提 1 件）→ INVALID_PARAMS（超出可提货数量）
 *   7. pickupRecordsList → 含本顾客的提货记录（按 clientUserId 过滤，total>=2）
 *
 * ⚠️ pickup_records 不在标准 cleanupTestData 范围内（它 FK → sale_items，必须先删），
 *    本 smoke 在 finally 里先按 client_user_id 手动删 pickup_records，再走 cleanupTestData(NS)。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_MANAGER_EMP_ID,
  TEST_CLIENT_USER_ID,
  TEST_STORE_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

const SALE_ORDER_ID = `${NS}_PICKUP_SO_1`
const SALE_ITEM_ID = `${SALE_ORDER_ID}_ITEM_1` // createTestSaleOrder 内部命名约定
const IDEM_KEY = `${NS}_PICKUP_IDEM_1`

/**
 * pickup_records 与 v3 库存单都不在 cleanupTestData 内，手动先删。
 *
 * 顺序由 FK 决定：doc_links / doc_items → docs → pickup_records。
 * inventory_docs 是**开启库存联动后**提货才会产生的（出库单），它 FK 引用
 * client_wechat_users / staff_wechat_users / org_nodes —— 不先删掉，
 * cleanupTestData 删顾客和员工会被 FK 挡住并静默 skip，下一次跑就撞 sale_orders_pkey。
 * （inventory_movements 是 append-only，删不掉也不必删，靠 movement_key 唯一后缀避让。）
 */
async function cleanupPickupRecords() {
  const like = `${NS}%`
  // v3 库存单不能删：inventory_movements 是 append-only（trigger 挡改删）且 FK 引用
  // inventory_doc_items，于是 doc_items → docs 整条链都删不掉。它们又 FK 引用
  // 顾客 / 员工 / 订单，不处理就会把 cleanupTestData 顶住，下次跑直接撞 sale_orders_pkey。
  // 所以改为**解绑**而非删除：把指向测试数据的外键列置空，留下孤儿单据（只在一次性
  // 库存库里才会产生，dev 上仅当有人显式开 INVENTORY_LINKAGE_ENABLED 才有）。
  await pgQuery(
    `UPDATE inventory_docs
        SET related_sale_order_id = NULL,
            client_user_id = NULL,
            employee_id = NULL,
            confirmed_by = NULL,
            approved_by = NULL,
            rejected_by = NULL,
            cancelled_by = NULL,
            cancellation_requested_by = NULL
      WHERE related_sale_order_id LIKE $1 OR client_user_id LIKE $1 OR employee_id LIKE $1
         OR confirmed_by LIKE $1 OR approved_by LIKE $1 OR rejected_by LIKE $1
         OR cancelled_by LIKE $1 OR cancellation_requested_by LIKE $1`,
    // 注意 created_by 是 NOT NULL，不能一起置空——把它写进同一条 UPDATE 会让整条失败，
    // 于是所有解绑都白做。孤儿单据留着 created_by 指向测试员工是可接受的：
    // 员工行用 ON CONFLICT DO UPDATE 重建，不阻塞后续运行。
    [like],
  ).catch((e) => console.log('[cleanup] inventory_docs 解绑失败（可忽略）:', e.message))
  // doc_items 也有一条指向 sale_items 的外键，漏了它 sale_items 同样删不掉
  await pgQuery(
    `UPDATE inventory_doc_items SET sale_item_id = NULL WHERE sale_item_id LIKE $1`,
    [like],
  ).catch((e) => console.log('[cleanup] inventory_doc_items 解绑失败（可忽略）:', e.message))
  await pgQuery(
    `DELETE FROM pickup_records
       WHERE client_user_id LIKE $1
          OR store_id LIKE $1
          OR confirmed_by LIKE $1
          OR sale_item_id LIKE $1`,
    [like]
  )
}

async function main() {
  rec(`[smoke-order-pickup] start | ${new Date().toISOString()}`)
  // 库存联动断言（扣批次余额 + 生成 v3 出库单）**默认不跑**，只在显式开启时执行。
  //
  // 原因不是"懒得测"，而是开了就清不干净：提货会写 inventory_docs / doc_items，
  // 而 inventory_movements 是 append-only（trigger 挡改删）且 FK 引用 doc_items，
  // 于是 docs 删不掉 → 顾客与员工删不掉 → 下一次跑直接撞 sale_orders_pkey。
  // 既有约定本就是「库存链路只跑一次性 docker 库」（见 e2e-actions/smoke-inventory-chain.mjs）。
  //
  // 要在一次性库上连库存一起验：INVENTORY_LINKAGE_ENABLED=true bun 本文件。
  const inventoryLinkage = process.env.INVENTORY_LINKAGE_ENABLED === 'true'

  await cleanupPickupRecords()
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()        // manager，openid=TEST_MANAGER_OPENID
  await createTestClient()
  await invalidateStaffAuthCache(TEST_MANAGER_OPENID)
  const product = await createTestProduct({
    suffix: 'PICKUP_HOME',
    productKind: '家居产品',
    productType: '家居产品',
    specName: `${NS}_家居产品`,
    price: 200,
    sessionCount: null,
    isShengmei: null,
  })
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
     VALUES ($1, $1, $2, $2, 200, true, 100, 0.8, '公式')
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
    [product.skuId, product.specName],
  )
  if (inventoryLinkage) {
  // 批次必须「零余额建仓 + 走 inventory_movements 入账」：0039 的 trigger
  // trg_inventory_stock_lots_require_movement 禁止直接插带余额的批次，
  // trg_inventory_movements_apply_lot 会按流水把余额加上去。
  // 直接写 quantity_on_hand=3 会抛「新库存批次必须从零余额开始，并通过 inventory_movements 入账」。
  const lotRows = await pgQuery(
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, spec_name, batch_no, expiry_date_key,
       is_gift, quantity_on_hand, store_standard_unit_price, store_actual_unit_price
     )
     VALUES ($1, $2, $2 || '|PICKUP||||200', $3, $3, 'PICKUP', '', false, 0, 200, 200)
     ON CONFLICT (location_id, lot_key)
     DO UPDATE SET sku_name = EXCLUDED.sku_name,
                   spec_name = EXCLUDED.spec_name,
                   store_standard_unit_price = EXCLUDED.store_standard_unit_price,
                   store_actual_unit_price = EXCLUDED.store_actual_unit_price,
                   updated_at = NOW()
     RETURNING id, quantity_on_hand`,
    [TEST_STORE_ID, product.skuId, product.specName],
  )
  const lotId = lotRows[0].id
  const onHand = Number(lotRows[0].quantity_on_hand || 0)
  if (onHand < 3) {
    await pgQuery(
      `INSERT INTO inventory_movements (
         movement_key, lot_id, location_id, sku_id, direction,
         quantity_delta, quantity_before, quantity_after, remark
       )
       VALUES ($1, $2, $3, $4, '入库', $5, $6, 3, 'e2e 期初入账')`,
      // movement_key 必须每次唯一：inventory_movements 是 append-only（trigger 挡改删），
      // cleanupTestData 也不清它，所以历史键会永久留在库里，固定键第二次跑就撞唯一约束。
      [`${NS}_PICKUP_MV_${lotId}_${Date.now()}`, lotId, TEST_STORE_ID, product.skuId, 3 - onHand, onHand],
    )
  }

  // F9：INVENTORY_LINKAGE_ENABLED=true 下 createPickup 依赖期初切点已初始化 +
  // 销售 SKU→库存 SKU 组成映射（resolvePickupComposition 无快照时回退映射表）。
  await pgQuery(
    `INSERT INTO inventory_cutover_states (cutover_key, status)
     VALUES ('workfine_inventory', '已初始化')
     ON CONFLICT (cutover_key) DO UPDATE SET status = '已初始化'`,
  )
  await pgQuery(
    `INSERT INTO inventory_sku_product_sku_mappings (product_sku_id, inventory_sku_id, quantity_per_sale_unit, is_active)
     VALUES ($1, $1, 1, true)
     ON CONFLICT (product_sku_id, inventory_sku_id)
     DO UPDATE SET quantity_per_sale_unit = 1, is_active = true, updated_at = NOW()`,
    [product.skuId],
  )
  }

  // 前置：一张"已支付"销售单 + 1 行家居产品（quantity=3，sessionCount=null）
  await createTestSaleOrder({
    saleOrderId: SALE_ORDER_ID,
    clientUserId: TEST_CLIENT_USER_ID,
    storeId: TEST_STORE_ID,
    status: '已支付',
    paymentMethod: '线下',
    skuId: product.skuId,
    productType: '家居产品',
    productName: `${NS}_家居产品`,
    quantity: 3,
    sessionCount: null,
    salesCategory: '他销他耗',
    totalAmount: 600, // 单价 200 × 3
  })
  rec(`  ✓ fixture: 已支付销售单 ${SALE_ORDER_ID} / 家居明细 ${SALE_ITEM_ID}（quantity=3）`)

  const errors = []

  // ─── 1. availablePickupItems（提货前）───
  const avail1 = await invokeStaffApi('order.availablePickupItems', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (avail1.code !== 0) {
    rec(`  ✗ FAIL: availablePickupItems(初始) code=${avail1.code} msg=${avail1.message}`)
    return
  }
  const list1 = avail1.data || []
  const row1 = list1.find(i => i.saleItemId === SALE_ITEM_ID)
  if (!row1) errors.push(`availablePickupItems(初始) 未列出 ${SALE_ITEM_ID}`)
  else {
    if (Number(row1.quantity) !== 3) errors.push(`avail(初始) quantity 应=3，实际=${row1.quantity}`)
    if (Number(row1.pickedUpQuantity) !== 0) errors.push(`avail(初始) pickedUpQuantity 应=0，实际=${row1.pickedUpQuantity}`)
    if (Number(row1.remaining) !== 3) errors.push(`avail(初始) remaining 应=3，实际=${row1.remaining}`)
  }
  rec(`  ✓ availablePickupItems(初始): remaining=${row1 ? row1.remaining : 'N/A'}`)

  // ─── 2. createPickup（提 2 件）───
  const pick1 = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: SALE_ITEM_ID,
    pickupQuantity: 2,
    remark: 'e2e-pickup-step2',
  })
  if (pick1.code !== 0) {
    rec(`  ✗ FAIL: createPickup(提2) code=${pick1.code} msg=${pick1.message}`)
    return
  }
  if (Number(pick1.data?.pickedUp) !== 2) errors.push(`createPickup(提2) pickedUp 应=2，实际=${pick1.data?.pickedUp}`)
  if (Number(pick1.data?.remaining) !== 1) errors.push(`createPickup(提2) remaining 应=1，实际=${pick1.data?.remaining}`)

  // DB 断言：sale_items.picked_up_quantity = 2
  const si1 = await pgQuery(
    `SELECT quantity, COALESCE(picked_up_quantity,0) AS picked_up_quantity FROM sale_items WHERE sale_item_id = $1`,
    [SALE_ITEM_ID]
  )
  if (si1.length !== 1) errors.push(`sale_items 行数=${si1.length}`)
  else if (Number(si1[0].picked_up_quantity) !== 2) {
    errors.push(`提2后 picked_up_quantity 应=2，实际=${si1[0].picked_up_quantity}`)
  }

  // DB 断言：pickup_records 新增 1 行，字段正确
  const pr1 = await pgQuery(
    `SELECT pickup_quantity, store_id, client_user_id, confirmed_by, remark
       FROM pickup_records WHERE sale_item_id = $1 ORDER BY id`,
    [SALE_ITEM_ID]
  )
  if (pr1.length !== 1) errors.push(`提2后 pickup_records 应=1 行，实际=${pr1.length}`)
  else {
    const r = pr1[0]
    if (Number(r.pickup_quantity) !== 2) errors.push(`pickup_records.pickup_quantity 应=2，实际=${r.pickup_quantity}`)
    if (r.store_id !== TEST_STORE_ID) errors.push(`pickup_records.store_id 应=${TEST_STORE_ID}，实际=${r.store_id}`)
    if (r.client_user_id !== TEST_CLIENT_USER_ID) errors.push(`pickup_records.client_user_id 应=${TEST_CLIENT_USER_ID}，实际=${r.client_user_id}`)
    if (r.confirmed_by !== TEST_MANAGER_EMP_ID) errors.push(`pickup_records.confirmed_by 应=${TEST_MANAGER_EMP_ID}，实际=${r.confirmed_by}`)
  }
  rec(`  ✓ createPickup(提2): picked_up_quantity=${si1[0]?.picked_up_quantity} / 记录=${pr1.length} 行`)

  const stock1 = await pgQuery(
    `SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity_on_hand
       FROM inventory_stock_lots WHERE location_id = $1 AND sku_id = $2`,
    [TEST_STORE_ID, product.skuId],
  )
  if (inventoryLinkage && Number(stock1[0]?.quantity_on_hand) !== 1) {
    errors.push(`提2后 v3 库存应=1，实际=${stock1[0]?.quantity_on_hand}`)
  }

  // ─── 3. availablePickupItems（提 2 后仍可见，remaining=1）───
  const avail2 = await invokeStaffApi('order.availablePickupItems', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (avail2.code !== 0) {
    rec(`  ✗ FAIL: availablePickupItems(提2后) code=${avail2.code} msg=${avail2.message}`)
    return
  }
  const row2 = (avail2.data || []).find(i => i.saleItemId === SALE_ITEM_ID)
  if (!row2) errors.push(`availablePickupItems(提2后) 应仍列出 ${SALE_ITEM_ID}（未提满）`)
  else if (Number(row2.remaining) !== 1) errors.push(`avail(提2后) remaining 应=1，实际=${row2.remaining}`)

  // ─── 4. createPickup（再提 1 件，带 idempotencyKey → 提满）───
  const pick2 = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: SALE_ITEM_ID,
    pickupQuantity: 1,
    idempotencyKey: IDEM_KEY,
    remark: 'e2e-pickup-step4',
  })
  if (pick2.code !== 0) {
    rec(`  ✗ FAIL: createPickup(提满) code=${pick2.code} msg=${pick2.message}`)
    return
  }
  if (Number(pick2.data?.pickedUp) !== 3) errors.push(`createPickup(提满) pickedUp 应=3，实际=${pick2.data?.pickedUp}`)
  if (Number(pick2.data?.remaining) !== 0) errors.push(`createPickup(提满) remaining 应=0，实际=${pick2.data?.remaining}`)

  // ─── 5. createPickup（重放同 idempotencyKey → 幂等，不再累加）───
  const pick2dup = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: SALE_ITEM_ID,
    pickupQuantity: 1,
    idempotencyKey: IDEM_KEY,
    remark: 'e2e-pickup-replay',
  })
  if (pick2dup.code !== 0) {
    rec(`  ✗ FAIL: createPickup(幂等重放) 应成功返回当前状态，code=${pick2dup.code} msg=${pick2dup.message}`)
    return
  }
  if (Number(pick2dup.data?.pickedUp) !== 3) errors.push(`createPickup(幂等重放) pickedUp 应仍=3，实际=${pick2dup.data?.pickedUp}`)

  // DB 断言：提满后 picked_up_quantity=3，且 IDEM_KEY 仅一条记录
  const si2 = await pgQuery(
    `SELECT COALESCE(picked_up_quantity,0) AS picked_up_quantity FROM sale_items WHERE sale_item_id = $1`,
    [SALE_ITEM_ID]
  )
  if (Number(si2[0]?.picked_up_quantity) !== 3) {
    errors.push(`幂等重放后 picked_up_quantity 应=3（无重复累加），实际=${si2[0]?.picked_up_quantity}`)
  }
  const prIdem = await pgQuery(
    `SELECT COUNT(*)::int AS cnt FROM pickup_records WHERE sale_item_id = $1 AND idempotency_key = $2`,
    [SALE_ITEM_ID, IDEM_KEY]
  )
  if (Number(prIdem[0]?.cnt) !== 1) errors.push(`idempotencyKey 记录应=1 条，实际=${prIdem[0]?.cnt}`)
  const stock2 = await pgQuery(
    `SELECT COALESCE(SUM(quantity_on_hand), 0) AS quantity_on_hand
       FROM inventory_stock_lots WHERE location_id = $1 AND sku_id = $2`,
    [TEST_STORE_ID, product.skuId],
  )
  if (inventoryLinkage && Number(stock2[0]?.quantity_on_hand) !== 0) {
    errors.push(`提满后 v3 库存应=0，实际=${stock2[0]?.quantity_on_hand}`)
  }
  const inventoryRows = await pgQuery(
    `SELECT COUNT(*)::int AS doc_count
       FROM inventory_docs
      WHERE related_sale_order_id = $1
        AND doc_type = '院顾客产品出库'`,
    [SALE_ORDER_ID],
  )
  if (inventoryLinkage && Number(inventoryRows[0]?.doc_count) !== 2) {
    errors.push(`提货应生成 2 张 v3 出库单，实际=${inventoryRows[0]?.doc_count}`)
  }
  rec(`  ✓ createPickup(提满+幂等重放): picked_up_quantity=${si2[0]?.picked_up_quantity} / idem 记录=${prIdem[0]?.cnt}`)

  // ─── 6. createPickup（超量再提 → INVALID_PARAMS）───
  const pickOver = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: SALE_ITEM_ID,
    pickupQuantity: 1,
    remark: 'e2e-pickup-over',
  })
  if (pickOver.code === 0) {
    errors.push(`createPickup(超量) 应失败（已提满），实际 code=0`)
  } else if (pickOver.errorType !== 'INVALID_STATE') {
    // 提满后再提抛 `INVALID_STATE: 已支付可提数量不足`（order.js:6333/6530）——
    // 两者都是 -400，但语义上这是"当前状态不允许"而非"入参不合法"，前缀已相应调整。
    errors.push(`createPickup(超量) errorType 应=INVALID_STATE，实际=${pickOver.errorType} (code=${pickOver.code})`)
  }
  rec(`  ✓ createPickup(超量): 正确拒绝 errorType=${pickOver.errorType}`)

  // ─── 7. pickupRecordsList（按 clientUserId 过滤）───
  const recList = await invokeStaffApi('order.pickupRecordsList', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    page: 1,
    pageSize: 20,
  })
  if (recList.code !== 0) {
    rec(`  ✗ FAIL: pickupRecordsList code=${recList.code} msg=${recList.message}`)
    return
  }
  const items = recList.data?.items || []
  const mine = items.filter(i => i.saleItemId === SALE_ITEM_ID)
  // 提货成功 2 次（提2 + 提满），幂等重放不写新行
  if (mine.length < 2) errors.push(`pickupRecordsList 应含本明细 >=2 条记录，实际=${mine.length}`)
  if (Number(recList.data?.total) < 2) errors.push(`pickupRecordsList total 应>=2，实际=${recList.data?.total}`)
  const sample = mine[0]
  if (sample) {
    if (sample.storeId !== TEST_STORE_ID) errors.push(`pickupRecordsList.storeId 应=${TEST_STORE_ID}，实际=${sample.storeId}`)
    if (sample.confirmedBy !== TEST_MANAGER_EMP_ID) errors.push(`pickupRecordsList.confirmedBy 应=${TEST_MANAGER_EMP_ID}，实际=${sample.confirmedBy}`)
  }
  rec(`  ✓ pickupRecordsList: 本明细记录=${mine.length} / total=${recList.data?.total}`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 提货链路：available 列项 → createPickup 累加+记录 → 幂等 → 超量拒绝 → 记录列表`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-pickup] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupPickupRecords() } catch (e) { console.error('[cleanup pickup error]', e.message) }
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-pickup] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
