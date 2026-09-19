/**
 * #182 折抵退出行的 received 重建 —— 真实库集成测试（BEGIN ... ROLLBACK，绝不 COMMIT）
 *
 * 钉住第 4 轮双谱系评审两次独立命中的那条 P1，以及它的两个后果：
 *   ① D3：折抵行 remaining_sessions 已注销为 0，要求 paid_sessions 恒满付，
 *      即 received >= 下调后的 sale_amount。
 *   ② 守恒：Σ(行级 received) = 订单级实收 − 已退款额；折抵不得凭空多出行级实收，
 *      也不得改变同单**其它行**分到的钱。
 *   ③ 款项分摊：折抵行债务已归零，新回款不得落到它头上。
 *
 * 曾经错过的两种写法（本测试就是它们的反例）：
 *   - `pending_received` 钉成**净**实收 → STEP 1.5 再扣一次退款 → 用例 2 会抛
 *     PAID_SESSIONS_UNDERFLOW；
 *   - 折抵行仍留在 Branch B 的比例池里、事后单行抬 received 下限 → 用例 1 的
 *     Σ行级会变成 116.67（订单实收只有 100）。
 *
 * 单测（mock）测不出这两条：它们要么依赖 PG 的 numeric 与窗口函数语义，要么依赖
 * STEP 1 / 1.5 / 1.6 的真实执行顺序。
 *
 * 运行：
 *   env -u http_proxy -u https_proxy -u all_proxy \
 *     npx vitest run __tests__/integration/waived-row-received.int.test.js
 */
const { Client } = require('pg')
const { recalcPaidSessionsForOrder } = require('../../utils/paid-sessions')
const { capturePaymentAllocatables } = require('../../utils/payment-allocatable')

const DEFAULT_CONN = 'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'
const CONN = process.env.PAYMENT_ALLOCATABLE_INT_DATABASE_URL || DEFAULT_CONN

const RUN = String(Date.now()).slice(-10)
const ORDER_SPLIT = `IT182-S-${RUN}` // 用例 1/3：两行各原价 100、订单只收到 100
const ITEM_A = `IT182-SA-${RUN}`
const ITEM_B = `IT182-SB-${RUN}`
const ORDER_REFUND = `IT182-R-${RUN}` // 用例 2：付清后退 40
const ITEM_C = `IT182-RC-${RUN}`

let client
let storeId = null

const num = (v) => Math.round(Number(v) * 100) / 100

async function readItems(saleOrderId) {
  const r = await client.query(
    `SELECT sale_item_id, received::numeric AS received, sale_amount::numeric AS sale_amount,
            pending_received::numeric AS pending_received, waived_amount::numeric AS waived_amount,
            session_count, remaining_sessions, paid_sessions
       FROM sale_items WHERE sale_order_id = $1 ORDER BY sale_item_id`,
    [saleOrderId],
  )
  return Object.fromEntries(r.rows.map((row) => [row.sale_item_id, row]))
}

const insOrder = (id, total, received, refunded = 0) =>
  client.query(
    `INSERT INTO sale_orders
       (sale_order_id, status, sale_order_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, payment_method, received, refunded_amount)
     VALUES ($1, '部分支付', '销售单', '集成测试市场', $2, '集成测试门店',
             NOW(), $3, '线下', $4, $5)`,
    [id, storeId, total, received, refunded],
  )

// session_count 次卡：pending_received = 逐行实付草稿（开单时约定的该行实付）
const insCard = (id, orderId, saleAmount, pending, sessionCount) =>
  client.query(
    `INSERT INTO sale_items
       (sale_item_id, sale_order_id, store_id, item_direction, product_type,
        unit_price, unit_real_price, sale_amount, received, pending_received,
        quantity, session_count, remaining_sessions, sales_category)
     VALUES ($1, $2, $3, '购买', '疗程卡',
             $4, $5, $4, 0, $6, 1, $7, $7, '自销自耗')`,
    [id, orderId, storeId, saleAmount, saleAmount / sessionCount, pending, sessionCount],
  )

// 模拟 createConversion 的「整行退出 + 欠款归零」落库结果（口径见 backend.pr.spec.md）：
//   行级 Δ = sale_amount − 净实收；pending_received 钉到**毛已付** = 净实收 + 该行已退款额
async function foldRow(saleItemId, rowRefunded) {
  const cur = await client.query(
    `SELECT sale_amount::numeric AS sale_amount, received::numeric AS received
       FROM sale_items WHERE sale_item_id = $1`,
    [saleItemId],
  )
  const saleAmount = num(cur.rows[0].sale_amount)
  const received = num(cur.rows[0].received)
  const rowWaive = num(saleAmount - received)
  await client.query(
    `UPDATE sale_items
        SET sale_amount = $2, waived_amount = waived_amount + $3,
            pending_received = $4, remaining_sessions = 0
      WHERE sale_item_id = $1`,
    [saleItemId, received, rowWaive, num(received + rowRefunded)],
  )
  return { rowWaive, orderWaive: Math.max(0, num(rowWaive - rowRefunded)) }
}

beforeAll(async () => {
  client = new Client({ connectionString: CONN })
  await client.connect()
  if (CONN.includes('118.178.196.26')) {
    throw new Error('拒绝运行：连接串指向生产库')
  }
  const dbRes = await client.query('SELECT current_database() AS db')
  if (CONN === DEFAULT_CONN && dbRes.rows[0].db !== 'fengyu_wxapp') {
    throw new Error(`拒绝运行：期望测试库 fengyu_wxapp，实连 ${dbRes.rows[0].db}`)
  }
  await client.query('BEGIN')
  const s = await client.query('SELECT store_id FROM stores ORDER BY store_id LIMIT 1')
  storeId = s.rows[0] && s.rows[0].store_id
  if (!storeId) throw new Error('库内无 stores，无法造销售单')
})

