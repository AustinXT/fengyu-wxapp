#!/usr/bin/env bun
/**
 * order 提货流程冒烟 — 转换单「转入」的家居产品（issue #145 / #153）
 *
 * 背景：转换单换入的家居行写 item_direction='转入'，而家居展示与提货链路一律只放
 *   item_direction='购买'，导致顾客换到手的货四端看不见、也提不出来
 *   （dev 实证 14 行 / 17 件 / ¥11,730 / 3 位顾客）。放行判据与疗程卡侧同源：
 *   `购买` OR (转换单 AND `转入`)。
 *
 * 本 smoke 与 smoke-order-pickup.mjs 互补：那条覆盖「购买」行的主链路，
 * 这条专门锁「转入」行的可见性、可提性与守卫边界。
 *
 * 可提数量口径：转入行 received 由 paid-sessions STEP 1.6 重建为「转出旧卡价值 + 本单净到账」，
 *   FLOOR(received × qty / sale_amount) 因而与购买行同源正确——本 smoke 的 fixture
 *   按建单形态写 received = sale_amount（已支付转换单的稳定态），全额可提。
 *
 * ⚠️ 不种 inventory_stock_lots：INVENTORY_LINKAGE_ENABLED=false 时提货不扣库存。
 *
 * 验证点：
 *   1. availablePickupItems → 列出转换单转入行（remaining=2）；
 *      同时**不含**两个负例：非转换单的转入行、待支付转换单的转入行
 *   2. createPickup（提 1 件）→ picked_up_quantity=1 + pickup_records 新增 1 行，remaining=1
 *   3. createPickup（再提 1 件，带 idempotencyKey）→ 提满，picked_up_quantity=2
 *   4. createPickup（重放同 idempotencyKey）→ 幂等，不再累加
 *   5. createPickup（超量再提）→ 拒绝
 *   6. createPickup（非转换单的转入行）→ 拒绝（守卫不能放宽成方向白名单）
 *   7. availablePickupItems（提满后）→ 转入行消失
 *   8. 转入行可被**再次折抵转出**（#125 转出侧），折抵后从提货候选消失；
 *      本次换入的新家居行立即可提 —— 闭环验证「换入 → 可提 → 再换出 → 消失」
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

const CONV_ORDER_ID = `${NS}_PICKUPCONV_SO_1`      // 已支付转换单（正例）
const CONV_ITEM_ID = `${CONV_ORDER_ID}_ITEM_1`
const SALE_ORDER_ID = `${NS}_PICKUPCONV_SO_2`      // 销售单上的转入行（负例：非转换单）
const SALE_ITEM_ID = `${SALE_ORDER_ID}_ITEM_1`
const PENDING_ORDER_ID = `${NS}_PICKUPCONV_SO_3`   // 待支付转换单（负例：差额未结清）
const PENDING_ITEM_ID = `${PENDING_ORDER_ID}_ITEM_1`
const CONV2_ORDER_ID = `${NS}_PICKUPCONV_SO_4`     // 已支付转换单（验证转入行可再次折抵转出）
const CONV2_ITEM_ID = `${CONV2_ORDER_ID}_ITEM_1`
const IDEM_KEY = `${NS}_PICKUPCONV_IDEM_1`

/** pickup_records 不在 cleanupTestData 内，手动先删（FK → sale_items 必须先于其删除） */
async function cleanupPickupRecords() {
  await pgQuery(
    `DELETE FROM pickup_records
       WHERE client_user_id LIKE $1
          OR store_id LIKE $1
          OR confirmed_by LIKE $1
          OR sale_item_id LIKE $1`,
    [`${NS}%`]
  )
}

/** 把 fixture 造出的「购买」行改写成转换单转入行的形态 */
async function makeTransferIn(saleItemId) {
  await pgQuery(
    `UPDATE sale_items SET item_direction = '转入'::item_direction, updated_at = NOW()
      WHERE sale_item_id = $1`,
    [saleItemId],
  )
}

