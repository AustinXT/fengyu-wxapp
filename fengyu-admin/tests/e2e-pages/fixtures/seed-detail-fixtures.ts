/**
 * e2e-pages 详情页夹具工厂（Playwright globalSetup 调用）。
 *
 * 在 TE2A_ 命名空间下产出两条详情用例所需夹具，并把 id 写入临时文件供 spec 读取：
 *   - 有欠款订单（received < payable，status='部分支付'）→ 触发 orders 详情页「录入回款」按钮
 *   - 待审批退款单（sale_order_payments change_type='退款' status='待审批'）→ refunds 详情页审批按钮
 *
 * 复用 e2e-actions/helpers/fixtures.mjs 的组织/门店/员工/顾客建夹具逻辑（同一 5433 库、同 NS）。
 * 登录态使用 admin（FY-TEST-ADM，无 scope 限制），故 TE2A_ 测试门店订单对其可见。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'

// Playwright 以 cwd=fengyu-admin/ 运行；不依赖 import.meta.url（Playwright 把本模块
// 转译成 CJS 后 import.meta 会触发 "exports is not defined in ES module scope"）。
const ADMIN_DIR = process.cwd()
const TESTS_DIR = path.join(ADMIN_DIR, 'tests')
const FIXTURES_MJS = pathToFileURL(
  path.join(TESTS_DIR, 'e2e-actions', 'helpers', 'fixtures.mjs'),
).href
const SETUP_MJS = pathToFileURL(path.join(TESTS_DIR, 'e2e-actions', 'setup.mjs')).href

/** globalSetup 把 id 写到此文件；spec 在 module-load 期读取。 */
export const DETAIL_FIXTURES_FILE = path.join(
  ADMIN_DIR,
  '.e2e-detail-fixtures.json',
)

const NS = 'TE2A'
const DEBT_ORDER_ID = `${NS}_PGDEBT` // 有欠款订单（部分支付）
const REFUND_ORDER_ID = `${NS}_PGRFD` // 待审批退款单的原单

function connString(): string {
  return (
    process.env.E2E_DATABASE_URL ||
    process.env.PG_CONNECTION_STRING ||
    process.env.DATABASE_URL ||
    'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
  )
}

export interface DetailFixtureIds {
  orderIdWithDebt: string
  refundId: string
}

/**
 * 创建两条详情夹具，返回 id 并写临时文件。
 * 幂等：每次先 cleanup 自己的命名空间再重建。
 */
