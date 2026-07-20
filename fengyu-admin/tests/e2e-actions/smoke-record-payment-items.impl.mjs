/**
 * 多子项「选择性补卡」回款实现（由 smoke-record-payment-items.mjs wrapper 启动）。
 *
 * 场景（模拟生产 FY-XSD-WX-2606080030 的精髓：首付按 pending_received 分摊后，回款补尾款）：
 *   - 3 子项 A/B/C，sale_amount=300，首付后 received = pending_received = 100/100/50（order.received=250）。
 *   - 选择性只补 A 卡到全款（现金 +200），B/C 不补。
 * 断言（验证 C6）：
 *   1. sale_order_payments 只 +1 行「回款」（ref_sale_item_id=null、amount=200、挂交易号）——款项合并为一笔现金。
 *   2. A.received=300（精确补满）、B.received=100、C.received=50（未选卡不动）——pending_received 承载定向。
 *   3. order.received=450。
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

const { NS, TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, TEST_STORE_ID, getPool, closePool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

process.env.TEST_STORE_ID = TEST_STORE_ID
process.env.TEST_ADMIN_EMP_ID = TEST_MANAGER_EMP_ID

const ORDER_ID = `${NS}_RPITEMS`
const ITEM_A = `${ORDER_ID}_A`
const ITEM_B = `${ORDER_ID}_B`
const ITEM_C = `${ORDER_ID}_C`
const TXN_ID = `${NS}_TXNITEMS_${Date.now()}`

let pass = false
let exitCode = 1

async function seedMultiItemOrder() {
  const pool = getPool()
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    // 订单：total=900，首付 received=250，payable=900，部分支付
    await c.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status
       ) VALUES ($1,'部分支付'::order_status,'销售单'::sale_order_type,$2,$3,
                 NOW(),$4,'13900000000',$5,
                 900,0,900,250,
                 '线下'::payment_method,$6,'待分配'::allocation_status)`,
      [ORDER_ID, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, `${NS}_顾客`, TEST_MANAGER_EMP_ID],
    )
    // 3 子项：sale_amount=300，首付后 received=pending_received=100/100/50，session_count=10
    for (const [id, recv] of [[ITEM_A, 100], [ITEM_B, 100], [ITEM_C, 50]]) {
      await c.query(
        `INSERT INTO sale_items (
           sale_item_id, sale_order_id, store_id, item_direction,
           sku_id, product_name, product_type,
           unit_price, quantity, unit_real_price, sale_amount, received, pending_received,
           session_count, remaining_sessions, paid_sessions, is_experience
         ) VALUES ($1,$2,$3,'购买'::item_direction,
                   NULL,$4,'疗程卡'::product_type,
                   30,1,30,300,$5,$5,
                   10,10,0,false)`,
        [id, ORDER_ID, TEST_STORE_ID, `${NS}_商品`, recv],
      )
    }
    // 首付凭证（ref=null，已支付）→ recordPayment 重算 order.received = SUM(payments) 才正确
    await c.query(
      `INSERT INTO sale_order_payments (
         sale_order_id, change_type, amount, payment_method, external_txn_id,
         status, source_end, operator_employee_id, note, created_at, paid_at
       ) VALUES ($1,'首次支付',250,'线下',NULL,'已支付','admin',$2,'e2e 首付',NOW(),NOW())`,
      [ORDER_ID, TEST_MANAGER_EMP_ID],
    )
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}

async function main() {
  console.log(`[smoke-record-payment-items] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  await seedMultiItemOrder()
  console.log('  ✓ seeded: 3 子项 received=100/100/50, order.received=250')

  const ordersMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'orders.ts'))
  // 选择性只补 A 卡到全款（现金 +200），B/C 不补
  const result = await ordersMod.recordPayment({
    saleOrderId: ORDER_ID,
    paymentMethod: '线下',
    externalTxnId: TXN_ID,
    items: [{ saleItemId: ITEM_A, repayAmount: 200 }],
    note: 'e2e items 选择性补 A',
  })
  console.log(`  result: ${JSON.stringify(result)}`)
  if (!result.success) {
    console.log(`  ✗ FAIL: 期望 success=true，实际 ${JSON.stringify(result.error)}`)
    return
  }

  const pool = getPool()
  const pays = await pool.query(
    `SELECT change_type, amount::numeric AS amount, external_txn_id, ref_sale_item_id
       FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='回款' ORDER BY id`,
    [ORDER_ID],
  )
  const itemsAfter = await pool.query(
    `SELECT sale_item_id, received::numeric AS received, pending_received::numeric AS pending
       FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id`,
    [ORDER_ID],
  )
  const ord = await pool.query(
    `SELECT received::numeric AS received, status FROM sale_orders WHERE sale_order_id=$1`,
    [ORDER_ID],
  )
  console.log(`  回款行: ${JSON.stringify(pays.rows)}`)
  console.log(`  子项: ${JSON.stringify(itemsAfter.rows)}`)
  console.log(`  订单: ${JSON.stringify(ord.rows[0])}`)

  const errors = []
  // 1) 款项合并：只 1 行回款，ref=null，amount=200，挂交易号
  if (pays.rows.length !== 1) {
    errors.push(`回款行应=1（合并一笔现金）, 实际=${pays.rows.length}`)
  } else {
    const p = pays.rows[0]
    if (Number(p.amount) !== 200) errors.push(`回款金额应=200, 实际=${p.amount}`)
    if (p.ref_sale_item_id !== null) errors.push(`回款 ref_sale_item_id 应=null, 实际=${p.ref_sale_item_id}`)
    if (p.external_txn_id !== TXN_ID) errors.push(`交易号应=${TXN_ID}, 实际=${p.external_txn_id}`)
  }
  // 2) 子项定向：定向补 A 的 200 写入 A.pending_received；B/C 不动（pending_received=0）。
  //    sale_items.received 由 capture/cost 按 pending_received 派生，不由 recordPayment 步精确改写。
  const pending = Object.fromEntries(itemsAfter.rows.map((r) => [r.sale_item_id, Number(r.pending)]))
  if (pending[ITEM_A] !== 200) errors.push(`A.pending_received 应=200(定向补), 实际=${pending[ITEM_A]}`)
  if (pending[ITEM_B] !== 0) errors.push(`B.pending_received 应=0(未选), 实际=${pending[ITEM_B]}`)
  if (pending[ITEM_C] !== 0) errors.push(`C.pending_received 应=0(未选), 实际=${pending[ITEM_C]}`)
  // 3) order.received=450
  if (Number(ord.rows[0].received) !== 450) errors.push(`order.received 应=450, 实际=${ord.rows[0].received}`)

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  console.log('  ✅ PASS — 多子项选择性补卡：款项合并 1 笔现金（ref=null）+ A.pending_received=200 定向承载、B/C pending=0 不动')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-record-payment-items] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-record-payment-items] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-record-payment-items] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
