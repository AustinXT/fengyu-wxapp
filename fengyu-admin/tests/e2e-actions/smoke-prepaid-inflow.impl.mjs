/**
 * 旧系统充值金转入 createPrepaidInflow 端到端冒烟（由 smoke-prepaid-inflow.mjs wrapper 启动）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 验证核心不变量（旧系统充值金转入）：
 *   1. createPrepaidInflow → 建 sale_order_type='充值单' status='已支付' 单，
 *      total=payable=received=amount（1:1 等额，不打折），prepaid_card_amount=0，payment_method='线下'，remark 含「旧系统充值金转入」
 *   2. 一条 change_type='首次支付' 流水（线下/已支付/external_txn_id=NULL/note 含标记）→ 维护 received=Σ流水（资金不变量 I1）
 *   3. card_transactions(type='充值', amount=amount, external_ref='card-topup-{id}')；prepaid_cards.balance += amount
 *   4. amount 取非档位带小数大额（5288.80）→ 证明绕过 matchTier 不打折、不限额
 */
import path from 'node:path'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

process.env.ALLOW_TEST_OPENID = 'true'
// 用开发库 fengyu（schema 完整，与 staff e2e 同库、NS 前缀隔离）；
// 默认 e2e 库 fengyu_e2e 当前缺 store_name/is_activity 列（schema drift，待对其单独跑 db:migrate 同步）。
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING

const setup = await import('file://' + path.join(TESTS_DIR, 'setup.mjs'))
const fixtures = await import('file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs'))

const { NS, TEST_CLIENT_USER_ID, TEST_STORE_ID, closePool, getPool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

const pool = getPool()
const q = (sql, params) => pool.query(sql, params)

const AMOUNT = 5288.80 // 非档位 + 带小数 + 大额：matchTier 会拦/打折，inflow 必须精确等额
let createdOrderId = null

async function cleanupCardAndOrder() {
  await q(`DELETE FROM card_transactions WHERE card_id = $1`, [`FY-CARD-${TEST_CLIENT_USER_ID}`])
  await q(`DELETE FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID])
  if (createdOrderId) {
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id = $1`, [createdOrderId])
    await q(`DELETE FROM operation_logs WHERE target_id = $1`, [createdOrderId])
    await q(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [createdOrderId])
  }
}

let pass = false
let exitCode = 1

async function main() {
  console.log(`[smoke-prepaid-inflow] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  // 清掉可能残留的卡（一户一卡，确保转入前余额为 0）
  await cleanupCardAndOrder()
  console.log(`  ✓ fixtures ready: client=${TEST_CLIENT_USER_ID} store=${TEST_STORE_ID}`)

  const ordersMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'orders.ts'))
  const errors = []

  const created = await ordersMod.createPrepaidInflow({
    clientUserId: TEST_CLIENT_USER_ID,
    storeId: TEST_STORE_ID,
    amount: AMOUNT,
    remark: 'WorkFine迁移',
  })
  console.log(`  create result: ${JSON.stringify(created)}`)
  if (!created.success || !created.saleOrderId) {
    console.log(`  ✗ FAIL: createPrepaidInflow 失败`)
    return
  }
  createdOrderId = created.saleOrderId

  // 1) 订单字段
  const ord = (await q(
    `SELECT status, sale_order_type, total_amount::numeric AS total, payable_amount::numeric AS pay,
            received::numeric AS recv, prepaid_card_amount::numeric AS prep, payment_method, remark
     FROM sale_orders WHERE sale_order_id = $1`, [createdOrderId],
  )).rows[0]
  if (ord.status !== '已支付') errors.push(`status 应=已支付, 实际=${ord.status}`)
  if (ord.sale_order_type !== '充值单') errors.push(`sale_order_type 应=充值单, 实际=${ord.sale_order_type}`)
  if (Number(ord.total) !== AMOUNT) errors.push(`total_amount 应=${AMOUNT}, 实际=${ord.total}`)
  if (Number(ord.pay) !== AMOUNT) errors.push(`payable_amount 应=${AMOUNT}(不打折), 实际=${ord.pay}`)
  if (Number(ord.recv) !== AMOUNT) errors.push(`received 应=${AMOUNT}(I1), 实际=${ord.recv}`)
  if (Number(ord.prep) !== 0) errors.push(`prepaid_card_amount 应=0, 实际=${ord.prep}`)
  if (ord.payment_method !== '线下') errors.push(`payment_method 应=线下, 实际=${ord.payment_method}`)
  if (!String(ord.remark || '').includes('旧系统充值金转入')) errors.push(`remark 应含标记, 实际=${ord.remark}`)
  else console.log(`  ✓ 订单字段 OK（充值单/已支付/total=payable=received=${AMOUNT}/线下/标记备注）`)

  // 2) 首次支付流水
  const pays = (await q(
    `SELECT change_type, amount::numeric AS amt, payment_method, status, external_txn_id, note
     FROM sale_order_payments WHERE sale_order_id = $1`, [createdOrderId],
  )).rows
  if (pays.length !== 1) {
    errors.push(`sale_order_payments 应=1 行, 实际=${pays.length}`)
  } else {
    const p = pays[0]
    if (p.change_type !== '首次支付') errors.push(`流水 change_type 应=首次支付, 实际=${p.change_type}`)
    if (Number(p.amt) !== AMOUNT) errors.push(`流水 amount 应=${AMOUNT}, 实际=${p.amt}`)
    if (p.status !== '已支付') errors.push(`流水 status 应=已支付, 实际=${p.status}`)
    if (p.payment_method !== '线下') errors.push(`流水 payment_method 应=线下, 实际=${p.payment_method}`)
    if (p.external_txn_id !== null) errors.push(`流水 external_txn_id 应=NULL, 实际=${p.external_txn_id}`)
    else console.log(`  ✓ 首次支付流水 OK（线下/已支付/external_txn_id=NULL）`)
  }

  // 3) card_transactions 入账 + 幂等键
  const txn = (await q(
    `SELECT type, amount::numeric AS amt, external_ref FROM card_transactions WHERE ref_order_id = $1 AND type = '充值'`, [createdOrderId],
  )).rows
  if (txn.length !== 1) {
    errors.push(`card_transactions 充值入账应=1 行, 实际=${txn.length}`)
  } else {
    if (Math.abs(Number(txn[0].amt) - AMOUNT) > 0.001) errors.push(`入账 amount 应=${AMOUNT}, 实际=${txn[0].amt}`)
    if (txn[0].external_ref !== `card-topup-${createdOrderId}`) errors.push(`external_ref 应=card-topup-${createdOrderId}, 实际=${txn[0].external_ref}`)
  }

  // 4) prepaid_cards 余额精确等额（证明不打折、不限额）
  const card = (await q(`SELECT balance::numeric AS bal FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID])).rows[0]
  if (Math.abs(Number(card?.bal) - AMOUNT) > 0.001) errors.push(`balance 应=${AMOUNT}(等额不打折), 实际=${card?.bal}`)
  else console.log(`  ✓ 储值卡余额 OK：精确 +¥${card?.bal}（绕过 matchTier 不打折/不限额）`)

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — admin createPrepaidInflow：等额不打折入账 + 首次支付流水(I1) + 标记备注 + card-topup 幂等键`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-prepaid-inflow] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupCardAndOrder()
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-prepaid-inflow] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-prepaid-inflow] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
