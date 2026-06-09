/**
 * 真正的 smoke-record-payment 实现（由 smoke-record-payment.mjs wrapper 启动）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 步骤：
 *   1. fixtures: 测试店 + 店长 + 顾客 + 待支付销售单 ¥200
 *   2. 动态 import admin orders.ts recordPayment
 *   3. 调 recordPayment({ saleOrderId, repayAmount:200, paymentMethod:'线下', externalTxnId:'TEST_...' })
 *   4. 断言：success / 积分+2 / settleFailed=0
 *
 * 注意：此脚本运行时 cwd=fengyu-admin/，所有相对路径都要走 REPO_ROOT 重建。
 */
import path from 'node:path'

// REPO_ROOT 不能依赖 cwd（cwd=admin/）；用 import.meta.url 反推
const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename) // .../fengyu-admin/tests/e2e-actions
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

// 在 import setup.mjs 前注入正确的环境变量
process.env.ALLOW_TEST_OPENID = 'true'
process.env.POINTS_ACCRUAL_ENABLED = process.env.POINTS_ACCRUAL_ENABLED || 'true'
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu_e2e'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING

// 用绝对路径 import setup / fixtures（cwd=admin/，相对路径不可靠）
const setupUrl = 'file://' + path.join(TESTS_DIR, 'setup.mjs')
const fixturesUrl = 'file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs')
const snapUrl = 'file://' + path.join(TESTS_DIR, 'helpers', 'pg-snapshot.mjs')

const setup = await import(setupUrl)
const fixtures = await import(fixturesUrl)
const snapMod = await import(snapUrl)

const { NS, TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, TEST_STORE_ID, getPool, closePool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder } = fixtures
const { snapshot, diff, fmtDiff } = snapMod

// 把 store_id 传给 preload mock（preload 已加载，无法回灌；只是文档作用）
process.env.TEST_STORE_ID = TEST_STORE_ID
process.env.TEST_ADMIN_EMP_ID = TEST_MANAGER_EMP_ID

const ORDER_ID = `${NS}_RP` // RecordPayment
const REPAY_AMOUNT = 200 // → expected 积分 = floor(200/100) = 2
const TEST_TXN_ID = `${NS}_TXN_${Date.now()}`

let pass = false
let exitCode = 1

async function main() {
  console.log(`[smoke-record-payment] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  await createTestSaleOrder({
    saleOrderId: ORDER_ID,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: REPAY_AMOUNT,
    status: '待支付',
    paymentMethod: '线下',
  })
  // 模拟普通销售单 order.create 现实：allocation_status 出生为 NULL（schema 无默认值，回款分配缺口根因）。
  // fixtures 写死'待分配'，这里抹回 NULL，以验证 recordPayment 收款路径的 COALESCE 初始化。
  await getPool().query(`UPDATE sale_orders SET allocation_status = NULL WHERE sale_order_id = $1`, [ORDER_ID])
  console.log(`  ✓ fixtures ready: order=${ORDER_ID} ¥${REPAY_AMOUNT}（allocation_status 抹回 NULL 模拟根因）`)

  const snapSpec = {
    point_transactions: { where: 'ref_order_id = $1 OR user_id = $2', params: [ORDER_ID, TEST_CLIENT_USER_ID] },
    client_wechat_users: { where: 'user_id = $1', params: [TEST_CLIENT_USER_ID] },
    operation_logs: { where: `action = 'points.settleFailed' AND target_id = $1`, params: [ORDER_ID] },
    sale_orders: { where: 'sale_order_id = $1', params: [ORDER_ID] },
    sale_order_payments: { where: 'sale_order_id = $1', params: [ORDER_ID] },
  }
  const before = await snapshot(snapSpec)
  console.log(`  ✓ snapshot before: points_balance=${before.client_wechat_users[0]?.points_balance}`)

  // 动态 import admin recordPayment（preload 已 mock 掉 next/cache + @/lib/auth + ...）
  const ordersMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'orders.ts'))
  const result = await ordersMod.recordPayment({
    saleOrderId: ORDER_ID,
    repayAmount: REPAY_AMOUNT,
    paymentMethod: '线下',
    externalTxnId: TEST_TXN_ID,
    note: 'e2e smoke',
  })
  console.log(`  result: ${JSON.stringify(result)}`)

  if (!result.success) {
    console.log(`  ✗ FAIL: 期望 success=true，实际 ${JSON.stringify(result.error)}`)
    return
  }

  const after = await snapshot(snapSpec)
  const d = diff(before, after)
  console.log(`  diff:\n${fmtDiff(d)}`)

  const errors = []
  if (after.operation_logs.length !== 0) {
    errors.push(`operation_logs[points.settleFailed] 应=0, 实际=${after.operation_logs.length}`)
  }
  if (d.point_transactions.added !== 1) {
    errors.push(`point_transactions 应+1, 实际+${d.point_transactions.added}`)
  } else {
    const pt = d.point_transactions.addedRows[0]
    if (Number(pt.amount) !== 2) errors.push(`amount 应=2, 实际=${pt.amount}`)
    if (pt.type !== '消费赠送') errors.push(`type 应='消费赠送', 实际='${pt.type}'`)
    if (pt.ref_order_id !== ORDER_ID) errors.push(`ref_order_id 应=${ORDER_ID}, 实际=${pt.ref_order_id}`)
  }
  // sale_order_payments 应+1（首次支付 or 回款）
  if (d.sale_order_payments.added !== 1) {
    errors.push(`sale_order_payments 应+1, 实际+${d.sale_order_payments.added}`)
  }
  // 回款分配缺口修复：造单后 allocation_status=NULL，recordPayment 结清应 COALESCE 初始化为'待分配'，
  // 使该单可进 staff 店长「营业额分配」流程（pendingList 要'待分配'、save 拒 NULL）。
  if (before.sale_orders[0]?.allocation_status !== null) {
    errors.push(`前置：造单后 allocation_status 应=NULL（模拟根因）, 实际=${before.sale_orders[0]?.allocation_status}`)
  }
  if (after.sale_orders[0]?.allocation_status !== '待分配') {
    errors.push(`recordPayment 应把 NULL allocation_status 初始化为'待分配', 实际=${after.sale_orders[0]?.allocation_status}`)
  }

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — admin.recordPayment 积分发放正确（+2），settleFailed=0`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-record-payment] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-record-payment] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-record-payment] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
