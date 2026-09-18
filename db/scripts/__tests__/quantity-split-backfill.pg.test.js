/**
 * #154 迁移 0043 回填口径的真实 PG 回归
 *
 * 为什么必须连真库：回填是一条带 CTE + CASE 分支的 UPDATE 加三个 DO 断言块，
 * 分支走没走对、`residual < 0` 会不会被 `ELSE 0` 静默吞掉、断言会不会真的 RAISE——
 * 这些全部是 SQL 语义，字面量快照测不出来。
 *
 * 本套件**直接读取 `db/migrations/0043_split_quantity_semantics.sql` 的正文**执行，
 * 不复制一份 SQL 到测试里：复制副本会随迁移改动漂移，而漂移了测试照样绿。
 *
 * 运行（需要一个已 apply 全部 migration 的库；绝不要指向业务库）：
 *
 *   docker run -d --name pg-154 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
 *     -p 54354:5432 postgres:16
 *   DATABASE_URL="postgresql://postgres:test@localhost:54354/test" \
 *     npx --prefix db drizzle-kit migrate
 *   QUANTITY_SPLIT_PG_TEST_URL="postgresql://postgres:test@localhost:54354/test" \
 *     node --test db/scripts/__tests__/quantity-split-backfill.pg.test.js
 *   docker rm -f pg-154
 *
 * 没设 QUANTITY_SPLIT_PG_TEST_URL 时整个套件 skip，`node --test db/scripts/__tests__/*.test.js`
 * 在没有本地 PG 的机器上仍然全绿（与 attribution-trigger.pg.test.js 同模式）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const URL = process.env.QUANTITY_SPLIT_PG_TEST_URL

/** 业务库库名。三套业务库同端口同库名只靠 IP 区分，IP 黑名单是 fail-open 的
 *  （DNS 名、容器网桥、SSH 隧道都能绕过），所以连上之后问数据库自己叫什么。 */
const BUSINESS_DB_NAME = 'fengyu_wxapp'

/** 夹具前缀，清理时按它删。 */
const P = 'T154PG_'

const MIGRATION = path.join(__dirname, '..', '..', 'migrations', '0043_split_quantity_semantics.sql')

if (!URL) {
  test('#154 回填口径真实 PG 回归（未设 QUANTITY_SPLIT_PG_TEST_URL，跳过）', { skip: true }, () => {})
} else {
  runSuite()
}

/**
 * 取迁移正文里的回填段：跳过 drizzle-kit 生成的两条 ALTER TABLE（库里已经有列了），
 * 其余按 `--> statement-breakpoint` 切开逐条执行。
 */
function backfillStatements() {
  const raw = fs.readFileSync(MIGRATION, 'utf8')
  const parts = raw.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
  const kept = parts.filter((s) => !/^ALTER TABLE "sale_items" ADD COLUMN/i.test(s))
  assert.equal(parts.length - kept.length, 2, '迁移里的 ADD COLUMN 条数变了，本测试的切分假设需同步更新')
  assert.ok(kept.length >= 4, '回填段应含：前置断言 + UPDATE + 两个事后断言')
  return kept
}

async function assertNotBusinessDatabase(db) {
  const { rows } = await db.query(
    `SELECT current_database() AS db, COALESCE(host(inet_server_addr()), 'local') AS addr`,
  )
  if (rows[0].db === BUSINESS_DB_NAME) {
    throw new Error(
      `拒绝在业务库上运行本套件：current_database()=${rows[0].db} @ ${rows[0].addr}。本套件会建数据并重放回填。`,
    )
  }
}

