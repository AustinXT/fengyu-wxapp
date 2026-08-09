/**
 * 「按回款逐笔分配」真实库集成测试（capture 链路）
 *
 * 默认直连测试库（postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp）。
 * 可通过 PAYMENT_ALLOCATABLE_INT_DATABASE_URL 覆盖到临时 PG 做迁移验证。
 * 全程 BEGIN ... ROLLBACK 包裹，绝不 COMMIT —— 不在库里留任何痕迹。
 *
 * 直接调用 utils/payment-allocatable 的 capturePaymentAllocatables /
 * refreshOrderAllocationRollup，传入真实 pg Client 事务句柄。
 *
 * ⚠️ 仅对测试库（47.113.202.7:5433）；绝不碰生产 IP 118.178.196.26。
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

const DEFAULT_CONN = 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
const CONN = process.env.PAYMENT_ALLOCATABLE_INT_DATABASE_URL || DEFAULT_CONN

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

// 读取某回款主流水行落库的逐项 receipt，返回 { saleItemId: amount }
async function allocatableMap(salePaymentId) {
  const r = await client.query(
    `SELECT id, sale_item_id, amount::numeric AS amount, sales_category
       FROM sale_payment_item_receipts WHERE sale_payment_id = $1`,
    [salePaymentId],
  )
  const m = {}
  for (const row of r.rows) {
    m[row.sale_item_id] = { id: row.id, amount: num(row.amount), salesCategory: row.sales_category }
  }
  return m
}

beforeAll(async () => {
  client = new Client({ connectionString: CONN })
  await client.connect()

  // 守护：绝不连生产 IP 118.178.196.26。
  // 默认连接测试库时仍校验库名；覆盖到临时 PG 时允许其它库名。
  if (CONN.includes('118.178.196.26')) {
    throw new Error('拒绝运行：PAYMENT_ALLOCATABLE_INT_DATABASE_URL 指向生产库')
  }
  const dbRes = await client.query('SELECT current_database() AS db')
  if (CONN === DEFAULT_CONN && dbRes.rows[0].db !== 'fengyu_wxapp') {
    throw new Error(`拒绝运行：期望测试库 fengyu_wxapp，实连 ${dbRes.rows[0].db}`)
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

describe('payment-allocatable capture 链路（real PG 5433, BEGIN...ROLLBACK）', () => {
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

  it('步骤5：sale_payment_item_allocations 唯一约束 uq_spia_receipt_emp_role 同 receipt/员工/角色活跃行 → 23505', async () => {
    if (!employeeId) {
      // 库内无员工则跳过该断言（FK employee_id 无可用值）
      console.warn('[skip] staff_wechat_users 为空，跳过唯一约束断言')
      return
    }
    const salePaymentId = globalThis.__firstPaymentId
    const m = await allocatableMap(salePaymentId)
    const receiptId = m[ITEM_A]?.id
    expect(receiptId).toBeDefined()

    // 首条活跃子分配（receipt A / emp / 美容师）
    await client.query(
      `INSERT INTO sale_payment_item_allocations
         (sale_payment_item_receipt_id, employee_id, allocation_ratio, role_type, allocated_amount, is_void)
       VALUES ($1, $2, 1.00, '美容师', 180, false)`,
      [receiptId, employeeId],
    )

    // 同 (receipt, emp, role) 再插一条活跃行 → 唯一索引冲突 23505
    await client.query('SAVEPOINT dup_alloc')
    let dupErr = null
    try {
      await client.query(
        `INSERT INTO sale_payment_item_allocations
           (sale_payment_item_receipt_id, employee_id, allocation_ratio, role_type, allocated_amount, is_void)
         VALUES ($1, $2, 1.00, '美容师', 180, false)`,
        [receiptId, employeeId],
      )
    } catch (err) {
      dupErr = err
      await client.query('ROLLBACK TO SAVEPOINT dup_alloc')
    }
    expect(dupErr).not.toBeNull()
    expect(dupErr.code).toBe('23505')
    expect(String(dupErr.constraint || dupErr.message)).toContain('uq_spia_receipt_emp_role')
  })
})

// 转换单（按回款逐笔分配）：明细只有「转出/转入」、无「购买」行 → capture 命中 0 明细。
// 旧逻辑：items.length===0 早返回，不产 receipt、回款行状态靠回填补；新逻辑：按转出/转入
//         |sale_amount|（绝对值）权重落 receipt，与销售单一样支持按每笔回款逐笔分配。
//         转出/转入行 received 不受 recalc STEP1 影响（只看『购买』行）。
describe('capture 转换单（无「购买」明细，业绩转移）', () => {
  const CONV_ORDER = `IT-PA-CONV-${RUN}`
  const CONV_OUT = `IT-PA-CONV-OUT-${RUN}` // 转出（旧卡剩余价值，负数）
  const CONV_IN = `IT-PA-CONV-IN-${RUN}` // 转入（新卡价值，正数）

  it('造转换单 + 转出/转入明细（无购买行）', async () => {
    await client.query(
      `INSERT INTO sale_orders
         (sale_order_id, status, sale_order_type, market_name, store_id, store_name,
          sale_order_datetime, total_amount, payment_method, received)
       VALUES ($1, '已支付', '转换单', '集成测试市场', $2, '集成测试门店',
               NOW(), 789, '线下', 789)`,
      [CONV_ORDER, storeId],
    )
    const insDir = (id, direction, unitPrice, saleAmount, sessionCount) =>
      client.query(
        `INSERT INTO sale_items
           (sale_item_id, sale_order_id, store_id, item_direction, product_type, session_count,
            unit_price, unit_real_price, sale_amount, received, quantity, sales_category)
         VALUES ($1, $2, $3, $4, '疗程卡', $5, $6, $6, $7, $7, 1, '自销自耗')`,
        [id, CONV_ORDER, storeId, direction, sessionCount, unitPrice, saleAmount],
      )
    // 转出：unit_price=298(≥0 满足 chk_item_unit_price)，sale_amount/received=-211（业绩转出）
    await insDir(CONV_OUT, '转出', 298, -211, 1)
    // 转入：unit_price=200，sale_amount/received=1000（新卡价值）
    await insDir(CONV_IN, '转入', 200, 1000, 5)

    const purchaseCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM sale_items WHERE sale_order_id=$1 AND item_direction='购买'`,
      [CONV_ORDER],
    )
    expect(purchaseCount.rows[0].n).toBe(0)
  })

  it('capture 落 signed receipt 到转出/转入行（净额=本笔实收），回款行置「待分配」', async () => {
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '首次支付', 789, '线下', '已支付', 'staff', NOW())
       RETURNING id`,
      [CONV_ORDER],
    )
    const salePaymentId = Number(pay.rows[0].id)

    const out = await capturePaymentAllocatables(client, {
      salePaymentId,
      saleOrderId: CONV_ORDER,
      eventAmount: 789,
      directedItems: null,
    })

    // 转换单 → weightCents 取 sale_amount 绝对值（Bug 7）：转出 211 / 转入 1000 作权重，
    // evt=789 → 转出 +137.47、转入 +651.53，净额 789（本笔实收）
    const retById = Object.fromEntries(out.map((o) => [o.saleItemId, o]))
    expect(num(retById[CONV_OUT].amount)).toBe(137.47)
    expect(num(retById[CONV_IN].amount)).toBe(651.53)
    expect(num(retById[CONV_OUT].amount) + num(retById[CONV_IN].amount)).toBe(789)
    const m = await allocatableMap(salePaymentId)
    expect(Object.keys(m).length).toBe(2)
    expect(m[CONV_OUT].amount).toBe(137.47)
    expect(m[CONV_IN].amount).toBe(651.53)
    expect(m[CONV_IN].salesCategory).toBe('自销自耗')

    const ps = await client.query(
      `SELECT allocation_status FROM sale_order_payments WHERE id = $1`,
      [salePaymentId],
    )
    expect(ps.rows[0].allocation_status).toBe('待分配')
  })

  it('refreshOrderAllocationRollup → 转换单订单级「待分配」', async () => {
    await refreshOrderAllocationRollup(client, CONV_ORDER)
    const o = await client.query(
      `SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`,
      [CONV_ORDER],
    )
    expect(o.rows[0].allocation_status).toBe('待分配')
  })

  it('转换单仅有负 sale_amount 转出行：weightCents 取绝对值 → evt 全落转出行并产 receipt', async () => {
    const CONV_NOIN = `IT-PA-CONV-NOIN-${RUN}`
    const CONV_NOIN_OUT = `IT-PA-CONV-NOIN-OUT-${RUN}`
    await client.query(
      `INSERT INTO sale_orders
         (sale_order_id, status, sale_order_type, market_name, store_id, store_name,
          sale_order_datetime, total_amount, payment_method, received)
       VALUES ($1, '已支付', '转换单', '集成测试市场', $2, '集成测试门店', NOW(), 500, '线下', 500)`,
      [CONV_NOIN, storeId],
    )
    await client.query(
      `INSERT INTO sale_items
         (sale_item_id, sale_order_id, store_id, item_direction, product_type, session_count,
          unit_price, unit_real_price, sale_amount, received, quantity, sales_category)
       VALUES ($1, $2, $3, '转出', '疗程卡', 1, 100, 100, -500, -500, 1, '自销自耗')`,
      [CONV_NOIN_OUT, CONV_NOIN, storeId],
    )
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '首次支付', 500, '线下', '已支付', 'staff', NOW()) RETURNING id`,
      [CONV_NOIN],
    )
    const salePaymentId = Number(pay.rows[0].id)

    const out = await capturePaymentAllocatables(client, {
      salePaymentId,
      saleOrderId: CONV_NOIN,
      eventAmount: 500,
      directedItems: null,
    })

    // 异常转换单（仅负 sale_amount 转出行）：weightCents 取绝对值后净权重 500 > 0 → evt=500 全落转出行
    expect(out).toHaveLength(1)
    expect(out[0].saleItemId).toBe(CONV_NOIN_OUT)
    expect(num(out[0].amount)).toBe(500)
    const m = await allocatableMap(salePaymentId)
    expect(Object.keys(m).length).toBe(1)
    expect(m[CONV_NOIN_OUT].amount).toBe(500)
    const ps = await client.query(
      `SELECT allocation_status FROM sale_order_payments WHERE id = $1`,
      [salePaymentId],
    )
    expect(ps.rows[0].allocation_status).toBe('待分配')
  })
})

// 转换单多转入行（异品类）：新码按 |sale_amount|（绝对值）比例摊到全部转出/转入行，
// 各转入行得到对应品类 receipt，下游提成按行品类率归因正确。
describe('capture 转换单多转入行（异品类按 |sale_amount| 比例摊）', () => {
  const CONV_MULTI = `IT-PA-CM-${RUN}` // sale_order_id
  const CONV_MULTI_OUT = `IT-PA-CM-O-${RUN}` // 转出 -100
  const CONV_IN1 = `IT-PA-CM-A-${RUN}` // 转入 自销自耗 sale_amount=300
  const CONV_IN2 = `IT-PA-CM-B-${RUN}` // 转入 他销自耗 sale_amount=300

  it('造转换单 + 1 转出(-100) + 2 异品类转入(自销自耗 300 / 他销自耗 300)', async () => {
    await client.query(
      `INSERT INTO sale_orders
         (sale_order_id, status, sale_order_type, market_name, store_id, store_name,
          sale_order_datetime, total_amount, payment_method, received)
       VALUES ($1, '已支付', '转换单', '集成测试市场', $2, '集成测试门店',
               NOW(), 500, '线下', 500)`,
      [CONV_MULTI, storeId],
    )
    const insDir = (id, direction, cat, unitPrice, saleAmount, sessionCount) =>
      client.query(
        `INSERT INTO sale_items
           (sale_item_id, sale_order_id, store_id, item_direction, product_type, session_count,
            unit_price, unit_real_price, sale_amount, received, quantity, sales_category)
         VALUES ($1, $2, $3, $4, '疗程卡', $5, $6, $6, $7, $7, 1, $8)`,
        [id, CONV_MULTI, storeId, direction, sessionCount, unitPrice, saleAmount, cat],
      )
    await insDir(CONV_MULTI_OUT, '转出', '自销自耗', 100, -100, 1)
    await insDir(CONV_IN1, '转入', '自销自耗', 300, 300, 5)
    await insDir(CONV_IN2, '转入', '他销自耗', 300, 300, 5)
  })

  it('capture 按 |sale_amount| 比例摊 evt=500 → 转出 71.43 / 自销自耗 214.29 / 他销自耗 214.28', async () => {
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '首次支付', 500, '线下', '已支付', 'staff', NOW())
       RETURNING id`,
      [CONV_MULTI],
    )
    const salePaymentId = Number(pay.rows[0].id)

    const out = await capturePaymentAllocatables(client, {
      salePaymentId,
      saleOrderId: CONV_MULTI,
      eventAmount: 500,
      directedItems: null,
    })

    const retById = Object.fromEntries(out.map((o) => [o.saleItemId, o]))
    expect(num(retById[CONV_MULTI_OUT].amount)).toBe(71.43)
    expect(num(retById[CONV_IN1].amount)).toBe(214.29)
    expect(num(retById[CONV_IN2].amount)).toBe(214.28)
    expect(retById[CONV_IN1].salesCategory).toBe('自销自耗')
    expect(retById[CONV_IN2].salesCategory).toBe('他销自耗')
    expect(num(retById[CONV_MULTI_OUT].amount) + num(retById[CONV_IN1].amount) + num(retById[CONV_IN2].amount)).toBe(500)

    const m = await allocatableMap(salePaymentId)
    expect(m[CONV_MULTI_OUT].amount).toBe(71.43)
    expect(m[CONV_IN1].amount).toBe(214.29)
    expect(m[CONV_IN2].amount).toBe(214.28)
    expect(m[CONV_IN1].salesCategory).toBe('自销自耗')
    expect(m[CONV_IN2].salesCategory).toBe('他销自耗')
  })
})