async function pickedUpOf(saleItemId) {
  const rows = await pgQuery(
    `SELECT COALESCE(picked_up_quantity, 0)::int AS picked_up,
            COALESCE((SELECT SUM(pr.pickup_quantity)::int FROM pickup_records pr
                       WHERE pr.sale_item_id = si.sale_item_id), 0)::int AS records
       FROM sale_items si WHERE si.sale_item_id = $1`,
    [saleItemId],
  )
  return rows[0] || { picked_up: -1, records: -1 }
}

async function main() {
  rec(`[smoke-order-pickup-conversion] start | ${new Date().toISOString()}`)

  await cleanupPickupRecords()
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()        // manager，openid=TEST_MANAGER_OPENID
  await createTestClient()
  await invalidateStaffAuthCache(TEST_MANAGER_OPENID)
  const product = await createTestProduct({
    suffix: 'PICKUPCONV_HOME',
    productKind: '家居产品',
    productType: '家居产品',
    specName: `${NS}_家居产品`,
    price: 200,
    sessionCount: null,
    isShengmei: null,
  })

  const homeItem = {
    clientUserId: TEST_CLIENT_USER_ID,
    storeId: TEST_STORE_ID,
    paymentMethod: '线下',
    skuId: product.skuId,
    productType: '家居产品',
    productName: `${NS}_家居产品`,
    quantity: 2,
    sessionCount: null,
    salesCategory: '他销他耗',
    totalAmount: 400, // 单价 200 × 2
  }

  // 正例：已支付转换单 + 转入家居行
  await createTestSaleOrder({ ...homeItem, saleOrderId: CONV_ORDER_ID, status: '已支付', saleOrderType: '转换单' })
  await makeTransferIn(CONV_ITEM_ID)
  // 负例 1：销售单上的转入行——方向对了但订单类型不对，守卫必须仍然拦住
  await createTestSaleOrder({ ...homeItem, saleOrderId: SALE_ORDER_ID, status: '已支付', saleOrderType: '销售单' })
  await makeTransferIn(SALE_ITEM_ID)
  // 负例 2：待支付转换单——差额未结清，订单状态白名单天然挡住
  await createTestSaleOrder({ ...homeItem, saleOrderId: PENDING_ORDER_ID, status: '待支付', saleOrderType: '转换单' })
  await makeTransferIn(PENDING_ITEM_ID)
  rec(`  ✓ fixture: 已支付转换单转入行 ${CONV_ITEM_ID}（quantity=2）+ 2 个负例`)

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
  const convRow = list1.find(i => i.saleItemId === CONV_ITEM_ID)
  if (!convRow) errors.push(`availablePickupItems(初始) 未列出转换单转入行 ${CONV_ITEM_ID}`)
  else {
    if (Number(convRow.quantity) !== 2) errors.push(`avail(初始) quantity 应=2，实际=${convRow.quantity}`)
    if (Number(convRow.paidQuantity) !== 2) errors.push(`avail(初始) paidQuantity 应=2（received=sale_amount 全额可提），实际=${convRow.paidQuantity}`)
    if (Number(convRow.remaining) !== 2) errors.push(`avail(初始) remaining 应=2，实际=${convRow.remaining}`)
  }
  if (list1.some(i => i.saleItemId === SALE_ITEM_ID)) errors.push('销售单的转入行不应出现在可提列表（放行判据被放宽成方向白名单）')
  if (list1.some(i => i.saleItemId === PENDING_ITEM_ID)) errors.push('待支付转换单的转入行不应出现在可提列表')
  rec(`  ✓ availablePickupItems(初始): 转入行 remaining=${convRow ? convRow.remaining : 'N/A'}，两个负例均未出现`)

  // ─── 2. createPickup（提 1 件）───
  const pick1 = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: CONV_ITEM_ID,
    pickupQuantity: 1,
    remark: 'e2e-pickup-conv-step2',
  })
  if (pick1.code !== 0) {
    rec(`  ✗ FAIL: createPickup(1 件) code=${pick1.code} msg=${pick1.message}`)
    return
  }
  if (Number(pick1.data?.pickedUp) !== 1) errors.push(`createPickup(1) pickedUp 应=1，实际=${pick1.data?.pickedUp}`)
  if (Number(pick1.data?.remaining) !== 1) errors.push(`createPickup(1) remaining 应=1，实际=${pick1.data?.remaining}`)
  const after1 = await pickedUpOf(CONV_ITEM_ID)
  if (after1.picked_up !== 1) errors.push(`DB picked_up_quantity 应=1，实际=${after1.picked_up}`)
  if (after1.records !== 1) errors.push(`DB pickup_records 合计应=1，实际=${after1.records}`)
  rec(`  ✓ createPickup(1 件): picked_up=${after1.picked_up} / pickup_records=${after1.records}`)

  // ─── 3. availablePickupItems（提 1 后仍可见）───
  const avail2 = await invokeStaffApi('order.availablePickupItems', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  const row2 = (avail2.data || []).find(i => i.saleItemId === CONV_ITEM_ID)
  if (!row2) errors.push('availablePickupItems(提 1 后) 转入行不应消失（还剩 1 件）')
  else if (Number(row2.remaining) !== 1) errors.push(`avail(提 1 后) remaining 应=1，实际=${row2.remaining}`)
  rec(`  ✓ availablePickupItems(提 1 后): remaining=${row2 ? row2.remaining : 'N/A'}`)

  // ─── 4. createPickup（再提 1 件，带幂等键）───
  const pick2 = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: CONV_ITEM_ID,
    pickupQuantity: 1,
    idempotencyKey: IDEM_KEY,
  })
  if (pick2.code !== 0) {
    rec(`  ✗ FAIL: createPickup(提满) code=${pick2.code} msg=${pick2.message}`)
    return
  }
  const after2 = await pickedUpOf(CONV_ITEM_ID)
  if (after2.picked_up !== 2) errors.push(`DB picked_up_quantity 应=2，实际=${after2.picked_up}`)
  if (after2.records !== 2) errors.push(`DB pickup_records 合计应=2，实际=${after2.records}`)
  rec(`  ✓ createPickup(提满): picked_up=${after2.picked_up} / pickup_records=${after2.records}`)

  // ─── 5. createPickup（重放同幂等键）───
  const replay = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: CONV_ITEM_ID,
    pickupQuantity: 1,
    idempotencyKey: IDEM_KEY,
  })
  if (replay.code !== 0) errors.push(`幂等重放应成功返回，实际 code=${replay.code} msg=${replay.message}`)
  const after3 = await pickedUpOf(CONV_ITEM_ID)
  if (after3.picked_up !== 2) errors.push(`幂等重放后 picked_up_quantity 仍应=2，实际=${after3.picked_up}`)
  if (after3.records !== 2) errors.push(`幂等重放后 pickup_records 仍应=2，实际=${after3.records}`)
  rec(`  ✓ createPickup(幂等重放): picked_up 未增长（=${after3.picked_up}）`)

  // ─── 6. createPickup（超量）───
  const over = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: CONV_ITEM_ID,
    pickupQuantity: 1,
  })
  if (over.code === 0) errors.push('已提满后继续提货应被拒绝')
  const after4 = await pickedUpOf(CONV_ITEM_ID)
  if (after4.picked_up !== 2) errors.push(`超量被拒后 picked_up_quantity 仍应=2，实际=${after4.picked_up}`)
  rec(`  ✓ createPickup(超量): 被拒 code=${over.code}`)

  // ─── 7. createPickup（销售单的转入行）───
  const badDirection = await invokeStaffApi('order.createPickup', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleItemId: SALE_ITEM_ID,
    pickupQuantity: 1,
  })
  if (badDirection.code === 0) errors.push('销售单的转入行不应可提（守卫被放宽成方向白名单）')
  const badAfter = await pickedUpOf(SALE_ITEM_ID)
  if (badAfter.picked_up !== 0) errors.push(`销售单转入行不应被提货，picked_up_quantity=${badAfter.picked_up}`)
  rec(`  ✓ createPickup(销售单转入行): 被拒 code=${badDirection.code} msg=${badDirection.message}`)

  // ─── 8. availablePickupItems（提满后消失）───
  const avail3 = await invokeStaffApi('order.availablePickupItems', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if ((avail3.data || []).some(i => i.saleItemId === CONV_ITEM_ID)) {
    errors.push('availablePickupItems(提满后) 转入行应从可提列表消失')
  }
  rec(`  ✓ availablePickupItems(提满后): 转入行已消失`)

  // ─── 9. 转入行可被再次折抵转出，折抵后从提货候选消失（#153 验收 5，依赖 #125 转出侧）───
  await createTestSaleOrder({ ...homeItem, saleOrderId: CONV2_ORDER_ID, status: '已支付', saleOrderType: '转换单' })
  await makeTransferIn(CONV2_ITEM_ID)

  const held = await invokeStaffApi('order.customerHeldCards', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (held.code !== 0) errors.push(`customerHeldCards code=${held.code} msg=${held.message}`)
  const heldCards = held.data?.cards || []
  const heldRow = heldCards.find(c => c.saleItemId === CONV2_ITEM_ID)
  if (!heldRow) errors.push('转入的家居行应能作为折抵源出现在 customerHeldCards')
  else if (Number(heldRow.remainingQuantity) !== 2) {
    errors.push(`折抵候选 remainingQuantity 应=2，实际=${heldRow.remainingQuantity}`)
  }
  if (heldCards.some(c => c.saleItemId === SALE_ITEM_ID)) {
    errors.push('销售单的转入行不应出现在折抵候选（方向判据被放宽）')
  }

  const conv = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [CONV2_ITEM_ID],
    convertInItems: [{ skuId: product.skuId, quantity: 1 }],
    paymentMethod: '线下',
    remark: 'e2e-pickup-conv-step9',
  })
  if (conv.code !== 0) {
    errors.push(`转入行再次折抵失败 code=${conv.code} msg=${conv.message}`)
  } else {
    // #125 把转出数量并入 picked_up_quantity（「已结算」），可提数量因而归零
    const srcAfter = await pickedUpOf(CONV2_ITEM_ID)
    if (srcAfter.picked_up !== 2) errors.push(`折抵后源行 picked_up_quantity 应=2（已转走），实际=${srcAfter.picked_up}`)

    const avail4 = await invokeStaffApi('order.availablePickupItems', {
      _testOpenid: TEST_MANAGER_OPENID,
      clientUserId: TEST_CLIENT_USER_ID,
    })
    const list4 = avail4.data || []
    if (list4.some(i => i.saleItemId === CONV2_ITEM_ID)) {
      errors.push('被再次折抵转出的转入行应从提货候选消失')
    }
    // 闭环：本次换入的新家居行立即可提（转入 200 − 转出 400 = −200 → 储值卡补差 → 已支付）
    const newIn = await pgQuery(
      `SELECT sale_item_id FROM sale_items
        WHERE sale_order_id = $1 AND item_direction = '转入' AND product_type = '家居产品'`,
      [conv.data.saleOrderId],
    )
    const newInId = newIn[0]?.sale_item_id
    if (!newInId) errors.push('新转换单应产生家居转入行')
    else if (!list4.some(i => i.saleItemId === newInId)) {
      errors.push(`本次换入的家居行 ${newInId} 应立即出现在提货候选`)
    }
    rec(`  ✓ 转入行再次折抵：源行已结算=${srcAfter.picked_up}，新换入行 ${newInId || 'N/A'} 可提`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 转换单转入家居：可见 → 分次提货 → 幂等 → 超量拒绝 → 非转换单转入行仍被拦 → 再次折抵后消失`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-pickup-conversion] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupPickupRecords() } catch (e) { console.error('[cleanup pickup error]', e.message) }
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-pickup-conversion] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
