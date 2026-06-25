/**
 * confirmOfflinePayment 部分确认链路端到端冒烟（impl）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 不变量参考 offline-payment-confirm-invariant：
 *   - 销售单创建一律「待支付」/ received=0 / 无流水
 *   - 线下收款走 confirmOfflinePayment（支持部分确认）
 *
 * confirmOfflinePayment(session, saleOrderId, confirmAmount?) 实现口径：
 *   - 仅匹配 status='待支付' AND payment_method='线下'（首次确认入口）
 *   - confirmAmount 缺省 = 剩余应付；传入则校验 0 ≤ v ≤ 剩余应付（超额拒绝，不截断）
 *   - received 按已支付流水累加重算；未结清 → '部分支付'，结清 → '已支付'
 *   - 翻态后单已非「待支付」，第二次 confirmOfflinePayment 不再匹配（返回失败）
 *
 * 故"分两次部分确认"的真实链路：
 *   STEP1  confirmOfflinePayment(order, 100)         待支付 → 部分支付，received=100
 *   STEP2  confirmOfflinePayment(order, 200) 再次调用  → 失败（已非待支付，确认入口仅吃首次）
 *   STEP2' recordPayment({repayAmount:200})           部分支付 → 已支付，received=300（累加结清）
 *   STEP3  超额防护：对 300 元单确认 400 → 被拒（不超额不变量）
 */
import path from 'node:path'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

process.env.ALLOW_TEST_OPENID = 'true'
process.env.POINTS_ACCRUAL_ENABLED = process.env.POINTS_ACCRUAL_ENABLED || 'true'
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu_e2e'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING

const setup = await import('file://' + path.join(TESTS_DIR, 'setup.mjs'))
const fixtures = await import('file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs'))

const { NS, TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, TEST_STORE_ID, getPool, closePool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder } = fixtures

// banner：目标库 host:port/db
function bannerTarget() {
  try {
    const u = new URL(process.env.PG_CONNECTION_STRING)
    return `${u.hostname}:${u.port || 5432}${u.pathname}`
  } catch {
    return process.env.PG_CONNECTION_STRING
  }
}

process.env.TEST_STORE_ID = TEST_STORE_ID
process.env.TEST_ADMIN_EMP_ID = TEST_MANAGER_EMP_ID

const ORDER_ID = `${NS}_COP` // ConfirmOfflinePartial
const TOTAL = 300 // 待支付应付 300

const pool = getPool()
const q = (sql, params) => pool.query(sql, params)

async function fetchOrder() {
  const r = await q(
    `SELECT status, received::numeric AS recv, allocation_status AS alloc FROM sale_orders WHERE sale_order_id = $1`,
    [ORDER_ID],
  )
  return r.rows[0]
}

let pass = false
let exitCode = 1

