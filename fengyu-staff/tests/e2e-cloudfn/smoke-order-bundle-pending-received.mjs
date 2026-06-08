#!/usr/bin/env bun
/**
 * 组合套餐/多卡单：received 按逐行实付草稿 pending_received 累加分摊冒烟
 * （2026-06-08 STEP1 两段式瀑布 SALE_ITEMS_RECEIVED_ALLOC_SQL）
 *
 * 场景（净化美人例）：3 张疗程卡，sale_amount 各 650（共应付 1950）、session_count 各 1。
 * 店长逐行填实付草稿 pending_received = [650, 150, 0]（首付 800，卡1付满、卡2部分、卡3未付）。
 *
 *   1. confirmOffline 首付 800（无定向）→ 两段式第一段按 pend_cap 铺：
 *      received = [650, 150, 0]（而非旧逻辑「按应付均摊」800/3≈266.67/行）；
 *      paid_sessions = [1, 0, 0]（卡1解锁、卡2/3锁）；order.received=800、部分支付；Σ守恒。
 *   2. 无定向回款补全款 1150 → 第一段铺满 800 + 第二段按 sale_cap 铺溢出 1150：
 *      received = [650, 650, 650]（卡3 received 回升到应付，**不冻结**）；
 *      paid_sessions = [1, 1, 1]（全解锁）；order.received=1950、已支付；Σ守恒。
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestSaleItem, cleanupTestData,
} from './helpers/fixtures.mjs'

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-bundle-pending-received] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderNo = `${NS}_BPR`
  const item1 = `${orderNo}_ITEM_1`
  const item2 = `${orderNo}_ITEM_2`
  const item3 = `${orderNo}_ITEM_3`

  // 订单 + 卡1（疗程卡 650 / 1 次）
  await createTestSaleOrder({
    saleOrderId: orderNo, clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_净化美人1`, productType: '疗程卡', sessionCount: 1,
    totalAmount: 650, status: '待支付', salesCategory: '他销自耗',
  })
  // 卡2、卡3（各 650 / 1 次）
  await createTestSaleItem({
    saleOrderId: orderNo, saleItemId: item2,
    productName: `${NS}_净化美人2`, productType: '疗程卡', unitPrice: 650, quantity: 1,
    sessionCount: 1, salesCategory: '他销自耗',
  })
  await createTestSaleItem({
    saleOrderId: orderNo, saleItemId: item3,
    productName: `${NS}_净化美人3`, productType: '疗程卡', unitPrice: 650, quantity: 1,
    sessionCount: 1, salesCategory: '他销自耗',
  })
  // 订单总额 1950，received 起点 0；逐行 received 归零（模拟两步式开单不记账）
  await pgQuery(
    `UPDATE sale_orders SET total_amount = 1950, payable_amount = 1950, received = 0 WHERE sale_order_id = $1`,
    [orderNo]
  )
  await pgQuery(`UPDATE sale_items SET received = 0 WHERE sale_order_id = $1`, [orderNo])
  // 逐行实付草稿 pending_received = [650, 150, 0]（首付 800）
  await pgQuery(`UPDATE sale_items SET pending_received = 650 WHERE sale_item_id = $1`, [item1])
  await pgQuery(`UPDATE sale_items SET pending_received = 150 WHERE sale_item_id = $1`, [item2])
  await pgQuery(`UPDATE sale_items SET pending_received = 0   WHERE sale_item_id = $1`, [item3])

  const errors = []
  const r2 = (n) => Math.round(Number(n) * 100) / 100
  const fetchItems = async () => {
    const rows = await pgQuery(
      `SELECT sale_item_id, received, paid_sessions FROM sale_items WHERE sale_order_id = $1`,
      [orderNo]
    )
    return {
      i1: rows.find((x) => x.sale_item_id === item1),
      i2: rows.find((x) => x.sale_item_id === item2),
      i3: rows.find((x) => x.sale_item_id === item3),
      sum: r2(rows.reduce((s, x) => s + Number(x.received), 0)),
    }
  }

  // ── 1. confirmOffline 首付 800（无定向）──
  const conf = await invokeStaffApi('order.confirmOffline', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderNo,
    confirmAmount: 800,
  })
  if (conf.code !== 0) {
    errors.push(`首付 confirmOffline 应成功，实际 code=${conf.code} msg=${conf.message}`)
  } else {
    const { i1, i2, i3, sum } = await fetchItems()
    const ord = await pgQuery(`SELECT received, status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
    // 核心：received 按 pending_received 铺（[650,150,0]），而非应付均摊（800/3≈266.67）
    if (r2(i1.received) !== 650) errors.push(`首付后 卡1.received 应=650（=pending），实际 ${i1.received}`)
    if (r2(i2.received) !== 150) errors.push(`首付后 卡2.received 应=150（=pending，非均摊266.67），实际 ${i2.received}`)
    if (r2(i3.received) !== 0)   errors.push(`首付后 卡3.received 应=0（=pending），实际 ${i3.received}`)
    if (Number(i1.paid_sessions) !== 1) errors.push(`首付后 卡1.paid_sessions 应=1，实际 ${i1.paid_sessions}`)
    if (Number(i2.paid_sessions) !== 0) errors.push(`首付后 卡2.paid_sessions 应=0，实际 ${i2.paid_sessions}`)
    if (Number(i3.paid_sessions) !== 0) errors.push(`首付后 卡3.paid_sessions 应=0，实际 ${i3.paid_sessions}`)
    if (r2(ord[0].received) !== 800) errors.push(`首付后 order.received 应=800，实际 ${ord[0].received}`)
    if (ord[0].status !== '部分支付') errors.push(`首付后 order.status 应=部分支付，实际 ${ord[0].status}`)
    if (sum !== r2(ord[0].received)) errors.push(`首付后 Σ(item.received)=${sum} 应=order.received=${ord[0].received}`)
    if (errors.length === 0) rec(`  ✅ 首付 800：received=[650,150,0]（按 pending 非均摊）、paid_sessions=[1,0,0]、Σ守恒`)
  }

  // ── 2. 无定向回款补全款 1150（付清，验证不冻结）──
  const phase1Errs = errors.length
  const repay = await invokeStaffApi('order.createRepayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderNo,
    paymentMethod: '线下',
    repayAmount: 1150,
    note: 'e2e_bundle_repay_full',
  })
  if (repay.code !== 0) {
    errors.push(`补全款 createRepayment 应成功，实际 code=${repay.code} msg=${repay.message}`)
  } else {
    const { i1, i2, i3, sum } = await fetchItems()
    const ord = await pgQuery(`SELECT received, status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
    // 核心：付清后各行 received 回升到应付 650，卡3 不再冻结
    if (r2(i1.received) !== 650) errors.push(`付清后 卡1.received 应=650，实际 ${i1.received}`)
    if (r2(i2.received) !== 650) errors.push(`付清后 卡2.received 应=650，实际 ${i2.received}`)
    if (r2(i3.received) !== 650) errors.push(`付清后 卡3.received 应=650（回升到应付，不冻结），实际 ${i3.received}`)
    if (Number(i1.paid_sessions) !== 1) errors.push(`付清后 卡1.paid_sessions 应=1，实际 ${i1.paid_sessions}`)
    if (Number(i2.paid_sessions) !== 1) errors.push(`付清后 卡2.paid_sessions 应=1，实际 ${i2.paid_sessions}`)
    if (Number(i3.paid_sessions) !== 1) errors.push(`付清后 卡3.paid_sessions 应=1（全解锁），实际 ${i3.paid_sessions}`)
    if (r2(ord[0].received) !== 1950) errors.push(`付清后 order.received 应=1950，实际 ${ord[0].received}`)
    if (ord[0].status !== '已支付') errors.push(`付清后 order.status 应=已支付，实际 ${ord[0].status}`)
    if (sum !== r2(ord[0].received)) errors.push(`付清后 Σ(item.received)=${sum} 应=order.received=${ord[0].received}`)
    if (errors.length === phase1Errs) rec(`  ✅ 补全款 1150：received=[650,650,650]（卡3回升不冻结）、paid_sessions=[1,1,1]、Σ守恒`)
  }

  await cleanupTestData(NS)
  await closePool()

  if (errors.length > 0) {
    rec(`[smoke-order-bundle-pending-received] FAIL`)
    for (const e of errors) rec(`  ❌ ${e}`)
    process.exit(1)
  }
  rec(`[smoke-order-bundle-pending-received] end | all passed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