function runSuite() {
  const pool = new Pool({ connectionString: URL, max: 4 })
  const q = (sql, params) => pool.query(sql, params)
  const STATEMENTS = backfillStatements()

  test.before(async () => {
    await assertNotBusinessDatabase(pool)
    await q(`INSERT INTO org_nodes (id, name, type) VALUES ($1,'测试总部','总部') ON CONFLICT (id) DO NOTHING`, [`${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试市场','市场',$2) ON CONFLICT (id) DO NOTHING`, [`${P}MK`, `${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试门店','门店',$2) ON CONFLICT (id) DO NOTHING`, [`${P}ST`, `${P}MK`])
    await q(`INSERT INTO stores (store_id, store_name, org_node_id) VALUES ($1,'测试门店',$1) ON CONFLICT (store_id) DO NOTHING`, [`${P}ST`])
    // pickup_records.confirmed_by → staff_wechat_users.employee_id 有外键
    await q(`INSERT INTO staff_wechat_users (employee_id, name) VALUES ($1,'测试员工') ON CONFLICT (employee_id) DO NOTHING`, [`${P}EMP`])
  })

  test.after(async () => {
    await cleanupFixtures()
    await q(`DELETE FROM inventory_locations WHERE location_id LIKE $1 OR store_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM stores WHERE store_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM org_nodes WHERE id LIKE $1`, [`${P}%`])
    await pool.end()
  })

  async function cleanupFixtures() {
    await q(`DELETE FROM pickup_records WHERE sale_item_id LIKE $1`, [`${P}%`])
    await q(`UPDATE sale_items SET ref_sale_item_id = NULL WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [`${P}%`])
  }

  async function seedOrder(id, { status = '已支付', type = '销售单' } = {}) {
    await q(
      `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime,
                                total_amount, payment_method, status, sale_order_type,
                                performance_attribution_date)
       VALUES ($1,'测试市场',$2,'2026-09-01 10:00:00+08',1000,'微信',$3,$4,'2026-09-01')`,
      [id, `${P}ST`, status, type],
    )
  }

  /** 家居行；pickedUp 写的是**拆列前**的「已结算」合计，模拟迁移执行那一刻的库态。 */
  async function seedHomeItem(itemId, orderId, { quantity = 1, pickedUp = 0, direction = '购买', refItemId = null } = {}) {
    await q(
      `INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, product_type, product_name,
                               item_direction, ref_sale_item_id, quantity, unit_price, unit_real_price,
                               sale_amount, received, picked_up_quantity)
       VALUES ($1,$2,$3,'家居产品','测试家居',$4,$5,$6,100,100,$7,$7,$8)`,
      [itemId, orderId, `${P}ST`, direction, refItemId, quantity, 100 * quantity, pickedUp],
    )
  }

  async function seedPickupRecord(itemId, qty) {
    await q(
      `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, confirmed_by)
       VALUES ($1,$2,$3,$4)`,
      [itemId, qty, `${P}ST`, `${P}EMP`],
    )
  }

  async function seedPaidRefund(orderId) {
    await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
                                        status, source_end, paid_at)
       VALUES ($1,'退款',-100,'线下','已支付','staff','2026-09-10 10:00:00+08')`,
      [orderId],
    )
  }

  /** 重放迁移正文的回填段。抛错即代表某个 DO 断言 RAISE 了。 */
  async function runBackfill() {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const stmt of STATEMENTS) await client.query(stmt)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  const readSplit = async (itemId) => (await q(
    `SELECT COALESCE(picked_up_quantity,0)  AS picked,
            COALESCE(refunded_quantity,0)   AS refunded,
            COALESCE(converted_quantity,0)  AS converted
       FROM sale_items WHERE sale_item_id = $1`,
    [itemId],
  )).rows[0]

  test('退款语义：无提货记录、无折抵、订单有已支付退款 → 全额归 refunded_quantity', async () => {
    await cleanupFixtures()
    const order = `${P}R1`
    const item = `${P}R1-01`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 3, pickedUp: 3 })
    await seedPaidRefund(order)

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 0, refunded: 3, converted: 0 })
  })

  test('物理提货：picked_up_quantity 回归 SUM(pickup_records)，不落进 refunded', async () => {
    await cleanupFixtures()
    const order = `${P}P1`
    const item = `${P}P1-01`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 5, pickedUp: 2 })
    await seedPickupRecord(item, 2)

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 2, refunded: 0, converted: 0 })
  })

  test('混合：提 2 + 退 3（共 5）→ 物理提货与退款各归各列', async () => {
    await cleanupFixtures()
    const order = `${P}M1`
    const item = `${P}M1-01`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 5, pickedUp: 5 })
    await seedPickupRecord(item, 2)
    await seedPaidRefund(order)

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 2, refunded: 3, converted: 0 })
  })

  test('折抵：转出行数量归 converted_quantity，且不被计成退款', async () => {
    await cleanupFixtures()
    const order = `${P}C1`
    const item = `${P}C1-01`
    const convOrder = `${P}C1CONV`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 4, pickedUp: 4 })
    await seedOrder(convOrder, { type: '转换单' })
    await seedHomeItem(`${P}C1CONV-OUT`, convOrder, { quantity: 4, direction: '转出', refItemId: item })

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 0, refunded: 0, converted: 4 })
  })

  test('已关闭的转换单不计入 converted（rollback 已退回数量）', async () => {
    await cleanupFixtures()
    const order = `${P}C2`
    const item = `${P}C2-01`
    const convOrder = `${P}C2CONV`
    await seedOrder(order)
    // 转换单已关闭 → rollback 已把数量退回，旧 picked_up 里不含这笔，故此处只剩物理提货 1
    await seedHomeItem(item, order, { quantity: 4, pickedUp: 1 })
    await seedPickupRecord(item, 1)
    await seedOrder(convOrder, { status: '已关闭', type: '转换单' })
    await seedHomeItem(`${P}C2CONV-OUT`, convOrder, { quantity: 3, direction: '转出', refItemId: item })

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 1, refunded: 0, converted: 0 })
  })

  test('无退款的残差留在 picked_up_quantity（无 pickup_records 的历史提货），不误记成退款', async () => {
    await cleanupFixtures()
    const order = `${P}L1`
    const item = `${P}L1-01`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 2, pickedUp: 2 })
    // 刻意不建 pickup_records、不建退款流水

    await runBackfill()

    assert.deepEqual(await readSplit(item), { picked: 2, refunded: 0, converted: 0 })
  })

  test('residual < 0 必须 RAISE 而不是被 ELSE 0 静默吞掉', async () => {
    await cleanupFixtures()
    const order = `${P}B1`
    const item = `${P}B1-01`
    await seedOrder(order)
    // 旧 picked_up=1，但物理提货记录 3 件 → residual = -2，属守恒破坏
    await seedHomeItem(item, order, { quantity: 5, pickedUp: 1 })
    await seedPickupRecord(item, 3)

    await assert.rejects(
      runBackfill(),
      (e) => /#154 回填前守恒破坏/.test(e.message) && e.message.includes(item),
      '守恒破坏必须带上样例 sale_item_id 抛出',
    )

    // 事务已回滚，数据保持原样
    assert.deepEqual(await readSplit(item), { picked: 1, refunded: 0, converted: 0 })
  })

  test('事后断言 2：有提货记录的行，picked_up_quantity 必须等于 pickup_records 合计', async () => {
    await cleanupFixtures()
    const order = `${P}A1`
    const item = `${P}A1-01`
    await seedOrder(order)
    await seedHomeItem(item, order, { quantity: 6, pickedUp: 6 })
    await seedPickupRecord(item, 4)
    await seedPaidRefund(order)

    await runBackfill()

    const { rows } = await q(
      `SELECT COALESCE(si.picked_up_quantity,0) AS picked,
              COALESCE((SELECT SUM(pr.pickup_quantity)::int FROM pickup_records pr
                         WHERE pr.sale_item_id = si.sale_item_id),0) AS records_total
         FROM sale_items si WHERE si.sale_item_id = $1`,
      [item],
    )
    assert.equal(rows[0].picked, rows[0].records_total, 'AC4 不变量')
    assert.equal(rows[0].picked, 4)
  })
}
