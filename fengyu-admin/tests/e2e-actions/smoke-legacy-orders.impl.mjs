/**
 * smoke-legacy-orders 实现（由 smoke-legacy-orders.mjs wrapper 启动）。
 *
 * 必须由 `bun --preload _legacy-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 覆盖（全部连真 PG，验证 postgres.js driver 行为）：
 *   1. importWorkfineOrdersByCustomer：insertedCount=1（Bug B：.count 修复，原 .rowCount 恒 0）
 *   2. approveLegacyOrder：success + status='已支付'（Bug A：CAS 字符串参数，原 Date 致时区偏移 CONFLICT）
 *   3. approveLegacyOrder 重复提交（旧 updatedAt）：抛 CONFLICT（CAS 守卫命中 0 行）
 *   4. rejectLegacyOrder：success + status='已作废'（Bug B：.count 修复，原 .rowCount 恒 CONFLICT）
 *   5. updateLegacyOrderAmount：success + total_amount 更新 + original_amount 留底（Bug B + CAS）
 *   6. updateLegacyOrderPhone：success + client_phone/匹配更新（Bug B + CAS）
 */
import path from 'node:path'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

process.env.ALLOW_TEST_OPENID = 'true'
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING

const setupUrl = 'file://' + path.join(TESTS_DIR, 'setup.mjs')
const fixturesUrl = 'file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs')

const setup = await import(setupUrl)
const fixtures = await import(fixturesUrl)

const {
  NS, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, TEST_MANAGER_EMP_ID,
  TEST_STORE_ID, pgQuery, getPool, closePool,
} = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

process.env.TEST_STORE_ID = TEST_STORE_ID
process.env.TEST_ADMIN_EMP_ID = TEST_MANAGER_EMP_ID

const WF_CUSTOMER_ID = `${NS}_WFCUST`
const WF_STORE_NAME = `${NS}_WF门店`
const LEG1 = `${NS}_LEG1` // import → approve → CONFLICT
const LEG2 = `${NS}_LEG2` // reject
const LEG3 = `${NS}_LEG3` // updateAmount
const LEG4 = `${NS}_LEG4` // updatePhone

let pass = false
let exitCode = 1
const errors = []
function check(cond, msg) {
  if (!cond) errors.push(msg)
}

