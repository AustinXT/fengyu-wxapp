/**
 * createRefund 退款额封顶（疗程卡整卡全退截断到净已收）端到端冒烟（impl）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 退款上限 refundCap = max(sale_order_payments 已支付流水净额, sale_orders.received − refunded_amount)。
 * 整卡退款额 = 退款明细 Σ(unit_real_price × 整卡未用次数) − handlingFee。
 *
 * 2026-06-24 调整（part-paid 疗程卡可退）：疗程卡强制整卡全退、数量不可调，部分支付订单整卡值 > 净已收时，
 * 旧逻辑直接拒绝 → 该订单永远无法退款。改为：截断退款额到 refundCap（仅退已付部分）、仍作废整卡
 * （note.items[].quantity 保持整卡次数），逐项 refundAmount 等比缩到 refundCap。
 * 家居产品数量可调，无疗程卡项时超 cap 仍拒绝（让店长减少退款数量）。
 *
 * 构造：部分支付订单（疗程卡只付定金、次数全在）
 *   sale_item：疗程卡 session_count=10 / remaining=10 / unit_real_price=100 / sale_amount=1000
 *   订单 received=200（仅付 200），payments 净额=200 → refundCap=200
 *
 * 断言：整卡全退（refundQuantity=10，整卡值 1000 > 净已收 200）→ 成功，
 *   finalRefundAmount 截断到 200、流水 amount=-200 待审批、note 作废整卡(quantity=10)、note item refundAmount 缩到 200。
 */
import path from 'node:path'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

process.env.ALLOW_TEST_OPENID = 'true'
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING

const setup = await import('file://' + path.join(TESTS_DIR, 'setup.mjs'))
const fixtures = await import('file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs'))

const { NS, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, TEST_MANAGER_EMP_ID, TEST_STORE_ID, getPool, closePool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

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

const ORDER_ID = `${NS}_REFCAP`
const ITEM_ID = `${ORDER_ID}_I1`
const SALE_AMOUNT = 1000 // 疗程卡 10 次 × 单次 100
const RECEIVED = 200 // 仅付 200（部分支付）；净已收 = refundCap = 200
const UNIT_REAL_PRICE = 100
const SESSION_COUNT = 10

const pool = getPool()
const q = (sql, params) => pool.query(sql, params)

/** 构造部分支付订单：疗程卡次数全在、只付定金 200 */
async function seedPartialPaidOrder() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status, paid_at
       )
       VALUES ($1, '部分支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, $5, $6,
               $7, 0, $7, $8,
               '线下'::payment_method, $9, '待分配'::allocation_status, NOW())`,
      [ORDER_ID, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`,
       SALE_AMOUNT, RECEIVED, TEST_MANAGER_EMP_ID],
    )
    // 疗程卡：次数全在（remaining = session_count），unit_real_price = 100
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, product_type,
         session_count, remaining_sessions,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '疗程卡'::product_type,
               $5, $5,
               $6, 1, $6, $7, $8,
               false)`,
      [ITEM_ID, ORDER_ID, TEST_STORE_ID, `${NS}_疗程卡10次`, SESSION_COUNT, UNIT_REAL_PRICE, SALE_AMOUNT, RECEIVED],
    )
    // 已支付流水 200（净已收 = 200）
    await client.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, payment_method, amount, status,
         paid_at, source_end, operator_employee_id, note, created_at
       ) VALUES (
         $1, '首次支付', '线下', $2::numeric, '已支付',
         NOW(), 'admin', $3, '部分支付定金', NOW()
       )`,
      [ORDER_ID, RECEIVED, TEST_MANAGER_EMP_ID],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

let pass = false
let exitCode = 1

