/**
 * 营业额分配 × 订单改期 的锁序并发回归（issue #148）
 *
 * 背景：项目约定锁序 `sale_orders` → `sale_order_payments`（db/CLAUDE.md）。
 * 手工营业额分配原本反着来（先改款项行、再刷订单汇总），与订单级改期
 * （先 FOR UPDATE 锁订单、再由迁移 0040 的 AFTER trigger 回写款项行）并发时成环 → 40P01。
 *
 * 本套件与词法守护分工（两者缺一不可）：
 *   - 词法：staffApi/__tests__/routes/cross-end-sql-snapshot.test.js 的「事务锁序守护」块
 *     钉住两端源码里**确实写了**锁语句、且排在第一条写语句之前；
 *   - 本文件：在真 PG 上**跑出**两种语句序列，证明修复后不再死锁、修复前必然死锁。
 *     它复刻语句序列而非 import 云函数（db/scripts 层不依赖云函数），所以单靠它挡不住
 *     "代码把锁删了但测试没改"——那由词法守护兜住。
 *
 * 运行（需要一个已 apply 全部 migration 的库；绝不要指向业务库）：
 *
 *   docker run -d --name pg-alloc -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
 *     -p 54399:5432 postgres:16
 *   DATABASE_URL="postgresql://postgres:test@localhost:54399/test" \
 *     bash db/scripts/bootstrap-from-zero.sh
 *   ALLOCATION_PG_TEST_URL="postgresql://postgres:test@localhost:54399/test" \
 *     node --test db/scripts/__tests__/allocation-lock-order.pg.test.js
 *   docker rm -f pg-alloc
 *
 * 未设变量时整个套件 skip，没有本地 PG 的机器上 `npm run db:test` 仍全绿。
 * 复用 ATTRIBUTION_PG_TEST_URL 作为 fallback：两套件测的是同一片区域，通常共用一个临时库。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Client, Pool } = require('pg')

const URL = process.env.ALLOCATION_PG_TEST_URL || process.env.ATTRIBUTION_PG_TEST_URL

/**
 * 业务库库名。三套业务库同端口同库名、只靠 IP 区分，而 IP 黑名单是 fail-open 的
 * （DNS 名、容器网桥、SSH 隧道都能绕过）。所以连上之后问数据库自己叫什么，叫这个就拒绝。
 * 本套件会建数据并制造真实死锁，误连一次就是生产事故。
 */
const BUSINESS_DB_NAME = 'fengyu_wxapp'

/** 夹具前缀，清理时按它删。 */
const P = 'T148PG_'

if (!URL) {
  test('营业额分配锁序并发回归（未设 ALLOCATION_PG_TEST_URL / ATTRIBUTION_PG_TEST_URL，跳过）', { skip: true }, () => {})
} else {
  runSuite()
}

async function assertNotBusinessDatabase(db) {
  const { rows } = await db.query(
    `SELECT current_database() AS db,
            COALESCE(host(inet_server_addr()), 'local') AS addr`,
  )
  const { db: dbName, addr } = rows[0]
  if (dbName === BUSINESS_DB_NAME) {
    throw new Error(
      `拒绝在业务库上运行本套件：current_database()=${dbName} @ ${addr}。`
      + '本套件会建数据并制造真实死锁。',
    )
  }
}

