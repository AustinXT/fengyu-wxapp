#!/usr/bin/env bun
/**
 * #125 家居产品转换折抵 — 结果级冒烟（真 PG）
 *
 * 单测与 snapshot 只能验证 SQL 文本与 mock 行为；本 smoke 验证真库上的数量账：
 *   1. 未提货家居行出现在 order.customerHeldCards 候选里，折抵额 = 未提货数量 × unit_real_price
 *   2. createConversion 后源行 picked_up_quantity 并入转出数量、转出行 quantity/received 正确
 *   3. 折抵后该行在顾客档案家居 Tab 里「待提」归零，且「已转换」而非「已退款」
 *   4. 折抵后提货候选（order.availablePickupItems）不再放行该行
 *   5. **关闭转换单后数量完整复原**（回滚段）——这是 #125 最关键的资产安全闭环
 *   6. 已全部结算的家居行不进候选
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
const errors = []

function rec(line) { console.log(line) }
function check(cond, msg) { if (!cond) errors.push(msg) }

async function main() {
  rec(`[smoke-order-home-conversion] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // 家居源行：10 盒 × ¥100 = ¥1000；已提 3 盒 → 未提货 7 盒 → 折抵额 ¥700
  const homeSku = await createTestProduct({
    suffix: 'HOME',
    productKind: '家居产品',
    productType: '家居产品',
    salesCategory: '他销他耗',
    price: 100,
    sessionCount: null,
  })
  const targetSku = await createTestProduct({
    suffix: 'HTGT',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销自耗',
    price: 300,
    sessionCount: 1,
  })

  const srcOrderId = `${NS}_HCONV_SRC`
  await createTestSaleOrder({
    saleOrderId: srcOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    skuId: homeSku.skuId,
    productName: homeSku.specName,
    productType: '家居产品',
    quantity: 10,
    sessionCount: null,
    salesCategory: '他销他耗',
    totalAmount: 1000,
    status: '已支付',
  })
  const srcItems = await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [srcOrderId])
  const srcItemId = srcItems[0].sale_item_id
  // 模拟已物理提货 3 盒 —— 必须同时写 pickup_records：
  // picked_quantity = LEAST(settled, SUM(pickup_records))，只改 picked_up_quantity 会让这 3 盒
  // 被算成「已退款」（settled − picked − converted），复现不出真实的「已提 3 盒」状态。
  await pgQuery(
    `UPDATE sale_items SET picked_up_quantity = 3 WHERE sale_item_id = $1`, [srcItemId])
  await pgQuery(
    `INSERT INTO pickup_records (sale_item_id, inventory_sku_id, pickup_quantity, store_id, client_user_id, confirmed_by, remark, idempotency_key)
     VALUES ($1, NULL, 3, $2, $3, $4, 'e2e-home-conv-fixture', $5)`,
    [srcItemId, TEST_STORE_ID, TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, `${NS}_HCONV_PICKUP`])
  // 家居 SKU 单位显式设为「盒」——夹具默认 unit='次'，不设则 unit 断言无意义
  await pgQuery(`UPDATE product_skus SET unit = '盒' WHERE sku_id = $1`, [homeSku.skuId])

  // 同组第二行（共享 sale_item_group_id）：验证分组聚合不算重不算漏
  const siblingItemId = `${srcItemId}_G2`
  await pgQuery(
    `INSERT INTO sale_items (
       sale_item_id, sale_item_group_id, sale_order_id, store_id, item_direction,
       sku_id, product_name, product_type, quantity,
       unit_price, unit_real_price, sale_amount, received, sales_category
     )
     SELECT $1, COALESCE(sale_item_group_id, sale_item_id), sale_order_id, store_id, item_direction,
            sku_id, product_name, product_type, 5,
            unit_price, unit_real_price, 500, 500, sales_category
       FROM sale_items WHERE sale_item_id = $2`,
    [siblingItemId, srcItemId])
  // 手插的第二行不会自动进订单总额，这里补齐订单口径（A 1000 + B 500），
  // 否则 createRefund 的「可退余额」闸门会按旧的 1000 判定
  await pgQuery(
    `UPDATE sale_orders SET total_amount = 1500, payable_amount = 1500, received = 1500
      WHERE sale_order_id = $1`, [srcOrderId])
  rec(`  ✓ fixture: 家居行 ${srcItemId} 10 盒 × ¥100，已提 3 → 未提货 7`)

  // ── 1. 折抵候选 ──
  const held = await invokeStaffApi('order.customerHeldCards', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  check(held.code === 0, `customerHeldCards code=${held.code} msg=${held.message}`)
  const homeCard = (held.data?.cards || []).find((c) => c.saleItemId === srcItemId)
  check(!!homeCard, '家居行未出现在折抵候选中')
  if (homeCard) {
    check(homeCard.productType === '家居产品', `productType 应=家居产品，实际=${homeCard.productType}`)
    check(Number(homeCard.remainingQuantity) === 7, `remainingQuantity 应=7，实际=${homeCard.remainingQuantity}`)
    check(Number(homeCard.deductibleAmount) === 700, `deductibleAmount 应=700，实际=${homeCard.deductibleAmount}`)
    // unit 取 COALESCE(product_skus.unit, 家居回落'盒')；夹具 SKU 未设 unit 时以 SKU 值为准，
    // 这里只断言字段有下发（生产家居 SKU 的 unit 为「盒」）
    check(homeCard.unit === '盒', `unit 应=盒，实际=${homeCard.unit}`)
  }

  // ── 2. 建转换单（折抵 700 − 转入 300 = −400，走储值卡补差 → 已支付）──
  const conv = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [srcItemId],
    convertInItems: [{ skuId: targetSku.skuId, quantity: 1 }],
    paymentMethod: '线下',
    remark: 'e2e-home-conversion',
  })
  check(conv.code === 0, `createConversion code=${conv.code} msg=${conv.message}`)
  if (conv.code !== 0) return
  const convOrderId = conv.data.saleOrderId
  check(conv.data.priceDiff === -400, `priceDiff 应=-400，实际=${conv.data.priceDiff}`)

  const outRows = await pgQuery(
    `SELECT quantity, received, sale_amount, ref_sale_item_id, product_type
       FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转出'`, [convOrderId])
  check(outRows.length === 1, `转出行应=1，实际=${outRows.length}`)
  if (outRows[0]) {
    check(Number(outRows[0].quantity) === 7, `转出.quantity 应=7，实际=${outRows[0].quantity}`)
    check(Number(outRows[0].received) === -700, `转出.received 应=-700，实际=${outRows[0].received}`)
    check(outRows[0].product_type === '家居产品', `转出.product_type 应=家居产品`)
    check(outRows[0].ref_sale_item_id === srcItemId, `转出.ref_sale_item_id 应=${srcItemId}`)
  }

  // ── 源行 picked_up_quantity：3 + 7 = 10 ──
  const afterConv = await pgQuery(
    `SELECT picked_up_quantity FROM sale_items WHERE sale_item_id = $1`, [srcItemId])
  check(Number(afterConv[0]?.picked_up_quantity) === 10,
    `折抵后 picked_up_quantity 应=10（3 已提 + 7 已转），实际=${afterConv[0]?.picked_up_quantity}`)

  // ── 3. 顾客档案家居 Tab：待提归零 + 已转换 7 + 已退款 0 ──
  const home1 = await invokeStaffApi('customer.homeProducts', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  check(home1.code === 0, `customer.homeProducts code=${home1.code}`)
  const homeRows1 = (home1.data || []).filter((r) => r.saleItemGroupId === srcItemId || r.saleItemId === srcItemId)
  check(homeRows1.length === 1, `同组两行应聚合为 1 条，实际=${homeRows1.length}`)
  const row1 = homeRows1[0]
  check(!!row1, '折抵后家居行不应从档案里消失（存在性过滤须放行 converted）')
  if (row1) {
    // 组内：A 10 盒（提 3 + 转 7）、B 5 盒（全未提）→ purchased 15 / settled 10 / picked 3 / converted 7
    check(Number(row1.purchasedQuantity) === 15, `组内购买合计应=15，实际=${row1.purchasedQuantity}`)
    check(Number(row1.convertedQuantity) === 7, `已转换应=7（只算 A 行，不得跨组算重），实际=${row1.convertedQuantity}`)
    check(Number(row1.refundedQuantity) === 0, `已退款应=0（不得把转换算成退款），实际=${row1.refundedQuantity}`)
    check(Number(row1.pickedQuantity) === 3, `已提应=3，实际=${row1.pickedQuantity}`)
    // A 已全部结算，B 的 5 盒仍可提
    check(Number(row1.pendingPickupQuantity) === 5, `待提应=5（B 行未动），实际=${row1.pendingPickupQuantity}`)
  }

  // ── 4. 提货候选不再放行 ──
  const pickup = await invokeStaffApi('order.availablePickupItems', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  check(pickup.code === 0, `availablePickupItems code=${pickup.code} msg=${pickup.message}`)
  const pickupList = pickup.data?.items ?? pickup.data ?? []
  check(Array.isArray(pickupList), 'availablePickupItems 未返回数组')
  if (Array.isArray(pickupList)) {
    const stillPickable = pickupList.some(
      (it) => (it.sourceSaleItemIds ?? [it.saleItemId]).includes(srcItemId)
        && Number(it.remaining ?? it.pendingPickupQuantity ?? 0) > 0)
    check(!stillPickable, '折抵后该行仍出现在可提货候选中（已转走的数量不得可提）')
  }

  // ── 5. 关闭转换单 → 数量完整复原（回滚段闭环）──
  // 先把转换单打回「待支付」，模拟差额未结清即关单的场景
  await pgQuery(`UPDATE sale_orders SET status = '待支付' WHERE sale_order_id = $1`, [convOrderId])
  const closed = await invokeStaffApi('order.close', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: convOrderId,
  })
  check(closed.code === 0, `close code=${closed.code} msg=${closed.message}`)

  const afterClose = await pgQuery(
    `SELECT picked_up_quantity FROM sale_items WHERE sale_item_id = $1`, [srcItemId])
  check(Number(afterClose[0]?.picked_up_quantity) === 3,
    `关单回滚后 picked_up_quantity 应复原=3，实际=${afterClose[0]?.picked_up_quantity}`)

  const home2 = await invokeStaffApi('customer.homeProducts', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  const row2 = (home2.data || []).find((r) => r.saleItemGroupId === srcItemId || r.saleItemId === srcItemId)
  check(!!row2, '回滚后家居行应重新可见')
  if (row2) {
    check(Number(row2.pendingPickupQuantity) === 12, `回滚后待提应=12（A 复原 7 + B 5），实际=${row2.pendingPickupQuantity}`)
    check(Number(row2.convertedQuantity) === 0, `回滚后已转换应=0（已关闭单不计入），实际=${row2.convertedQuantity}`)
    check(Number(row2.refundedQuantity) === 0, `回滚后已退款应=0，实际=${row2.refundedQuantity}`)
  }

  // ── 6. G2 闸门：退款审批前可退量被折抵吃掉 → 拒绝审批（资损守卫的核心防线）──
  // 用同组 B 行（5 盒未提）建退款申请，再模拟并发转换把这 5 盒折抵走，审批必须 CONFLICT 而非放行。
  const ref = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: srcOrderId,
    items: [{ saleItemId: siblingItemId, refundQuantity: 5 }],
    refundReason: 'e2e_home_g2',
  })
  check(ref.code === 0, `createRefund 应成功，实际 code=${ref.code} msg=${ref.message}`)
  if (ref.code === 0) {
    // 模拟并发转换折抵：把 B 行整行结算掉（等价于转换事务先提交）
    await pgQuery(
      `UPDATE sale_items SET picked_up_quantity = quantity WHERE sale_item_id = $1`, [siblingItemId])

    const apr = await invokeStaffApi('order.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'e2e-g2',
    })
    check(apr.code === -409, `G2 应拒绝审批（CONFLICT/-409），实际 code=${apr.code} msg=${apr.message}`)
    check(String(apr.message || '').includes('家居产品可退数量已变化'),
      `G2 拒绝文案应可指引店员重发起，实际='${apr.message}'`)

    // 事务必须整体回滚：流水仍待审批、订单 refunded_amount 未动
    const sop = await pgQuery(
      `SELECT status FROM sale_order_payments WHERE id = $1`, [ref.data.paymentId])
    check(sop[0]?.status === '待审批', `被拒后退款流水应仍为待审批，实际='${sop[0]?.status}'`)
    const ordAfter = await pgQuery(
      `SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`, [srcOrderId])
    check(Number(ordAfter[0]?.refunded_amount || 0) === 0,
      `被拒后 refunded_amount 应=0，实际=${ordAfter[0]?.refunded_amount}`)

    // 清掉这笔待审批流水，避免干扰后续候选断言（待审批退款会冻结整单折抵）
    await pgQuery(`DELETE FROM sale_order_payments WHERE id = $1`, [ref.data.paymentId])
  }

  // ── 7. 全部结算的家居行不进候选 ──
  await pgQuery(`UPDATE sale_items SET picked_up_quantity = quantity WHERE sale_item_id = $1`, [srcItemId])
  const held2 = await invokeStaffApi('order.customerHeldCards', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  const stillCandidate = (held2.data?.cards || []).some((c) => c.saleItemId === srcItemId)
  check(!stillCandidate, '已全部结算的家居行不应出现在折抵候选中')

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec('  ✅ PASS — 家居折抵全链路正确（候选 → 折抵 → 提货/退款闸门 → 关单回滚复原）')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-home-conversion] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  // cleanupTestData 不含 pickup_records，本 smoke 自己插了提货记录，必须先删否则外键阻塞级联清理
  try {
    await pgQuery(
      `DELETE FROM pickup_records WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id LIKE $1)`,
      [`${NS}%`])
  } catch (e) { console.error('[cleanup pickup_records]', e.message) }
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-home-conversion] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