/** 直接 INSERT 一条未审核 legacy 单（绕过 WorkFine 拉取，用于 reject/改金额/改手机号） */
async function insertLegacyOrder({ id, amount, clientUserId, clientPhone }) {
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, payable_amount, received, payment_method,
       legacy_source, legacy_customer_id, legacy_raw_snapshot
     ) VALUES (
       $1, '未审核'::order_status, '销售单'::sale_order_type, $2, $3,
       '2022-12-22 08:00:00'::timestamp, $4, $5, $6,
       $7::numeric, $7::numeric, 0, '无'::payment_method,
       'workfine', $8, $9::jsonb
     )`,
    [
      id, `${NS}_市场`, TEST_STORE_ID,
      clientUserId, clientPhone, `${NS}_顾客`,
      amount, WF_CUSTOMER_ID,
      JSON.stringify({ legacy_order_no: id, store_name: WF_STORE_NAME, amount }),
    ],
  )
}

/**
 * 取某单前端可见的 updatedAt（必须经 listLegacyOrders / postgres.js 同 driver 产出，
 * 才能与 approve 的 CAS 字符串参数对齐 —— 真实链路就是 list→approve 同 driver）。
 * 直接用 pg 包另读会因 node-postgres 与 postgres.js 对无时区 timestamp 解析不同而错位。
 */
let _mod = null
async function getRowIso(id) {
  const { data } = await _mod.listLegacyOrders({ storeId: TEST_STORE_ID, pageSize: 100 })
  const row = data.find((r) => r.saleOrderId === id)
  if (!row) throw new Error(`listLegacyOrders 未找到未审核单 ${id}`)
  return row.updatedAt
}
async function getStatus(id) {
  const rows = await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [id])
  return rows[0]?.status ?? null
}

async function main() {
  console.log(`[smoke-legacy-orders] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  console.log(`  ✓ fixtures ready: store=${TEST_STORE_ID} client=${TEST_CLIENT_USER_ID}`)

  const mod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'legacy-orders.ts'))
  _mod = mod

  // ── 1) import：Bug B（.count）——原 .rowCount 致 insertedCount 恒 0 ──
  globalThis.__WF_ORDERS = [
    {
      legacyOrderNo: LEG1,
      phone: TEST_CLIENT_PHONE,
      storeName: WF_STORE_NAME,
      marketName: `${NS}_市场`,
      amount: 1280,
      saleDate: '2022-12-22 08:00:00',
      legacyCustomerId: WF_CUSTOMER_ID,
      customerName: `${NS}_顾客`,
    },
  ]
  const imp = await mod.importWorkfineOrdersByCustomer({
    workfineCustomerId: WF_CUSTOMER_ID,
    selectedOrderNos: [LEG1],
    storeMapping: { [WF_STORE_NAME]: TEST_STORE_ID },
  })
  console.log(`  [1] import: ${JSON.stringify(imp)}`)
  check(imp.insertedCount === 1, `import insertedCount 应=1, 实际=${imp.insertedCount}`)
  check((await getStatus(LEG1)) === '未审核', `LEG1 import 后 status 应='未审核'`)
  const leg1Store = (await pgQuery(`SELECT store_id, client_user_id FROM sale_orders WHERE sale_order_id=$1`, [LEG1]))[0]
  check(leg1Store?.store_id === TEST_STORE_ID, `LEG1 store_id 应=${TEST_STORE_ID}, 实际=${leg1Store?.store_id}`)
  check(leg1Store?.client_user_id === TEST_CLIENT_USER_ID, `LEG1 client_user_id 应按 phone 匹配到 ${TEST_CLIENT_USER_ID}`)

  // ── 2) approve：Bug A（CAS 字符串参数）——原 Date 致时区偏移、CONFLICT ──
  const leg1Iso = await getRowIso(LEG1)
  const appr = await mod.approveLegacyOrder(LEG1, leg1Iso)
  console.log(`  [2] approve: ${JSON.stringify(appr)}`)
  check(appr.success === true, `approve success 应=true`)
  check((await getStatus(LEG1)) === '已支付', `LEG1 approve 后 status 应='已支付', 实际='${await getStatus(LEG1)}'`)

  // ── 3) approve 重复提交（旧 updatedAt）：CAS 守卫命中 0 行 → CONFLICT ──
  let conflictThrown = false
  try {
    await mod.approveLegacyOrder(LEG1, leg1Iso)
  } catch (e) {
    conflictThrown = /CONFLICT/.test(e?.message || e?.digest || '')
  }
  console.log(`  [3] approve 重复 → CONFLICT? ${conflictThrown}`)
  check(conflictThrown, `approve 重复提交应抛 CONFLICT（CAS 守卫）`)

  // ── 4) reject：Bug B（.count）——原 .rowCount 致永久 CONFLICT ──
  await insertLegacyOrder({ id: LEG2, amount: 500, clientUserId: TEST_CLIENT_USER_ID, clientPhone: TEST_CLIENT_PHONE })
  const rej = await mod.rejectLegacyOrder(LEG2, await getRowIso(LEG2))
  console.log(`  [4] reject: ${JSON.stringify(rej)}`)
  check(rej.success === true, `reject success 应=true`)
  check((await getStatus(LEG2)) === '已作废', `LEG2 reject 后 status 应='已作废', 实际='${await getStatus(LEG2)}'`)

  // ── 5) updateAmount：Bug B + CAS ──
  await insertLegacyOrder({ id: LEG3, amount: 1000, clientUserId: TEST_CLIENT_USER_ID, clientPhone: TEST_CLIENT_PHONE })
  const amt = await mod.updateLegacyOrderAmount(LEG3, 888, await getRowIso(LEG3))
  console.log(`  [5] updateAmount: ${JSON.stringify(amt)}`)
  check(amt.success === true, `updateAmount success 应=true`)
  const leg3 = (await pgQuery(`SELECT total_amount, legacy_raw_snapshot->>'original_amount' AS orig FROM sale_orders WHERE sale_order_id=$1`, [LEG3]))[0]
  check(Number(leg3?.total_amount) === 888, `LEG3 total_amount 应=888, 实际=${leg3?.total_amount}`)
  check(Number(leg3?.orig) === 1000, `LEG3 original_amount 应留底=1000, 实际=${leg3?.orig}`)

  // ── 6) updatePhone：Bug B + CAS（新号匹配测试顾客 → 回填 client_user_id） ──
  await insertLegacyOrder({ id: LEG4, amount: 600, clientUserId: null, clientPhone: '13900000000' })
  const ph = await mod.updateLegacyOrderPhone(LEG4, TEST_CLIENT_PHONE, await getRowIso(LEG4))
  console.log(`  [6] updatePhone: ${JSON.stringify(ph)}`)
  check(ph.success === true, `updatePhone success 应=true`)
  check(ph.matchedUserId === TEST_CLIENT_USER_ID, `updatePhone 应匹配到 ${TEST_CLIENT_USER_ID}, 实际=${ph.matchedUserId}`)
  const leg4 = (await pgQuery(`SELECT client_phone, client_user_id FROM sale_orders WHERE sale_order_id=$1`, [LEG4]))[0]
  check(leg4?.client_phone === TEST_CLIENT_PHONE, `LEG4 client_phone 应=${TEST_CLIENT_PHONE}, 实际=${leg4?.client_phone}`)

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — legacy-orders import/approve/reject/改金额/改手机号 全链路 + CONFLICT 守卫正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-legacy-orders] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-legacy-orders] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-legacy-orders] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