afterAll(async () => {
  if (client) {
    try {
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  }
})

describe('#182 折抵行 received 重建（real PG 5433, BEGIN...ROLLBACK）', () => {
  it('用例1-a：两行各原价 100、订单只收到 100 → Branch B 按比例各 50', async () => {
    await insOrder(ORDER_SPLIT, 200, 100)
    await insCard(ITEM_A, ORDER_SPLIT, 100, 100, 10)
    await insCard(ITEM_B, ORDER_SPLIT, 100, 100, 10)

    await recalcPaidSessionsForOrder(client, ORDER_SPLIT)

    const items = await readItems(ORDER_SPLIT)
    expect(num(items[ITEM_A].received)).toBe(50)
    expect(num(items[ITEM_B].received)).toBe(50)
    // 半付 → 各解锁 5 次
    expect(items[ITEM_A].paid_sessions).toBe(5)
    expect(items[ITEM_B].paid_sessions).toBe(5)
  })

  it('用例1-b：折抵 A（整行退出+欠款归零）后重算 —— A 拿回全额 50、B 一分不变、Σ行级=订单实收', async () => {
    const { rowWaive, orderWaive } = await foldRow(ITEM_A, 0)
    expect(rowWaive).toBe(50)
    expect(orderWaive).toBe(50)
    await client.query(
      'UPDATE sale_orders SET total_amount = total_amount - $2 WHERE sale_order_id = $1',
      [ORDER_SPLIT, orderWaive],
    )

    // 不得抛 PAID_SESSIONS_UNDERFLOW
    await recalcPaidSessionsForOrder(client, ORDER_SPLIT)

    const items = await readItems(ORDER_SPLIT)
    // A 走「固定预留」：received 恒等于钉住的毛已付，不被比例池摊薄
    expect(num(items[ITEM_A].received)).toBe(50)
    // 折抵前后 B 分到的钱必须完全相同（预留额已从 untargeted 扣除）
    expect(num(items[ITEM_B].received)).toBe(50)
    // 守恒：Σ行级 = 订单级实收（曾经的「事后抬下限」写法会得到 116.67）
    expect(num(items[ITEM_A].received) + num(items[ITEM_B].received)).toBe(100)
    // D3：remaining 已注销为 0，故 paid_sessions 必须满付
    expect(items[ITEM_A].remaining_sessions).toBe(0)
    expect(items[ITEM_A].paid_sessions).toBe(10)
    // B 未被折抵，权益不受影响
    expect(items[ITEM_B].paid_sessions).toBe(5)
  })

  it('用例1-c：折抵后再回款 50（非定向）→ 全额落在欠款行 B，折抵行 A 零产能', async () => {
    const pay = await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1, '回款', 50, '线下', '已支付', 'staff', NOW())
       RETURNING id`,
      [ORDER_SPLIT],
    )
    const out = await capturePaymentAllocatables(client, {
      salePaymentId: Number(pay.rows[0].id),
      saleOrderId: ORDER_SPLIT,
      eventAmount: 50,
      directedItems: null,
    })
    const byId = Object.fromEntries(out.map((o) => [o.saleItemId, num(o.amount)]))
    expect(byId[ITEM_A]).toBeUndefined()
    expect(byId[ITEM_B]).toBe(50)
  })

  it('用例2-a：付清 100 后按项退 40 → received 净额 60、paid_sessions 退回 6', async () => {
    await insOrder(ORDER_REFUND, 100, 100, 40)
    await insCard(ITEM_C, ORDER_REFUND, 100, 100, 10)
    // chk_sop_amount_sign：退款流水 amount 必须为负；行级退款权威源是 note.items[].refundAmount（正数）
    await client.query(
      `INSERT INTO sale_order_payments
         (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at, note)
       VALUES ($1, '退款', -40, '线下', '已支付', 'staff', NOW(), $2)`,
      [ORDER_REFUND, JSON.stringify({ items: [{ refSaleItemId: ITEM_C, refundAmount: 40 }] })],
    )

    await recalcPaidSessionsForOrder(client, ORDER_REFUND)

    const items = await readItems(ORDER_REFUND)
    expect(num(items[ITEM_C].received)).toBe(60)
    expect(items[ITEM_C].paid_sessions).toBe(6)
  })

  it('用例2-b：折抵该行后重算 —— 钉住值是毛已付，STEP 1.5 只扣一次退款，D3 成立', async () => {
    const { rowWaive, orderWaive } = await foldRow(ITEM_C, 40)
    // 行级压到净实收 60；订单级 = 40 − 40 = 0（那 40 已退给顾客，不是欠款）
    expect(rowWaive).toBe(40)
    expect(orderWaive).toBe(0)

    const pinned = await readItems(ORDER_REFUND)
    expect(num(pinned[ITEM_C].pending_received)).toBe(100) // 毛已付，不是净额 60

    // 钉成净额 60 时这里会抛 CONFLICT: PAID_SESSIONS_UNDERFLOW（60 − 40 = 20 < 应付 60）
    await recalcPaidSessionsForOrder(client, ORDER_REFUND)

    const items = await readItems(ORDER_REFUND)
    expect(num(items[ITEM_C].sale_amount)).toBe(60)
    expect(num(items[ITEM_C].received)).toBe(60) // 预留 100 毛额 − 退款 40
    expect(items[ITEM_C].remaining_sessions).toBe(0)
    expect(items[ITEM_C].paid_sessions).toBe(10)
    // 守恒：行级净额 = 订单级实收 − 已退款
    expect(num(items[ITEM_C].received)).toBe(100 - 40)
  })
})
