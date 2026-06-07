#!/usr/bin/env bun
/**
 * 核心冒烟：欠款 + 充值卡 的 confirmOffline 现金口径（2026-06-08 修复守护）
 *
 * 背景（美容业欠款流程）：
 *   - 应付 total=5000；店长开单逐行下调「实付」→ 当下实付 pending=4000（欠 1000）；
 *   - 充值卡从「当下实付」里抵 prepaid=900。
 *   - 顾客当下应付 = pending = 4000 = 现金 3100 + 卡 900。
 *
 * 修复前 Bug：confirmOffline 缺省把 pending(4000) 全当现金、再叠加扣卡 900 →
 *   客户被收 4900（多收一笔卡额）。
 * 修复后：现金 = pending − prepaid − 已收 = 3100；卡扣 900；合计当下收 4000 = pending。
 *
 * 断言：
 *   - result.code === 0
 *   - sale_order_payments[change_type='首次支付'].amount === 3100（现金口径，核心修复点）
 *   - sale_order_payments[change_type='储值卡抵扣'].amount === 900
 *   - sale_orders.received === 3100（纯现金）、status === '部分支付'（欠款 1000 未结清）
 *   - prepaid_cards.balance 扣减 900（1000 → 100）
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
  createTestSaleOrder, createTestPrepaidCard,
  cleanupTestData,
} from './helpers/fixtures.mjs'
import { snapshot, diff, fmtDiff } from './helpers/pg-snapshot.mjs'

const ORDER_ID = `${NS}_OCODC` // OrderConfirmOffline Debt+Card（sale_order_id varchar(30) 内）
const TOTAL = 5000             // 应付合计
const PENDING = 4000           // 当下实付（欠 1000）
const PREPAID = 900            // 充值卡抵扣（从当下实付里抵）
const BALANCE = 1000           // 卡余额（≥ PREPAID）
const EXPECT_CASH = PENDING - PREPAID // 3100 现金（修复点：不是 pending 全额）

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-confirm-offline-debt-card] start | ${new Date().toISOString()}`)

  // ─── 1. 清理 + 建 fixture ───
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // 店长（manager）
  await createTestClient({ pointsBalance: 0 })
  await createTestPrepaidCard({ initialBalance: BALANCE })
  await createTestSaleOrder({
    saleOrderId: ORDER_ID,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: TOTAL,
    prepaidCardAmount: PREPAID, // → fixture 落 payable_amount = 5000 − 900 = 4100
    status: '待支付',
    paymentMethod: '线下',
  })
  // 两步式开单态：sale_items.received=0、逐行实付草稿 pending_received=当下实付（欠款 < 应付）
  await pgQuery(
    `UPDATE sale_items SET pending_received = $1, received = 0 WHERE sale_order_id = $2`,
    [PENDING, ORDER_ID]
  )
  rec(`  ✓ fixtures: order=${ORDER_ID} total=${TOTAL} pending=${PENDING} prepaid=${PREPAID} balance=${BALANCE}`)

  const snapSpec = {
    sale_orders: { where: 'sale_order_id = $1', params: [ORDER_ID] },
    sale_order_payments: { where: 'sale_order_id = $1', params: [ORDER_ID] },
    prepaid_cards: { where: 'user_id = $1', params: [TEST_CLIENT_USER_ID] },
  }
  const before = await snapshot(snapSpec)
  rec(`  ✓ before: balance=${before.prepaid_cards[0]?.balance} received=${before.sale_orders[0]?.received}`)

  // ─── 2. invoke confirmOffline（缺省 confirmAmount，走 pendingTotal>0 现金口径分支）───
  const result = await invokeStaffApi('order.confirmOffline', {
    saleOrderId: ORDER_ID,
    _testOpenid: TEST_MANAGER_OPENID,
  })
  rec(`  result: ${JSON.stringify(result)}`)
  if (result.code !== 0) {
    rec(`  ✗ FAIL: 期望 code=0, 实际 ${result.code} (${result.message})`)
    return
  }

  const after = await snapshot(snapSpec)
  rec(`  diff:\n${fmtDiff(diff(before, after))}`)

  // ─── 3. 断言 ───
  const errors = []
  const payments = after.sale_order_payments
  const cashRow = payments.find((p) => p.change_type === '首次支付')
  const cardRow = payments.find((p) => p.change_type === '储值卡抵扣')

  if (!cashRow) {
    errors.push(`缺 sale_order_payments[change_type='首次支付'] 现金行`)
  } else if (Number(cashRow.amount) !== EXPECT_CASH) {
    errors.push(`[CORE] 现金应收应=${EXPECT_CASH}（pending−prepaid），实际 '首次支付'.amount=${cashRow.amount}`)
  }

  if (!cardRow) {
    errors.push(`缺 sale_order_payments[change_type='储值卡抵扣'] 行`)
  } else if (Number(cardRow.amount) !== PREPAID) {
    errors.push(`'储值卡抵扣'.amount 应=${PREPAID}，实际=${cardRow.amount}`)
  }

  const ord = after.sale_orders[0]
  if (Number(ord?.received) !== EXPECT_CASH) {
    errors.push(`sale_orders.received 应=${EXPECT_CASH}（纯现金），实际=${ord?.received}`)
  }
  if (ord?.status !== '部分支付') {
    errors.push(`sale_orders.status 应='部分支付'（欠款 ${TOTAL - PENDING} 未结清），实际='${ord?.status}'`)
  }

  const balAfter = Number(after.prepaid_cards[0]?.balance ?? -1)
  if (balAfter !== BALANCE - PREPAID) {
    errors.push(`prepaid_cards.balance 应=${BALANCE - PREPAID}（扣 ${PREPAID}），实际=${balAfter}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 欠款+卡：现金 ${EXPECT_CASH} + 卡 ${PREPAID} = 当下实付 ${PENDING}，欠款 ${TOTAL - PENDING} 留待回款`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-confirm-offline-debt-card] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('cleanup error:', e.message) }
  await closePool()
  console.log(`[smoke-confirm-offline-debt-card] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