export async function seedDetailFixtures(): Promise<DetailFixtureIds> {
  // 注入连接串后再 import fixtures.mjs（setup.mjs 在 module-load 期读取）
  const conn = connString()
  process.env.PG_CONNECTION_STRING = conn
  process.env.DATABASE_URL = conn

  const setup: any = await import(SETUP_MJS)
  const fixtures: any = await import(FIXTURES_MJS)
  const { TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, TEST_MANAGER_EMP_ID, TEST_STORE_ID } = setup
  const { cleanupTestData, ensureTestStore, createTestStaff, createTestClient } = fixtures

  // 先清自己命名空间，保证幂等
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({ pointsBalance: 0 })

  const pool = new Pool({ connectionString: conn, max: 2 })
  let refundId: string
  try {
    // ── 1) 有欠款订单（部分支付，received=200 < payable=1000）──────────────
    {
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
                   1000, 0, 1000, 200,
                   '线下'::payment_method, $7, '待分配'::allocation_status, NOW())
           ON CONFLICT (sale_order_id) DO NOTHING`,
          [DEBT_ORDER_ID, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`, TEST_MANAGER_EMP_ID],
        )
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
                   10, 10,
                   100, 1, 100, 1000, 200,
                   false)
           ON CONFLICT (sale_item_id) DO NOTHING`,
          [`${DEBT_ORDER_ID}_I1`, DEBT_ORDER_ID, TEST_STORE_ID, `${NS}_疗程卡`],
        )
        await client.query(
          `INSERT INTO sale_order_payments (
             sale_order_id, change_type, payment_method, amount, status,
             paid_at, source_end, operator_employee_id, note, created_at
           ) VALUES ($1, '首次支付', '线下', 200::numeric, '已支付',
                     NOW(), 'admin', $2, '部分支付定金', NOW())`,
          [DEBT_ORDER_ID, TEST_MANAGER_EMP_ID],
        )
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    }

    // ── 2) 待审批退款单（原单已支付 + 一条 change_type='退款' status='待审批'）──
    {
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
                   500, 0, 500, 500,
                   '线下'::payment_method, $7, '待分配'::allocation_status, NOW())
           ON CONFLICT (sale_order_id) DO NOTHING`,
          [REFUND_ORDER_ID, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`, TEST_MANAGER_EMP_ID],
        )
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
                   5, 5,
                   100, 1, 100, 500, 500,
                   false)
           ON CONFLICT (sale_item_id) DO NOTHING`,
          [`${REFUND_ORDER_ID}_I1`, REFUND_ORDER_ID, TEST_STORE_ID, `${NS}_疗程卡`],
        )
        await client.query(
          `INSERT INTO sale_order_payments (
             sale_order_id, change_type, payment_method, amount, status,
             source_end, operator_employee_id, note, refund_reason,
             ref_sale_item_id, session_count, created_at
           ) VALUES ($1, '首次支付', '线下', 500::numeric, '已支付',
                     'admin', $2, '原单已支付', NULL, NULL, NULL, NOW())`,
          [REFUND_ORDER_ID, TEST_MANAGER_EMP_ID],
        )
        const refRows = await client.query(
          `INSERT INTO sale_order_payments (
             sale_order_id, change_type, payment_method, amount, status,
             source_end, operator_employee_id, note, refund_reason,
             ref_sale_item_id, session_count, created_at
           ) VALUES ($1, '退款', '线下', (-200)::numeric, '待审批',
                     'admin', $2, 'reason=e2e 详情夹具', 'e2e 详情夹具', $3, 2, NOW())
           RETURNING id`,
          [REFUND_ORDER_ID, TEST_MANAGER_EMP_ID, `${REFUND_ORDER_ID}_I1`],
        )
        refundId = String(refRows.rows[0].id)
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    }
  } finally {
    await pool.end()
  }

  const ids: DetailFixtureIds = {
    orderIdWithDebt: DEBT_ORDER_ID,
    refundId: refundId!,
  }

  await fsp.writeFile(DETAIL_FIXTURES_FILE, JSON.stringify(ids, null, 2), 'utf8')
  return ids
}

/** 清理详情夹具（globalTeardown 调用）。 */
export async function cleanupDetailFixtures(): Promise<void> {
  const conn = connString()
  process.env.PG_CONNECTION_STRING = conn
  process.env.DATABASE_URL = conn

  const pool = new Pool({ connectionString: conn, max: 2 })
  try {
    for (const id of [DEBT_ORDER_ID, REFUND_ORDER_ID]) {
      await pool.query(`DELETE FROM operation_logs WHERE target_id LIKE $1`, [`${id}%`]).catch(() => {})
      await pool.query(`DELETE FROM sale_order_payments WHERE sale_order_id = $1`, [id]).catch(() => {})
      await pool.query(`DELETE FROM sale_items WHERE sale_order_id = $1`, [id]).catch(() => {})
      await pool.query(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [id]).catch(() => {})
    }
  } finally {
    await pool.end()
  }

  const fixtures: any = await import(FIXTURES_MJS)
  await fixtures.cleanupTestData(NS).catch(() => {})

  await fsp.rm(DETAIL_FIXTURES_FILE, { force: true }).catch(() => {})
}

/** spec module-load 期读 id：优先环境变量（手动 seed），否则读临时文件。 */
export function readDetailFixtureIds(): Partial<DetailFixtureIds> {
  const fromEnv: Partial<DetailFixtureIds> = {}
  if (process.env.E2E_ORDER_ID_WITH_DEBT) fromEnv.orderIdWithDebt = process.env.E2E_ORDER_ID_WITH_DEBT
  if (process.env.E2E_REFUND_ID) fromEnv.refundId = process.env.E2E_REFUND_ID
  if (fromEnv.orderIdWithDebt && fromEnv.refundId) return fromEnv

  try {
    // 同步读，避免 spec top-level await
    if (fs.existsSync(DETAIL_FIXTURES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DETAIL_FIXTURES_FILE, 'utf8')) as DetailFixtureIds
      return { ...parsed, ...fromEnv }
    }
  } catch {
    /* ignore — 退回 env-only */
  }
  return fromEnv
}