async function main() {
  console.log(`[smoke-refund-cap] start | ${new Date().toISOString()}`)
  console.log(`  目标库: ${bannerTarget()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  await seedPartialPaidOrder()
  console.log(`  ✓ fixtures ready: order=${ORDER_ID} 部分支付 sale_amount=${SALE_AMOUNT} received=${RECEIVED} → refundCap=${RECEIVED}`)
  console.log(`    疗程卡 ${SESSION_COUNT} 次全在, 单次退款额 unit_real_price=${UNIT_REAL_PRICE}（全退 ${UNIT_REAL_PRICE * SESSION_COUNT} > 净已收 ${RECEIVED}）`)

  const refundsMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'refunds.ts'))
  const errors = []

  // ===== 疗程卡部分支付订单：整卡全退截断到净已收（2026-06-24 调整）=====
  // 疗程卡强制整卡全退（数量不可调），整卡值 1000 > 净已收 200。旧逻辑直接拒绝 → 该订单永远无法退款；
  // 新逻辑：截断退款额到净已收 200（仅退已付部分）、仍作废整卡（note.items[].quantity 保持整卡次数），
  // 逐项 refundAmount 等比缩到 200。
  const res = await refundsMod.createRefund({
    refSaleOrderId: ORDER_ID,
    items: [{ saleItemId: ITEM_ID, refundQuantity: SESSION_COUNT }],
    refundReason: 'e2e 整卡全退截断到净已收',
    // 关掉超额权益扣减，避免本测试受会员降级估算干扰，专注 cap 截断口径
    applyOverdraftDeduction: false,
  })
  console.log(`  整卡全退截断(整卡值1000 > 净已收200): ${JSON.stringify(res)}`)
  if (!res.success) {
    errors.push(`[截断] 部分支付疗程卡整卡退应成功（截断到净已收 200），实际 ${JSON.stringify(res.error)}`)
  } else {
    if (Number(res.data.finalRefundAmount) !== 200) {
      errors.push(`[截断] finalRefundAmount 应=200（截断到净已收）, 实际=${res.data.finalRefundAmount}`)
    }
    const after = await q(
      `SELECT amount::numeric AS amt, status, note FROM sale_order_payments WHERE sale_order_id = $1 AND change_type = '退款' ORDER BY id DESC LIMIT 1`,
      [ORDER_ID],
    )
    const row = after.rows[0]
    if (!row) {
      errors.push(`[截断] 应写 1 条退款流水`)
    } else {
      if (row.status !== '待审批') errors.push(`[截断] 退款流水 status 应=待审批, 实际=${row.status}`)
      if (Number(row.amt) !== -200) errors.push(`[截断] 退款流水 amount 应=-200（截断到净已收）, 实际=${row.amt}`)
      // 验证「作废整卡」：note.items[0].quantity = 整卡次数（数量不截），refundAmount 缩到 200（金额截断）
      try {
        const note = JSON.parse(row.note || '{}')
        const it = (note.items || [])[0]
        if (!it || Number(it.quantity) !== SESSION_COUNT) {
          errors.push(`[截断] note 应作废整卡 quantity=${SESSION_COUNT}, 实际=${it?.quantity}`)
        }
        if (it && Number(it.refundAmount) !== 200) {
          errors.push(`[截断] note item refundAmount 应缩到 200, 实际=${it.refundAmount}`)
        }
      } catch (e) {
        errors.push(`[截断] note 解析失败: ${e.message}`)
      }
      if (!errors.length) {
        console.log(`  ✓ 整卡全退截断到净已收 200、作废整卡(${SESSION_COUNT}次)、流水 -200 待审批`)
      }
    }
  }

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — 部分支付疗程卡整卡全退：退款额截断到净已收、作废整卡`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-refund-cap] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await q(`DELETE FROM operation_logs WHERE target_id LIKE $1`, [`${NS}_REFCAP%`]).catch(() => {})
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [`${NS}_REFCAP%`]).catch(() => {})
    await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [`${NS}_REFCAP%`]).catch(() => {})
    await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [`${NS}_REFCAP%`]).catch(() => {})
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-refund-cap] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-refund-cap] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