function runSuite() {
  const pool = new Pool({ connectionString: URL, max: 4 })
  const q = (sql, params) => pool.query(sql, params)

  test.before(async () => {
    await assertNotBusinessDatabase(pool)
    await q(`INSERT INTO org_nodes (id, name, type) VALUES ($1,'测试总部','总部') ON CONFLICT (id) DO NOTHING`, [`${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试市场','市场',$2) ON CONFLICT (id) DO NOTHING`, [`${P}MK`, `${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'测试门店','门店',$2) ON CONFLICT (id) DO NOTHING`, [`${P}ST`, `${P}MK`])
    await q(`INSERT INTO stores (store_id, store_name, org_node_id) VALUES ($1,'测试门店',$1) ON CONFLICT (store_id) DO NOTHING`, [`${P}ST`])
  })

  test.after(async () => {
    await q(`DELETE FROM sale_payment_item_receipts WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [`${P}%`])
    // org_nodes / stores 上的 inventory_sync_location_from_org_node trigger 会自动建
    // inventory_locations 行，不先删会撞外键
    await q(`DELETE FROM inventory_locations WHERE location_id LIKE $1 OR store_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM stores WHERE store_id LIKE $1`, [`${P}%`])
    await q(`DELETE FROM org_nodes WHERE id LIKE $1`, [`${P}%`])
    await pool.end()
  })

  /**
   * 建一张订单 + 一笔已支付的首次支付流水（改期时 trigger 要回写的就是它）。
   * 支付方式用「线下」：约束 chk_sop_method_txn 要求微信/支付宝必须带 external_txn_id，
   * 而本套件只关心锁，不关心支付渠道。
   */
  async function seedOrderWithPayment(id) {
    await q(
      `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, total_amount, payment_method, performance_attribution_date)
       VALUES ($1,'测试市场',$2,'2026-09-13 10:00:00+08',1000,'线下','2026-09-13')`,
      [id, `${P}ST`],
    )
    const res = await q(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, paid_at, allocation_status)
       VALUES ($1,'首次支付',1000,'线下','已支付','staff','2026-09-13 11:00:00+08','待分配')
       RETURNING id`,
      [id],
    )
    return res.rows[0].id
  }

  /** 等到「有会话正卡在锁上」为止；固定 sleep 在慢机器上会让并发用例假绿。 */
  async function waitUntilBlocked(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND pid <> pg_backend_pid()`,
      )
      if (rows[0].n > 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('等待超时：没有观察到任何会话在等锁，这个并发用例没有真正跑起来')
  }

  /**
   * 交错跑「改期」(T1) 与「分配」(T2) 两个事务，返回各自的结局。
   *
   * @param {boolean} lockOrderFirst 分配事务是否先取订单行锁（true = 修复后，false = 修复前）
   * @returns {Promise<{t1: Error|null, t2: Error|null}>}
   */
  async function raceAttributionVsAllocation(orderId, paymentId, lockOrderFirst) {
    const t1 = new Client({ connectionString: URL })   // 改期
    const t2 = new Client({ connectionString: URL })   // 分配
    await t1.connect()
    await t2.connect()

    let t1Err = null
    let t2Err = null
    try {
      await t1.query('BEGIN')
      await t2.query('BEGIN')

      // T1 第 1 步：锁订单（与两端 updatePerformanceAttribution 一致）
      await t1.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE', [orderId])

      // T2 第 1 步：修复后先锁订单（这一步会直接排队等 T1，环从此不成立）；
      // 修复前则直接去改款项行，拿住 payments 锁。
      const t2Step1 = lockOrderFirst
        ? t2.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE', [orderId])
            .then(() => t2.query(
              `UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1`, [paymentId]))
        : t2.query(
            `UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1`, [paymentId])

      if (lockOrderFirst) {
        // T2 卡在订单行锁上，等它真的排上队再推进 T1
        await waitUntilBlocked()
      } else {
        // T2 拿到了款项行锁；等它落定后 T1 再去碰同一行，才能稳定构造出环
        await t2Step1
      }

      // T1 第 2 步：改期 → AFTER trigger 回写首次支付行（要 payments 锁）
      const t1Step2 = t1.query(
        `UPDATE sale_orders
            SET performance_attribution_date = '2026-09-10',
                performance_attribution_adjusted_at = NOW(),
                updated_at = NOW()
          WHERE sale_order_id = $1`,
        [orderId],
      ).catch((e) => { t1Err = e })

      if (!lockOrderFirst) {
        // T1 卡在 T2 持有的款项行锁上；此时 T2 再去刷订单汇总 → 闭环
        await waitUntilBlocked()
        const t2Step2 = t2.query(
          `UPDATE sale_orders SET allocation_status = '已分配', updated_at = NOW() WHERE sale_order_id = $1`,
          [orderId],
        ).catch((e) => { t2Err = e })
        await Promise.all([t1Step2, t2Step2])
      } else {
        // T1 不会被挡（T2 还没碰 payments），提交后 T2 才被放行
        await t1Step2
        await t1.query('COMMIT')
        await t2Step1.catch((e) => { t2Err = e })
        await t2.query(
          `UPDATE sale_orders SET allocation_status = '已分配', updated_at = NOW() WHERE sale_order_id = $1`,
          [orderId],
        ).catch((e) => { t2Err = e })
      }

      // 收尾：谁没被中止就提交，被中止的 ROLLBACK（PG 允许对已中止事务 ROLLBACK）
      await t1.query(t1Err ? 'ROLLBACK' : 'COMMIT').catch(() => {})
      await t2.query(t2Err ? 'ROLLBACK' : 'COMMIT').catch(() => {})
    } finally {
      // 必须无条件断开：留着未提交事务会让后续用例全卡死，表现为整个套件挂起而不是一条红
      await t1.end().catch(() => {})
      await t2.end().catch(() => {})
    }
    return { t1: t1Err, t2: t2Err }
  }

  const isDeadlock = (e) => Boolean(e) && e.code === '40P01'

  test('修复前的语句序列（分配不先锁订单）：与订单改期并发必然 40P01 —— 证明本用例真能抓到环', async () => {
    const id = `${P}BEFORE`
    const paymentId = await seedOrderWithPayment(id)

    const { t1, t2 } = await raceAttributionVsAllocation(id, paymentId, false)

    assert.ok(
      isDeadlock(t1) || isDeadlock(t2),
      `期望两个事务之一被 PG 以 40P01 中止，实际 t1=${t1 && t1.code}/${t1 && t1.message} t2=${t2 && t2.code}/${t2 && t2.message}。`
      + '没死锁说明这个用例没有构造出真实的环，那么下面那条"修复后不死锁"就是假绿。',
    )
  })

  test('修复后的语句序列（分配先锁订单）：与订单改期并发不再死锁，两个事务都跑完', async () => {
    const id = `${P}AFTER`
    const paymentId = await seedOrderWithPayment(id)

    const { t1, t2 } = await raceAttributionVsAllocation(id, paymentId, true)

    assert.equal(isDeadlock(t1), false, `改期事务不应死锁，实际：${t1 && t1.message}`)
    assert.equal(isDeadlock(t2), false, `分配事务不应死锁，实际：${t2 && t2.message}`)
    assert.equal(t1, null, `改期事务不应报错，实际：${t1 && t1.message}`)
    assert.equal(t2, null, `分配事务不应报错，实际：${t2 && t2.message}`)
  })

  test('修复后两事务串行落定：改期值同步到款项行，分配状态也写成功（没有一方被悄悄回滚）', async () => {
    const id = `${P}RESULT`
    const paymentId = await seedOrderWithPayment(id)

    await raceAttributionVsAllocation(id, paymentId, true)

    const { rows } = await q(
      `SELECT so.performance_attribution_date::text AS order_date,
              sop.performance_attribution_date::text AS payment_date,
              sop.allocation_status::text            AS payment_alloc,
              so.allocation_status::text             AS order_alloc
         FROM sale_orders so
         JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
        WHERE so.sale_order_id = $1 AND sop.id = $2`,
      [id, paymentId],
    )
    assert.equal(rows[0].order_date, '2026-09-10', '改期未生效')
    assert.equal(rows[0].payment_date, '2026-09-10', '款项行未被 trigger 同步（迁移 0040）')
    assert.equal(rows[0].payment_alloc, '已分配', '分配状态未落库')
    assert.equal(rows[0].order_alloc, '已分配', '订单汇总未刷新')
  })
}
