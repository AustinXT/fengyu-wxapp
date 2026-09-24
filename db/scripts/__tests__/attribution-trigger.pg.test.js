/**
 * 款项业绩归属日期 trigger 的真实 PG 回归（issue #137 / 迁移 0041）
 *
 * 为什么必须连真库：本次改动把「订单级归属日期变更 → 同步首次支付行 + 同次储值卡行」
 * 从应用层下沉成了 DB trigger。admin / staffApi 的单测把 `db.execute` 整个 mock 掉了，
 * **trigger 没建、谓词写歪、两条 UPDATE 顺序颠倒、并发脏读**——这些一条都测不出来。
 *
 * 运行（需要一个已 apply 全部 migration 的库；绝不要指向业务库）：
 *
 *   docker run -d --name pg-attr -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
 *     -p 54399:5432 postgres:16
 *   DATABASE_URL="postgresql://postgres:test@localhost:54399/test" \
 *     bash db/scripts/bootstrap-from-zero.sh
 *   ATTRIBUTION_PG_TEST_URL="postgresql://postgres:test@localhost:54399/test" \
 *     node --test db/scripts/__tests__/attribution-trigger.pg.test.js
 *   docker rm -f pg-attr
 *
 * 没设 ATTRIBUTION_PG_TEST_URL 时整个套件 skip —— 这样 `node --test db/scripts/__tests__/`
 * 在没有本地 PG 的机器上仍然全绿。
 *
 * 用独立环境变量而不是 DATABASE_URL：后者在本仓库默认指向**开发业务库**，
 * 这个套件会建表数据、禁用 trigger、跑并发事务，误连业务库后果严重。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Client, Pool } = require('pg')

const URL = process.env.ATTRIBUTION_PG_TEST_URL

/**
 * 业务库的库名。三套业务库（prod / test / dev）同端口同库名，只靠 IP 区分 ——
 * 但 IP 黑名单是 fail-open 的：DNS 名、容器网桥 `172.18.0.1`、SSH 隧道全都能绕过去。
 * 所以这里不校验连接串，而是**连上之后问数据库自己叫什么**，叫这个名字就一律拒绝。
 * 本套件会建数据、在事务里禁用核心 trigger、跑并发事务，误连一次就是生产事故。
 */
const BUSINESS_DB_NAME = 'fengyu_wxapp'
/**
 * 一并拒绝 admin 的 e2e 库：它与 dev 业务库同机、只靠库名隔离（见 db/CLAUDE.md「e2e 独立库」），
 * 同样不该被拿来禁用 trigger 和跑并发事务。
 */
const FORBIDDEN_DB_NAMES = [BUSINESS_DB_NAME, 'fengyu_e2e']

/** 夹具前缀，清理时按它删；与 e2e 的 TE2L2_ 命名空间区隔开。 */
const P = 'T137PG_'
/**
 * LIKE 模式：前缀里的 `_` 是 LIKE 通配符，不转义的话 `T137PG_%` 会连 `T137PGx...` 一起删掉 ——
 * 清理范围宽于约定前缀。
 */
const LIKE_P = `${P.replace(/_/g, '\\_')}%`

if (!URL) {
  test('attribution trigger 真实 PG 回归（未设 ATTRIBUTION_PG_TEST_URL，跳过）', { skip: true }, () => {})
} else {
  runSuite()
}

/** 连上之后、跑任何夹具之前，先确认这不是业务库。 */
async function assertNotBusinessDatabase(db) {
  const { rows } = await db.query(
    `SELECT current_database() AS db,
            COALESCE(host(inet_server_addr()), 'local') AS addr`,
  )
  const { db: dbName, addr } = rows[0]
  if (FORBIDDEN_DB_NAMES.includes(dbName)) {
    throw new Error(
      `拒绝在业务库上运行本套件：current_database()=${dbName} @ ${addr}。`
      + '本套件会建数据、禁用 trigger、跑并发事务。',
    )
  }
}

