/**
 * 「按回款逐笔分配」真实库集成测试（capture 链路）
 *
 * 直连 5434 开发库（postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu）。
 * 全程 BEGIN ... ROLLBACK 包裹，绝不 COMMIT —— 不在库里留任何痕迹。
 *
 * 直接调用 utils/payment-allocatable 的 capturePaymentAllocatables /
 * refreshOrderAllocationRollup，传入真实 pg Client 事务句柄。
 *
 * ⚠️ 仅对 5434 开发库；绝不碰 5433 生产库。
 *
 * 运行：
 *   env -u http_proxy -u https_proxy -u all_proxy \
 *     npx vitest run __tests__/integration/payment-allocatable.int.test.js
 *
 * 注：全局 setup.js 把 ../db/pg mock 掉，但本测试用真实 `pg` 包自建 Client，
 * 且 payment-allocatable 是纯函数（只用传入的 client），不受 mock 影响。
 */
const { Client } = require('pg')
const {
  capturePaymentAllocatables,
  refreshOrderAllocationRollup,
} = require('../../utils/payment-allocatable')

const CONN = 'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu'

// 唯一后缀，避免与并发数据撞主键（虽然全程 ROLLBACK，仍取唯一值更稳）
const RUN = String(Date.now()).slice(-10)
const SALE_ORDER_ID = `IT-PA-${RUN}`
const ITEM_A = `IT-PA-A-${RUN}` // sale_amount 600
const ITEM_B = `IT-PA-B-${RUN}` // sale_amount 400

let client
let storeId = null
let employeeId = null

// 把 numeric/text 金额统一成 number 比较
const num = (v) => Math.round(Number(v) * 100) / 100

// 读取某回款主流水行落库的逐项可分配额，返回 { saleItemId: amount }
async function allocatableMap(salePaymentId) {
  const r = await client.query(
    `SELECT sale_item_id, amount::numeric AS amount, sales_category
       FROM sale_payment_allocatable_items WHERE sale_payment_id = $1`,
    [salePaymentId],
  )
  const m = {}
  for (const row of r.rows) m[row.sale_item_id] = { amount: num(row.amount), salesCategory: row.sales_category }
  return m
}

beforeAll(async () => {
  client = new Client({ connectionString: CONN })
  await client.connect()

  // 守护：必须真的连在 5434/fengyu 开发库，绝不在生产库 5433/fengyu_wxapp 上跑
  const dbRes = await client.query('SELECT current_database() AS db')
  if (dbRes.rows[0].db !== 'fengyu') {
    throw new Error(`拒绝运行：期望开发库 fengyu，实连 ${dbRes.rows[0].db}`)
  }

  await client.query('BEGIN')

  const s = await client.query('SELECT store_id FROM stores ORDER BY store_id LIMIT 1')
  storeId = s.rows[0] && s.rows[0].store_id
  if (!storeId) throw new Error('库内无 stores，无法造销售单')

  const e = await client.query('SELECT employee_id FROM staff_wechat_users ORDER BY employee_id LIMIT 1')
  employeeId = e.rows[0] ? e.rows[0].employee_id : null
})

afterAll(async () => {
  if (client) {
    try {
      await client.query('ROLLBACK') // 绝不 COMMIT，全部回滚不留痕
    } finally {
      await client.end()
    }
  }
})

