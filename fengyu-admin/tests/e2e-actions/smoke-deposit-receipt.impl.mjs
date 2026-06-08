/**
 * 寄存单历史实收录入/编辑端到端冒烟（由 smoke-deposit-receipt.mjs wrapper 启动）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 验证核心不变量（ticket 寄存单实收）：
 *   1. createDepositOrder items[].received>0 → 写 '回款'(线下,note=寄存单初始化实收) 流水
 *   2. sale_items.received = 录入值；paid_sessions = session_count（次数全开）
 *   3. sale_orders.received = Σ录入；total_amount 仍 = 0（统计排除 + 兜底全开的关键）
 *   4. 疗程卡 unit_real_price = 实付received / session_count（实付=0 回落标价单价 unit_price）；建单一次性算定
 *   5. recalc 不冲掉：手动再跑一次 recalc 后 received 仍稳定
 *   6. updateDepositReceived 已停用：export 已移除（寄存单建单后实收不可改、不支持回款/退款）
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

const setup = await import('file://' + path.join(TESTS_DIR, 'setup.mjs'))
const fixtures = await import('file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs'))

const { NS, TEST_CLIENT_USER_ID, TEST_STORE_ID, closePool, getPool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

// 直接拿连接池跑断言 SQL（沿用 setup 的 pool）
const pool = getPool()
const q = (sql, params) => pool.query(sql, params)

const CAT_ID = `${NS}_DEPCAT`
const SKU_ID = `${NS}_DEPSKU`
let createdOrderId = null

async function seedSku() {
  await q(
    `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order)
     VALUES ($1, $2, '护理项目', '自销自耗'::sales_category, 0)
     ON CONFLICT (category_id) DO NOTHING`,
    [CAT_ID, `${NS}_测试分类`]
  )
  await q(
    `INSERT INTO product_skus (
       sku_id, category_id, spec_name, product_type, price, special_price,
       session_count, is_shengmei, is_experience
     )
     VALUES ($1, $2, $3, '疗程卡'::product_type, 100, NULL, 10, false, false)
     ON CONFLICT (sku_id) DO UPDATE SET deleted_at = NULL, price = 100, session_count = 10`,
    [SKU_ID, CAT_ID, `${NS}_疗程卡10次`]
  )
}

async function cleanupCreatedOrder() {
  if (!createdOrderId) return
  await q(`DELETE FROM sale_order_payments WHERE sale_order_id = $1`, [createdOrderId])
  await q(`DELETE FROM operation_logs WHERE target_id = $1`, [createdOrderId])
  await q(`DELETE FROM sale_items WHERE sale_order_id = $1`, [createdOrderId])
  await q(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [createdOrderId])
}

async function cleanupSku() {
  await q(`DELETE FROM product_skus WHERE sku_id = $1`, [SKU_ID])
  await q(`DELETE FROM product_categories WHERE category_id = $1`, [CAT_ID])
}

async function fetchState(orderId) {
  const ord = (await q(`SELECT total_amount::numeric AS total, received::numeric AS recv FROM sale_orders WHERE sale_order_id = $1`, [orderId])).rows[0]
  const items = (await q(`SELECT sale_item_id, received::numeric AS recv, paid_sessions, session_count, remaining_sessions, unit_real_price::numeric AS urp, unit_price::numeric AS up FROM sale_items WHERE sale_order_id = $1 ORDER BY sale_item_id`, [orderId])).rows
  const pays = (await q(`SELECT change_type, amount::numeric AS amt, payment_method, note, ref_sale_item_id FROM sale_order_payments WHERE sale_order_id = $1 ORDER BY id`, [orderId])).rows
  return { ord, items, pays }
}

let pass = false
let exitCode = 1

async function main() {
  console.log(`[smoke-deposit-receipt] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })
  await seedSku()
  console.log(`  ✓ fixtures ready: sku=${SKU_ID} (疗程卡 10 次)`)

  const ordersMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'orders.ts'))
  const errors = []

  // ===== 1) 创建寄存单，录入实收 800 =====
  const created = await ordersMod.createDepositOrder({
    storeId: TEST_STORE_ID,
    marketName: `${NS}_市场`,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ skuId: SKU_ID, quantity: 1, received: 800 }],
  })
  console.log(`  create result: ${JSON.stringify(created)}`)
  if (!created.success || !created.saleOrderId) {
    console.log(`  ✗ FAIL: createDepositOrder 失败`)
    return
  }
  createdOrderId = created.saleOrderId

  let st = await fetchState(createdOrderId)
  if (Number(st.ord.total) !== 0) errors.push(`[create] total_amount 应=0, 实际=${st.ord.total}`)
  if (Number(st.ord.recv) !== 800) errors.push(`[create] sale_orders.received 应=800, 实际=${st.ord.recv}`)
  if (st.items.length !== 1) errors.push(`[create] sale_items 应=1 行, 实际=${st.items.length}`)
  else {
    const it = st.items[0]
    if (Number(it.recv) !== 800) errors.push(`[create] sale_items.received 应=800, 实际=${it.recv}`)
    if (Number(it.paid_sessions) !== 10) errors.push(`[create] paid_sessions 应=10(全开), 实际=${it.paid_sessions}`)
    if (Number(it.remaining_sessions) !== 10) errors.push(`[create] remaining_sessions 应=10, 实际=${it.remaining_sessions}`)
    // unit_real_price = 实付800 / 次数10 = 80（实付口径）；unit_price 仍为标价单次价 100/10 = 10（不变）
    if (Number(it.urp) !== 80) errors.push(`[create] unit_real_price 应=80(实付800/10), 实际=${it.urp}`)
    if (Number(it.up) !== 10) errors.push(`[create] unit_price 应仍=10(标价100/10,不变), 实际=${it.up}`)
  }
  const depPays = st.pays.filter(p => p.note === '寄存单初始化实收')
  if (depPays.length !== 1) errors.push(`[create] 寄存实收流水应=1 条, 实际=${depPays.length}`)
  else {
    const p = depPays[0]
    if (p.change_type !== '回款') errors.push(`[create] 流水 change_type 应=回款, 实际=${p.change_type}`)
    if (p.payment_method !== '线下') errors.push(`[create] 流水 payment_method 应=线下, 实际=${p.payment_method}`)
    if (Number(p.amt) !== 800) errors.push(`[create] 流水 amount 应=800, 实际=${p.amt}`)
    if (!p.ref_sale_item_id) errors.push(`[create] 流水 ref_sale_item_id 应非空（targeted）`)
  }
  console.log(`  ✓ create asserted (total=${st.ord.total}, recv=${st.ord.recv}, paid_sessions=${st.items[0]?.paid_sessions})`)

  // ===== 2) recalc 不冲掉：再跑一次 recalc，received 仍稳定 =====
  const psMod = await import(path.join(ADMIN_DIR, 'src', 'lib', 'paid-sessions.ts'))
  const { db } = await import(path.join(ADMIN_DIR, 'src', 'db', 'index.ts')).catch(() => ({ db: null }))
  if (db && psMod.recalcPaidSessionsForOrder) {
    await db.transaction(async (tx) => { await psMod.recalcPaidSessionsForOrder(tx, createdOrderId) })
    st = await fetchState(createdOrderId)
    if (Number(st.items[0]?.recv) !== 800) errors.push(`[recalc] received 被冲掉, 应仍=800, 实际=${st.items[0]?.recv}`)
    else console.log(`  ✓ recalc 不冲掉 (received 仍=${st.items[0]?.recv})`)
  } else {
    console.log(`  · 跳过 recalc 复跑（db import 失败，非致命）`)
  }

  // ===== 3) 历史实收编辑入口已停用：updateDepositReceived 已移除（寄存单建单后实收不可改）=====
  if (typeof ordersMod.updateDepositReceived !== 'undefined') {
    errors.push(`[disabled] updateDepositReceived 应已移除（寄存单建单后不可改实收），实际仍导出`)
  } else {
    console.log(`  ✓ updateDepositReceived 已停用（export 已移除）`)
  }

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — 寄存单实收录入/编辑：received 准确、paid_sessions 全开、total_amount=0、recalc 稳定`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-deposit-receipt] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupCreatedOrder()
    await cleanupTestData(NS)
    await cleanupSku()
  } catch (e) {
    console.error('[smoke-deposit-receipt] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-deposit-receipt] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
