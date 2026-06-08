/**
 * 真正的 smoke-cards-listing-filter 实现（由 wrapper 启动）。
 *
 * 必须由 `bun --preload _admin-preload.mjs` 在 cwd=fengyu-admin/ 下运行。
 *
 * 断言（基础过滤口径，admin 视角无 scope）：
 *   [A] 疗程卡   + 购买 + remaining=10  → 出现在 /cards
 *   [B] 家居产品 + 购买 + remaining=10  → 不出现（productType 过滤）
 *   [C] 疗程卡 + 转出 + remaining=10  → 不出现（itemDirection 过滤）
 *   [D] 疗程卡 + 购买 + remaining=NULL → 不出现（isNotNull 过滤）
 *   [E] 疗程卡 + 购买 + remaining=0   → 出现（基础过滤含已耗尽；状态筛选才区分）
 *
 * scope 过滤本测试不覆盖（admin preload 把 scopeCondition mock 成 undefined）；
 * scope 行为由 src/lib/permissions.ts 的 vitest 单测覆盖。
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

const { NS, TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, pgQuery, getPool, closePool } = setup
const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

process.env.TEST_STORE_ID = TEST_STORE_ID
process.env.TEST_ADMIN_EMP_ID = TEST_MANAGER_EMP_ID

const ORDER_ID = `${NS}_CARDS` // 短前缀；sale_order_id 最多 30 字符
const CASES = [
  { suffix: 'A', productType: '疗程卡', itemDirection: '购买', remaining: 10, expectVisible: true },
  { suffix: 'B', productType: '家居产品', itemDirection: '购买', remaining: 10, expectVisible: false },
  { suffix: 'C', productType: '疗程卡', itemDirection: '转出', remaining: 10, expectVisible: false },
  { suffix: 'D', productType: '疗程卡', itemDirection: '购买', remaining: null, expectVisible: false },
  { suffix: 'E', productType: '疗程卡', itemDirection: '购买', remaining: 0,  expectVisible: true },
]

let pass = false
let exitCode = 1

async function seedSaleOrder() {
  const pool = getPool()
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
       VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, $5, $6,
               1000, 0, 1000, 1000,
               '线下'::payment_method, $7, '待分配'::allocation_status, NOW())
       ON CONFLICT (sale_order_id) DO NOTHING`,
      [ORDER_ID, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`, TEST_MANAGER_EMP_ID]
    )

    for (const c of CASES) {
      const itemId = `${ORDER_ID}_${c.suffix}` // <30 chars
      await client.query(
        `INSERT INTO sale_items (
           sale_item_id, sale_order_id, store_id, item_direction,
           sku_id, product_name, product_type,
           session_count, remaining_sessions,
           unit_price, quantity, unit_real_price, sale_amount, received,
           is_experience
         )
         VALUES ($1, $2, $3, $4::item_direction,
                 NULL, $5, $6::product_type,
                 $7, $8,
                 100, 1, 100, 100, 100,
                 false)`,
        [itemId, ORDER_ID, TEST_STORE_ID, c.itemDirection, `${NS}_测试卡_${c.suffix}`, c.productType, 10, c.remaining]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function main() {
  console.log(`[smoke-cards-listing-filter] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({})
  await seedSaleOrder()
  console.log(`  ✓ fixtures ready: order=${ORDER_ID} + 5 sale_items (A..E)`)

  const cardsMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'cards.ts'))

  // 用 search=测试卡 锁定本 fixture 命中的子集（避开生产数据噪音），search ILIKE 命中 client name
  // 但本 fixture 顾客名是 `${NS}_顾客`，不含「测试卡」字样。
  // 改用 storeId 精确过滤本测试门店。
  const res = await cardsMod.getCardsPaginated({ storeId: TEST_STORE_ID, pageSize: 50 })

  console.log(`  result: total=${res.total} dataLen=${res.data.length}`)
  const itemIds = new Set(res.data.map((r) => r.saleItemId))
  console.log(`  returned saleItemIds: ${[...itemIds].join(', ')}`)

  const errors = []
  for (const c of CASES) {
    const itemId = `${ORDER_ID}_${c.suffix}`
    const seen = itemIds.has(itemId)
    if (seen !== c.expectVisible) {
      errors.push(
        `[${c.suffix}] productType=${c.productType} direction=${c.itemDirection} remaining=${c.remaining} → ` +
        `expectVisible=${c.expectVisible} actual=${seen}`,
      )
    } else {
      console.log(`  ✓ [${c.suffix}] ${seen ? '可见' : '不可见'} — 符合预期`)
    }
  }

  if (errors.length) {
    console.log(`  ✗ FAIL: ${errors.length} 项口径偏离`)
    for (const e of errors) console.log(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — getCardsPaginated 基础过滤口径锁定（5 case 全过）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-cards-listing-filter] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-cards-listing-filter] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-cards-listing-filter] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