describe('payment-allocatable capture 链路（real PG 5434, BEGIN...ROLLBACK）', () => {
  it('步骤1：造销售单 + 2 个 sale_item（600 / 400）', async () => {
    await client.query(
      `INSERT INTO sale_orders
         (sale_order_id, status, sale_order_type, market_name, store_id, store_name,
          sale_order_datetime, total_amount, payment_method, received)
       VALUES ($1, '待支付', '销售单', '集成测试市场', $2, '集成测试门店',
               NOW(), 1000, '线下', 0)`,
      [SALE_ORDER_ID, storeId],
    )

    const insItem = (id, amount, cat) =>
      client.query(
        `INSERT INTO sale_items
           (sale_item_id, sale_order_id, store_id, item_direction,
            unit_price, unit_real_price, sale_amount, received, quantity, sales_category)
         VALUES ($1, $2, $3, '购买', $4, $4, $4, 0, 1, $5)`,
        [id, SALE_ORDER_ID, storeId, amount, cat],
      )
    await insItem(ITEM_A, 600, '自销自耗')
    await insItem(ITEM_B, 400, '他销自耗')

    const chk = await client.query(
      `SELECT sale_item_id, sale_amount::numeric AS sale_amount
         FROM sale_items WHERE sale_order_id = $1 ORDER BY sale_item_id`,
      [SALE_ORDER_ID],
    )
    expect(chk.rows.length).toBe(2)
    const byId = Object.fromEntries(chk.rows.map((r) => [r.sale_item_id, num(r.sale_amount)]))
    expect(byId[ITEM_A]).toBe(600)
    expect(byId[ITEM_B]).toBe(400)
  })

  it('步骤2：首次支付 300（非定向）按剩余应付比例摊 A=180 / B=120，合计=300，该回款待分配', async () => {
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '首次支付', 300, '线下', '已支付', 'staff', NOW())
       RETURNING id`,
      [SALE_ORDER_ID],
    )
    const salePaymentId = Number(pay.rows[0].id)

    const out = await capturePaymentAllocatables(client, {
      salePaymentId,
      saleOrderId: SALE_ORDER_ID,
      eventAmount: 300,
      directedItems: null,
    })

    // 返回值：A=180 / B=120，含 salesCategory 快照
    const retById = Object.fromEntries(out.map((o) => [o.saleItemId, o]))
    expect(num(retById[ITEM_A].amount)).toBe(180)
    expect(num(retById[ITEM_B].amount)).toBe(120)
    expect(retById[ITEM_A].salesCategory).toBe('自销自耗')
    expect(retById[ITEM_B].salesCategory).toBe('他销自耗')

    // 落库：A=180 / B=120，合计 300
    const m = await allocatableMap(salePaymentId)
    expect(m[ITEM_A].amount).toBe(180)
    expect(m[ITEM_B].amount).toBe(120)
    expect(m[ITEM_A].amount + m[ITEM_B].amount).toBe(300)

    // 该回款主流水行 allocation_status = '待分配'
    const ps = await client.query(
      `SELECT allocation_status FROM sale_order_payments WHERE id = $1`,
      [salePaymentId],
    )
    expect(ps.rows[0].allocation_status).toBe('待分配')

    globalThis.__firstPaymentId = salePaymentId
  })

  it('步骤3：refreshOrderAllocationRollup → 订单 allocation_status = 待分配', async () => {
    await refreshOrderAllocationRollup(client, SALE_ORDER_ID)
    const o = await client.query(
      `SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`,
      [SALE_ORDER_ID],
    )
    expect(o.rows[0].allocation_status).toBe('待分配')
  })

  it('步骤4：回款 400 定向 [{A,100},{B,300}] → 逐项落库 A=100 / B=300', async () => {
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '回款', 400, '线下', '已支付', 'staff', NOW())
       RETURNING id`,
      [SALE_ORDER_ID],
    )
    const salePaymentId = Number(pay.rows[0].id)

    const out = await capturePaymentAllocatables(client, {
      salePaymentId,
      saleOrderId: SALE_ORDER_ID,
      eventAmount: 400,
      directedItems: [
        { saleItemId: ITEM_A, amount: 100 },
        { saleItemId: ITEM_B, amount: 300 },
      ],
    })
    const retById = Object.fromEntries(out.map((o) => [o.saleItemId, num(o.amount)]))
    expect(retById[ITEM_A]).toBe(100)
    expect(retById[ITEM_B]).toBe(300)

    const m = await allocatableMap(salePaymentId)
    expect(m[ITEM_A].amount).toBe(100)
    expect(m[ITEM_B].amount).toBe(300)
    expect(m[ITEM_A].amount + m[ITEM_B].amount).toBe(400)
  })

  it('步骤5：sale_allocations 唯一约束 uq_sale_alloc_item_emp_role_payment 同键活跃行 → 23505', async () => {
    if (!employeeId) {
      // 库内无员工则跳过该断言（FK employee_id 无可用值）
      console.warn('[skip] staff_wechat_users 为空，跳过唯一约束断言')
      return
    }
    const salePaymentId = globalThis.__firstPaymentId

    // 首条活跃分配（item A / emp / 美容师 / 该回款）
    await client.query(
      `INSERT INTO sale_allocations
         (sale_item_id, employee_id, allocation_ratio, role_type, total_amount, sale_payment_id, is_void)
       VALUES ($1, $2, 1.00, '美容师', 180, $3, false)`,
      [ITEM_A, employeeId, salePaymentId],
    )

    // 同 (item, emp, role, payment) 再插一条活跃行 → 唯一索引冲突 23505
    await client.query('SAVEPOINT dup_alloc')
    let dupErr = null
    try {
      await client.query(
        `INSERT INTO sale_allocations
           (sale_item_id, employee_id, allocation_ratio, role_type, total_amount, sale_payment_id, is_void)
         VALUES ($1, $2, 1.00, '美容师', 180, $3, false)`,
        [ITEM_A, employeeId, salePaymentId],
      )
    } catch (err) {
      dupErr = err
      await client.query('ROLLBACK TO SAVEPOINT dup_alloc')
    }
    expect(dupErr).not.toBeNull()
    expect(dupErr.code).toBe('23505')
    expect(String(dupErr.constraint || dupErr.message)).toContain('uq_sale_alloc_item_emp_role_payment')
  })
})