function runSuite() {
  const APP_NAME = 'T137PG'
  const pool = new Pool({ connectionString: URL, max: 4, application_name: APP_NAME })

  /**
   * 与 `allocation-lock-order.pg.test.js`（issue #148）互斥。
   *
   * `db:test` 并行跑多文件，两个真库套件会连同一个库。光按 application_name 过滤等锁观察不够 ——
   * 那只解决「看错了谁在等」，不隔离**真实锁图**：本套件会 `ALTER TABLE sale_order_payments
   * DISABLE TRIGGER`（ACCESS EXCLUSIVE），与对方持有的行锁能绕成跨套件的环，让任一方拿到
   * 「不是自己那个环产生的」40P01。用会话级 advisory lock 把两个套件串起来（需专用连接，
   * 池连接轮换会让锁跟着丢）。两个套件各自只跑几百毫秒，串行代价可以忽略。
   */
  const SUITE_LOCK_KEY = 148137
  /**
   * 锁连接**不能**共用 APP_NAME：它在等 advisory lock 时 `wait_event_type` 也是 'Lock'，
   * 会被本套件自己的 `waitUntilBlocked()` 当成「被测事务已阻塞」而提前放行（多进程跑时）。
   */
  const LOCK_APP_NAME = 'T137PG-suitelock'
  let suiteLockClient = null
  /** 库名校验通过才允许跑清理；before 失败时 node:test 仍会执行 after，用它挡住 DELETE。 */
  let dbVerified = false
  const q = (sql, params) => pool.query(sql, params)

  test.before(async () => {
    await assertNotBusinessDatabase(pool)
    dbVerified = true
    // 与 allocation-lock-order.pg.test.js 互斥（见 SUITE_LOCK_KEY 说明）
    suiteLockClient = new Client({ connectionString: URL, application_name: LOCK_APP_NAME })
    await suiteLockClient.connect()
    await suiteLockClient.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK_KEY])
    await q(`INSERT INTO org_nodes (id, name, type) VALUES ($1,'测试总部','总部') ON CONFLICT (id) DO NOTHING`, [`${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试市场','市场',$2) ON CONFLICT (id) DO NOTHING`, [`${P}MK`, `${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试门店','门店',$2) ON CONFLICT (id) DO NOTHING`, [`${P}ST`, `${P}MK`])
    await q(`INSERT INTO stores (store_id, store_name, org_node_id) VALUES ($1,'测试门店',$1) ON CONFLICT (store_id) DO NOTHING`, [`${P}ST`])
  })

  test.after(async () => {
    // try/finally：任一 DELETE 抛错都不能跳过连接释放，否则连接池吊住 event loop
    // → 整个套件挂起而不是红一条。
    try {
      // 只有确认过不是业务库才允许发 DELETE：before 抛错时 node:test 仍会执行 after，
      // 没有这道守卫就会对一个刚被拒绝的库照发整串清理语句。
      if (dbVerified) {
        await q(`DELETE FROM sale_payment_item_receipts WHERE sale_order_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [LIKE_P])
        // org_nodes / stores 上有 inventory_sync_location_from_org_node trigger 自动建
        // inventory_locations 行，不先删它就会撞外键
        await q(`DELETE FROM inventory_locations WHERE location_id LIKE $1 OR store_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM stores WHERE store_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [LIKE_P])
        await q(`DELETE FROM org_nodes WHERE id LIKE $1`, [LIKE_P])
      }
    } finally {
      await pool.end().catch(() => {})
      if (suiteLockClient) {
        await suiteLockClient.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK_KEY]).catch(() => {})
        await suiteLockClient.end().catch(() => {})
      }
    }
  })

  /** 建一张订单 + 可选的首次支付/储值卡/回款流水，全部不显式带归属日期列（由 trigger 赋值）。 */
  async function seedOrder(id, { orderDate, orderDatetime }) {
    await q(
      `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, total_amount, payment_method, performance_attribution_date)
       VALUES ($1,'测试市场',$2,$3,1000,'微信',$4)`,
      [id, `${P}ST`, orderDatetime, orderDate],
    )
  }
  async function addPayment(id, changeType, { amount = 100, method = '线下', status = '已支付', paidAt = null }) {
    const res = await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
       VALUES ($1,$2,$3,$4,$5,'staff',$6)
       RETURNING id, performance_attribution_date::text AS d`,
      [id, changeType, amount, method, status, paidAt],
    )
    return res.rows[0]
  }
  /**
   * 等到「**本套件的**某个会话正卡在锁上」为止。
   *
   * 原先固定 sleep 500ms：慢机器上被测事务可能在 T1 提交之后才真正执行，
   * 那样即使把 FOR SHARE 删掉测试也会假绿 —— 这类并发用例必须确认对方真的在等。
   *
   * ⚠ 必须按 `application_name` 过滤，只数自己人：`db:test` 是
   * `node --test scripts/__tests__/`，Node 默认并行跑多文件，而
   * `allocation-lock-order.pg.test.js`（issue #148）复用同一个 `ATTRIBUTION_PG_TEST_URL`
   * 也在刻意制造等锁会话。只数「全库有没有人在等锁」会被它误触发 → 这里提前返回 →
   * T1 在 T2 真正排上队之前就 COMMIT，并发时序没建立起来，用例退化成假绿。
   * （T2 走连接池、pid 不固定，所以用 application_name 而不是 pid 白名单。）
   */
  async function waitUntilBlocked(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND application_name = $1
           AND pid <> pg_backend_pid()`,
        [APP_NAME],
      )
      if (rows[0].n > 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('等待超时：没有观察到本套件的会话在等锁，这个并发用例没有真正跑起来')
  }

  const dateOf = async (id, changeType) =>
    (await q(
      `SELECT performance_attribution_date::text AS d FROM sale_order_payments
       WHERE sale_order_id = $1 AND change_type = $2 ORDER BY id LIMIT 1`,
      [id, changeType],
    )).rows[0]?.d

  test('INSERT 不带归属日期列也能落库：BEFORE trigger 先赋值，非空约束不被触发', async () => {
    const id = `${P}A`
    await seedOrder(id, { orderDate: '2026-09-01', orderDatetime: '2026-09-01 10:00:00+08' })
    const first = await addPayment(id, '首次支付', { paidAt: '2026-09-01 10:05:00+08' })
    const card = await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt: '2026-09-01 10:05:00+08' })
    const repay = await addPayment(id, '回款', { paidAt: '2026-09-05 09:00:00+08' })

    assert.equal(first.d, '2026-09-01', '首次支付镜像订单级')
    assert.equal(card.d, '2026-09-01', '同次储值卡跟随主流水')
    assert.equal(repay.d, '2026-09-05', '回款取自身 paid_at')
  })

  test('订单级改期 → AFTER trigger 同步首次支付行与同次卡行，回款行不动', async () => {
    const id = `${P}A`
    await q(
      `UPDATE sale_orders SET performance_attribution_date = '2026-08-28',
              performance_attribution_adjusted_at = NOW(), updated_at = NOW()
       WHERE sale_order_id = $1`,
      [id],
    )
    assert.equal(await dateOf(id, '首次支付'), '2026-08-28')
    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-08-28')
    assert.equal(await dateOf(id, '回款'), '2026-09-05', '回款有自己的归属日期，不跟随订单级')

    // 调整机会标记只记在订单与卡行上；首次支付行不可被单独修改，故不打标
    const marks = (await q(
      `SELECT change_type::text AS t, (performance_attribution_adjusted_at IS NOT NULL) AS marked
       FROM sale_order_payments WHERE sale_order_id = $1 ORDER BY id`,
      [id],
    )).rows
    assert.equal(marks.find((r) => r.t === '首次支付').marked, false)
    assert.equal(marks.find((r) => r.t === '储值卡抵扣').marked, true)
  })

  test('视图 performance_date 直读款项列，与款项行逐行一致', async () => {
    const rows = (await q(
      `SELECT change_type::text AS t, performance_date::text AS d
       FROM sale_order_performance_events WHERE sale_order_id = $1 ORDER BY sale_payment_id`,
      [`${P}A`],
    )).rows
    assert.deepEqual(
      rows.map((r) => [r.t, r.d]),
      [['首次支付', '2026-08-28'], ['储值卡抵扣', '2026-08-28'], ['回款', '2026-09-05']],
    )
  })

  test('商品子项视图也直读同一列：receipt 展开后的 performance_date 跟款项行一致', async () => {
    // 两个视图是分别 CREATE 的，只验订单视图的话，另一个被改回 CASE 也发现不了。
    const id = `${P}A`
    const { rows: items } = await q(
      `INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, product_name, quantity,
                               unit_price, unit_real_price, sale_amount, received, item_direction)
       VALUES ($1, $2, $3, '测试项目', 1, 100, 100, 100, 100, '购买')
       ON CONFLICT (sale_item_id) DO NOTHING
       RETURNING sale_item_id`,
      [`${P}ITEM`, id, `${P}ST`],
    )
    if (items.length === 0) return
    const { rows: pay } = await q(
      `SELECT id FROM sale_order_payments
       WHERE sale_order_id = $1 AND change_type = '回款' LIMIT 1`,
      [id],
    )
    await q(
      `INSERT INTO sale_payment_item_receipts (sale_payment_id, sale_order_id, sale_item_id, amount)
       VALUES ($1, $2, $3, 100)`,
      [pay[0].id, id, `${P}ITEM`],
    )

    const { rows } = await q(
      `SELECT sipe.performance_date::text AS d,
              sop.performance_attribution_date::text AS col
       FROM sale_item_performance_events sipe
       JOIN sale_order_payments sop ON sop.id = sipe.sale_payment_id
       WHERE sipe.sale_item_id = $1 AND sipe.is_legacy_residual = false`,
      [`${P}ITEM`],
    )
    assert.ok(rows.length > 0, '应当有 receipt 展开出来的行')
    for (const r of rows) {
      assert.equal(r.d, r.col, '商品子项视图的 performance_date 必须等于款项行的列值')
    }
  })

  test('卡行先写、主流水后写：写入顺序无关，最终都对齐订单级', async () => {
    const id = `${P}B`
    await seedOrder(id, { orderDate: '2026-09-02', orderDatetime: '2026-09-02 10:00:00+08' })
    const card = await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt: '2026-09-03 11:00:00+08' })
    assert.equal(card.d, '2026-09-03', '还没有主流水可配对时先按自身 paid_at 兜底')

    await addPayment(id, '首次支付', { paidAt: '2026-09-03 11:00:00+08' })
    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-09-02', '主流水写入时反向同步把卡行拉回订单级')
    assert.equal(await dateOf(id, '首次支付'), '2026-09-02')
  })

  test('未入账款项按 created_at 占位（非空），入账那一刻按 paid_at 重算', async () => {
    const id = `${P}C`
    await seedOrder(id, { orderDate: '2026-09-04', orderDatetime: '2026-09-04 10:00:00+08' })
    const pending = await addPayment(id, '回款', { status: '待审批', paidAt: null })
    assert.ok(pending.d, '未入账也必须有值，否则 chk_sop_attribution_date_present 会拦下')

    await q(
      `UPDATE sale_order_payments SET status = '已支付', paid_at = '2026-09-10 08:00:00+08'
       WHERE sale_order_id = $1 AND change_type = '回款'`,
      [id],
    )
    assert.equal(await dateOf(id, '回款'), '2026-09-10')
  })

  test('绕过 trigger 写 NULL 会被 chk_sop_attribution_date_present 拦下', async () => {
    const id = `${P}D`
    await seedOrder(id, { orderDate: '2026-09-05', orderDatetime: '2026-09-05 10:00:00+08' })
    const c = new Client({ connectionString: URL, application_name: APP_NAME })
    await c.connect()
    try {
      await c.query('BEGIN')
      await c.query('ALTER TABLE sale_order_payments DISABLE TRIGGER trg_sale_order_payments_performance_attribution')
      await assert.rejects(
        () => c.query(
          `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at)
           VALUES ($1,'回款',1,'线下','已支付','staff',NOW())`,
          [id],
        ),
        (err) => err.code === '23514', // check_violation
      )
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      await c.end()
    }
  })

  /**
   * 跑一个「T1 持锁未提交 → T2 写入被阻塞 → T1 提交」的时序。
   *
   * try/finally 是必须的：等待或断言失败时若不放掉 T1 的锁，后面每个用例都会卡在它持有的
   * 行锁上，整个套件表现为**挂起**而不是一条红 —— 排查成本差很多（本套件踩过）。
   */
  async function runBlockedConcurrency({ holdLock, write }) {
    const t1 = new Client({ connectionString: URL, application_name: APP_NAME })
    await t1.connect()
    let pending
    try {
      await t1.query('BEGIN')
      await holdLock(t1)
      pending = write()
      await waitUntilBlocked()
      await t1.query('COMMIT')
    } finally {
      await t1.query('ROLLBACK').catch(() => {})
      await t1.end().catch(() => {})
      // 即使上面抛了错也要把 T2 收干净：它可能还阻塞在锁上，
      // 不 settle 的话后续用例会被它的写入污染，还会留下 unhandled rejection。
      await Promise.allSettled([pending])
    }
    await pending
  }

  test('并发：改期未提交时插入首次支付，不会读到旧归属日期（0040 的 FOR SHARE）', async () => {
    const id = `${P}E`
    await seedOrder(id, { orderDate: '2026-09-13', orderDatetime: '2026-09-13 10:00:00+08' })

    await runBlockedConcurrency({
      holdLock: async (t1) => {
        await t1.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE', [id])
        await t1.query(
          `UPDATE sale_orders SET performance_attribution_date = '2026-09-10',
                  performance_attribution_adjusted_at = NOW(), updated_at = NOW()
           WHERE sale_order_id = $1`,
          [id],
        )
      },
      // BEFORE trigger 取 FOR SHARE，会阻塞到 T1 提交
      write: () => addPayment(id, '首次支付', { paidAt: '2026-09-13 11:00:00+08' }),
    })

    assert.equal(
      await dateOf(id, '首次支付'),
      '2026-09-10',
      '首次支付行必须拿到改期后的值；读成 2026-09-13 说明那次 SELECT 又变回不加锁了',
    )
  })

  // 下面两条把并发面铺满：入口不一定先 SELECT FOR UPDATE，写入的也不一定是首次支付行。
  // 曾经用 FOR KEY SHARE 只挡住了「先 FOR UPDATE」那一种，普通 UPDATE 照样脱拍（实测复现过），
  // 所以迁移 0041 用的是 FOR SHARE。
  test('并发：普通 UPDATE（不先 FOR UPDATE）改期 + 首次支付入账 —— 只有 FOR SHARE 挡得住', async () => {
    const id = `${P}G`
    await seedOrder(id, { orderDate: '2026-09-13', orderDatetime: '2026-09-13 10:00:00+08' })

    await runBlockedConcurrency({
      // 关键：不取 FOR UPDATE，直接 UPDATE 非键列 → 该行只被 FOR NO KEY UPDATE 锁住。
      // PG 的行锁矩阵里 FOR KEY SHARE 与 FOR NO KEY UPDATE **不冲突**，只有 FOR SHARE 挡得住。
      holdLock: (t1) => t1.query(
        `UPDATE sale_orders SET performance_attribution_date = '2026-09-10', updated_at = NOW()
         WHERE sale_order_id = $1`,
        [id],
      ),
      write: () => addPayment(id, '首次支付', { paidAt: '2026-09-13 11:00:00+08' }),
    })

    assert.equal(
      await dateOf(id, '首次支付'),
      '2026-09-10',
      '读成 2026-09-13 说明那句 SELECT 的锁又被降回 FOR KEY SHARE 了',
    )
  })

  test('并发：改期 + 同次储值卡行入账 —— 卡行分支读 sale_orders 也要锁', async () => {
    const id = `${P}H`
    await seedOrder(id, { orderDate: '2026-09-13', orderDatetime: '2026-09-13 10:00:00+08' })
    // 先落主流水，这样卡行入账时会走「配对主流水」分支（该分支也读 so 的归属日期）
    await addPayment(id, '首次支付', { paidAt: '2026-09-13 11:00:00+08' })

    await runBlockedConcurrency({
      holdLock: (t1) => t1.query(
        `UPDATE sale_orders SET performance_attribution_date = '2026-09-08', updated_at = NOW()
         WHERE sale_order_id = $1`,
        [id],
      ),
      write: () => addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt: '2026-09-13 11:00:00+08' }),
    })

    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-09-08', '卡行也必须拿到改期后的值')
    assert.equal(await dateOf(id, '首次支付'), '2026-09-08')
  })

  test('全额储值卡订单（没有首次支付主流水）：订单级改期不波及卡行 —— 既有行为，不是回归', async () => {
    const id = `${P}F`
    await seedOrder(id, { orderDate: '2026-09-06', orderDatetime: '2026-09-06 10:00:00+08' })
    // 整单由储值卡抵扣，没有首次支付主流水可配对
    const card = await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt: '2026-09-06 10:05:00+08' })
    assert.equal(card.d, '2026-09-06', '配不上主流水时按自身 paid_at')

    await q(
      `UPDATE sale_orders SET performance_attribution_date = '2026-09-01',
              performance_attribution_adjusted_at = NOW(), updated_at = NOW()
       WHERE sale_order_id = $1`,
      [id],
    )
    assert.equal(
      await dateOf(id, '储值卡抵扣'),
      '2026-09-06',
      'trigger 的卡行 UPDATE 带「同次首次支付」EXISTS，纯卡单命不中 —— 与改造前应用层的 UPDATE 同条件。'
        + '想让它跟随得先定义"纯卡单的归属日该不该随订单走"，那是产品口径问题，不是这里顺手改的。',
    )
  })

  test('同一 paid_at 下有多行主流水：卡行只跟随「首次支付优先、其次 id 最小」的那一行', async () => {
    const id = `${P}I`
    const paidAt = '2026-09-07 10:00:00+08'
    await seedOrder(id, { orderDate: '2026-09-07', orderDatetime: '2026-09-07 09:00:00+08' })
    await addPayment(id, '首次支付', { paidAt })
    await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt })
    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-09-07', '先跟随首次支付（订单级）')

    // 再写一笔 paid_at 完全相同的回款，并给它一个不同的归属日期。
    // 它不是配对胜出者（首次支付优先），不该把卡行覆盖掉 —— 否则次日 I6b 会报假漂移。
    const repay = await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
                                        status, source_end, paid_at, performance_attribution_date)
       VALUES ($1,'回款',1,'线下','已支付','staff',$2,'2026-09-02')
       RETURNING performance_attribution_date::text AS d`,
      [id, paidAt],
    )
    assert.equal(repay.rows[0].d, '2026-09-02', '显式给的归属日期不被 trigger 改写')
    assert.equal(
      await dateOf(id, '储值卡抵扣'),
      '2026-09-07',
      '卡行必须仍跟随首次支付；被回款覆盖成 2026-09-02 就与自检②/I6b 的胜出规则脱节了',
    )
  })

  test('主流水写入顺序颠倒（先回款后首次支付，同 paid_at）：卡行最终仍落在胜出者上', async () => {
    const id = `${P}J`
    const paidAt = '2026-09-09 10:00:00+08'
    await seedOrder(id, { orderDate: '2026-09-09', orderDatetime: '2026-09-09 09:00:00+08' })
    // 先写回款，并给它一个与订单级不同的归属日期
    await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
                                        status, source_end, paid_at, performance_attribution_date)
       VALUES ($1,'回款',1,'线下','已支付','staff',$2,'2026-09-03')`,
      [id, paidAt],
    )
    await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt })
    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-09-03', '此刻唯一的主流水是那笔回款')

    // 再写首次支付（同 paid_at）：它是"首次支付优先"的胜出者，必须把卡行接管过来
    await addPayment(id, '首次支付', { paidAt })
    assert.equal(
      await dateOf(id, '储值卡抵扣'),
      '2026-09-09',
      '首次支付优先级高于回款，卡行要改跟随它（= 自检②/I6b 选出的同一个胜出者）',
    )
  })

  test('同 paid_at 的两笔回款：卡行跟随 id 更小的那笔，后写的大 id 不得覆盖', async () => {
    const id = `${P}L`
    const paidAt = '2026-09-10 10:00:00+08'
    await seedOrder(id, { orderDate: '2026-09-10', orderDatetime: '2026-09-10 09:00:00+08' })
    // 两笔回款同 paid_at、归属日期不同；没有首次支付，所以胜出规则落到"id 更小"这一支
    await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
                                        status, source_end, paid_at, performance_attribution_date)
       VALUES ($1,'回款',1,'线下','已支付','staff',$2,'2026-09-04')`,
      [id, paidAt],
    )
    await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt })
    assert.equal(await dateOf(id, '储值卡抵扣'), '2026-09-04', '跟随第一笔回款')

    await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
                                        status, source_end, paid_at, performance_attribution_date)
       VALUES ($1,'回款',2,'线下','已支付','staff',$2,'2026-09-06')`,
      [id, paidAt],
    )
    assert.equal(
      await dateOf(id, '储值卡抵扣'),
      '2026-09-04',
      '第二笔回款 id 更大、不是胜出者，不该把卡行改成 2026-09-06',
    )
  })

  test('删除员工（FK ON DELETE SET NULL）会触发同步 trigger，但只清调整人、不动归属日期', async () => {
    // 这条路径容易被忽略：`sale_orders.performance_attribution_adjusted_by` 的 FK 是
    // ON DELETE SET NULL，RI 产生的那次 UPDATE **会**命中新 trigger 的 WHEN（它含 adjusted_by）。
    // 实证过：归属日期不受影响，卡行的调整人跟着置空 —— 与卡行自己的 FK 行为一致。
    const id = `${P}M`
    const emp = `${P}EMP`
    await q(
      `INSERT INTO staff_wechat_users (employee_id, name, store_id) VALUES ($1,'待删除店长',$2)
       ON CONFLICT (employee_id) DO NOTHING`,
      [emp, `${P}ST`],
    )
    await q(
      `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime,
                                total_amount, payment_method, performance_attribution_date,
                                performance_attribution_adjusted_at, performance_attribution_adjusted_by)
       VALUES ($1,'测试市场',$2,'2026-09-13 10:00:00+08',500,'微信','2026-09-10',NOW(),$3)`,
      [id, `${P}ST`, emp],
    )
    await addPayment(id, '首次支付', { paidAt: '2026-09-13 11:00:00+08' })
    await addPayment(id, '储值卡抵扣', { method: '储值卡', paidAt: '2026-09-13 11:00:00+08' })

    await q(`DELETE FROM staff_wechat_users WHERE employee_id = $1`, [emp])

    const { rows } = await q(
      `SELECT change_type::text AS t, performance_attribution_date::text AS d,
              performance_attribution_adjusted_by AS by
       FROM sale_order_payments WHERE sale_order_id = $1 ORDER BY id`,
      [id],
    )
    for (const r of rows) {
      assert.equal(r.d, '2026-09-10', `${r.t} 的归属日期不该被员工删除波及`)
      assert.equal(r.by, null, `${r.t} 的调整人应随 FK 置空`)
    }
  })

  test('迁移 0041 的对象都在：两个 trigger + CHECK 约束，且同步 trigger 不是 DEFERRED', async () => {
    const trg = (await q(`
      SELECT t.tgname, t.tgdeferrable, c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND t.tgname IN ('trg_sale_orders_sync_payment_attribution',
                         'trg_sale_order_payments_performance_attribution')
      ORDER BY t.tgname
    `)).rows
    assert.equal(trg.length, 2, '两个 trigger 都必须在')
    const sync = trg.find((r) => r.tgname === 'trg_sale_orders_sync_payment_attribution')
    assert.equal(sync.relname, 'sale_orders')
    // DEFERRED 会把同步推迟到 COMMIT，应用层那次回读就会读到旧值（静默出错数）
    assert.equal(sync.tgdeferrable, false, '同步 trigger 不能是 DEFERRABLE')

    const chk = (await q(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'sale_order_payments'::regclass AND conname = 'chk_sop_attribution_date_present'
    `)).rows
    assert.equal(chk.length, 1)
  })
}