async function main() {
  console.log(`[smoke-confirm-offline-partial] start | ${new Date().toISOString()}`)
  console.log(`  目标库: ${bannerTarget()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  await createTestSaleOrder({
    saleOrderId: ORDER_ID,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: TOTAL,
    status: '待支付',
    paymentMethod: '线下',
  })
  // 模拟普通销售单 order.create 现实：allocation_status 出生为 NULL（schema 无默认值，回款分配缺口根因）。
  // fixtures 写死'待分配'，这里抹回 NULL，以验证收款路径（confirmOfflinePayment / recordPayment）的 COALESCE 初始化。
  await q(`UPDATE sale_orders SET allocation_status = NULL WHERE sale_order_id = $1`, [ORDER_ID])

  // 不变量：创建态 received=0 / 待支付 / 无已支付流水
  const created = await fetchOrder()
  const payCntRows = await q(
    `SELECT COUNT(*)::int AS c FROM sale_order_payments WHERE sale_order_id = $1`,
    [ORDER_ID],
  )
  console.log(`  ✓ fixtures ready: order=${ORDER_ID} 应付¥${TOTAL} status=${created.status} received=${created.recv} payments=${payCntRows.rows[0].c}`)

  const ordersMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'orders.ts'))
  const errors = []

  // 创建态不变量
  if (created.status !== '待支付') errors.push(`[create] status 应=待支付, 实际=${created.status}`)
  if (Number(created.recv) !== 0) errors.push(`[create] received 应=0, 实际=${created.recv}`)
  if (payCntRows.rows[0].c !== 0) errors.push(`[create] 创建态应无流水, 实际=${payCntRows.rows[0].c} 条`)

  // ===== STEP1：部分确认 100 → 部分支付 =====
  const r1 = await ordersMod.confirmOfflinePayment(ORDER_ID, 100)
  console.log(`  STEP1 confirm(100): ${JSON.stringify(r1)}`)
  if (!r1.success) errors.push(`[step1] 应 success, 实际 ${r1.message}`)
  if (r1.status !== '部分支付') errors.push(`[step1] status 应=部分支付, 实际=${r1.status}`)
  let st = await fetchOrder()
  if (Number(st.recv) !== 100) errors.push(`[step1] received 应累加到=100, 实际=${st.recv}`)
  if (st.status !== '部分支付') errors.push(`[step1] DB status 应=部分支付, 实际=${st.status}`)
  else console.log(`  ✓ STEP1 部分支付 received=${st.recv}`)
  // 回款分配缺口修复：confirmOfflinePayment 应把 NULL allocation_status 初始化为'待分配'（COALESCE）
  if (st.alloc !== '待分配') errors.push(`[step1] confirmOfflinePayment 应把 NULL allocation_status 初始化为'待分配', 实际=${st.alloc}`)
  else console.log(`  ✓ STEP1 allocation_status NULL→待分配`)

  // ===== STEP2：confirmOfflinePayment 再次调用 → 不匹配（仅吃首次待支付）=====
  const r2 = await ordersMod.confirmOfflinePayment(ORDER_ID, 200)
  console.log(`  STEP2 confirm(200) again: ${JSON.stringify(r2)}`)
  if (r2.success) {
    errors.push(`[step2] confirmOfflinePayment 在「部分支付」态应失败（仅吃首次待支付），实际 success`)
  } else {
    console.log(`  ✓ STEP2 部分支付态二次 confirm 被正确拒绝（"${r2.message}"）`)
  }
  // received 不应被二次 confirm 改动
  st = await fetchOrder()
  if (Number(st.recv) !== 100) errors.push(`[step2] received 应仍=100（二次 confirm 无副作用）, 实际=${st.recv}`)

  // ===== STEP2'：recordPayment 补齐剩余 200 → 已支付（received 累加结清）=====
  const r3 = await ordersMod.recordPayment({
    saleOrderId: ORDER_ID,
    repayAmount: 200,
    paymentMethod: '线下',
    externalTxnId: `${NS}_TXN_${Date.now()}`,
    note: 'e2e partial confirm finalize',
  })
  console.log(`  STEP2' recordPayment(200): ${JSON.stringify(r3)}`)
  if (!r3.success) {
    errors.push(`[step2'] recordPayment 应 success, 实际 ${JSON.stringify(r3.error)}`)
  } else {
    if (r3.data.refStatus !== '已支付') errors.push(`[step2'] refStatus 应=已支付, 实际=${r3.data.refStatus}`)
    if (Number(r3.data.refPaidAmount) !== 300) errors.push(`[step2'] refPaidAmount 应=300（累加）, 实际=${r3.data.refPaidAmount}`)
    st = await fetchOrder()
    if (Number(st.recv) !== 300) errors.push(`[step2'] received 应累加到=300, 实际=${st.recv}`)
    if (st.status !== '已支付') errors.push(`[step2'] DB status 应=已支付, 实际=${st.status}`)
    else console.log(`  ✓ STEP2' 部分支付 → 已支付 received=${st.recv}`)
    // 回款分配缺口修复：recordPayment 结清后 allocation_status 仍为'待分配'（COALESCE 对已初始化值 no-op），可进店长营业额分配
    if (st.alloc !== '待分配') errors.push(`[step2'] recordPayment 结清后 allocation_status 应保持'待分配', 实际=${st.alloc}`)
    else console.log(`  ✓ STEP2' allocation_status 保持待分配（可进店长分配流程）`)
  }

  // ===== STEP3：不超额不变量 — 另起一单，确认超过应付金额应被拒 =====
  const ORDER_ID2 = `${NS}_COP2`
  await q(`DELETE FROM sale_order_payments WHERE sale_order_id = $1`, [ORDER_ID2]).catch(() => {})
  await q(`DELETE FROM sale_items WHERE sale_order_id = $1`, [ORDER_ID2]).catch(() => {})
  await q(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [ORDER_ID2]).catch(() => {})
  await createTestSaleOrder({
    saleOrderId: ORDER_ID2,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: TOTAL,
    status: '待支付',
    paymentMethod: '线下',
  })
  const rOver = await ordersMod.confirmOfflinePayment(ORDER_ID2, 400)
  console.log(`  STEP3 confirm(400) on ¥300 order: ${JSON.stringify(rOver)}`)
  if (rOver.success) {
    errors.push(`[step3] 确认 400 > 应付 300 应被拒（不超额不变量），实际 success`)
  } else {
    console.log(`  ✓ STEP3 超额确认被拒（"${rOver.message}"）`)
  }
  const over = await fetchOrderById(ORDER_ID2)
  if (over && Number(over.recv) !== 0) errors.push(`[step3] 超额被拒后 received 应仍=0, 实际=${over.recv}`)

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — confirmOfflinePayment 部分确认：received 累加、部分支付↔已支付流转正确、不超额`)
}

async function fetchOrderById(id) {
  const r = await q(`SELECT status, received::numeric AS recv FROM sale_orders WHERE sale_order_id = $1`, [id])
  return r.rows[0]
}

try {
  await main()
} catch (e) {
  console.error('[smoke-confirm-offline-partial] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await q(`DELETE FROM operation_logs WHERE target_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await q(`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await q(`DELETE FROM point_transactions WHERE ref_order_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [`${NS}_COP%`]).catch(() => {})
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-confirm-offline-partial] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-confirm-offline-partial] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
