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
 *
 * ⚠ **必须扛住与兄弟套件同库并行**：`db:test` 是 `node --test scripts/__tests__/`，Node 默认并行跑多文件，
 * 而 `attribution-trigger.pg.test.js` 吃同一个 fallback 变量、也在制造等锁会话、还会在事务里
 * `ALTER TABLE sale_order_payments DISABLE TRIGGER`（持 ACCESS EXCLUSIVE 到 ROLLBACK）。因此：
 *   1. 等锁轮询**按本用例两个连接的 backend pid 过滤**，不能数「全库有没有人在等锁」——
 *      否则会被兄弟套件的等待误触发，交错编排没真正建立，"修复后不死锁"退化成同义反复的假绿；
 *   2. 等锁预算放宽到 30s，容忍被兄弟套件的表级锁短时挡住；
 *   3. 夹具**每条用例用独立 order id**，且 seed 前先按 id 清理，保证可重入。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Client, Pool } = require('pg')

const URL = process.env.ALLOCATION_PG_TEST_URL || process.env.ATTRIBUTION_PG_TEST_URL

/**
 * 业务库名单。三套业务库同端口同库名、只靠 IP 区分，而 IP 黑名单是 fail-open 的
 * （DNS 名、容器网桥、SSH 隧道都能绕过）。所以连上之后问数据库自己叫什么，叫这些就拒绝。
 * `fengyu_e2e` 也在内：它与 dev 业务库同机，只是靠库名隔离，同样不该被拿来制造真实死锁。
 * 本套件会建数据并制造死锁，误连一次就是生产事故。
 */
const FORBIDDEN_DB_NAMES = ['fengyu_wxapp', 'fengyu_e2e']

/** 夹具前缀，清理时按它删。注意 `_` 是 LIKE 通配符，拼 LIKE 模式时要转义。 */
const P = 'T148PG_'
/** LIKE 模式：把前缀里的 `_` 转义，避免 `T148PGx...` 之类被误删。 */
const LIKE_P = `${P.replace(/_/g, '\\_')}%`

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
  if (FORBIDDEN_DB_NAMES.includes(dbName)) {
    throw new Error(
      `拒绝在业务库上运行本套件：current_database()=${dbName} @ ${addr}。`
      + '本套件会建数据并制造真实死锁。',
    )
  }
}

function runSuite() {
  const pool = new Pool({ connectionString: URL, max: 4 })
  const q = (sql, params) => pool.query(sql, params)
  /** 库名校验通过才允许跑夹具；before 失败时 node:test 仍会执行 after，用它挡住清理语句。 */
  let dbVerified = false

  /**
   * 两个真库套件（本文件 + `attribution-trigger.pg.test.js`）共用同一个库时**必须串行**。
   *
   * 光按 pid / application_name 过滤等锁观察是不够的 —— 那只解决「看错了谁在等」，
   * 不隔离**真实的锁图**：本套件的对照组持着 `sale_order_payments` 的 ROW EXCLUSIVE，
   * 而兄弟套件会 `ALTER TABLE sale_order_payments DISABLE TRIGGER`（要 ACCESS EXCLUSIVE），
   * 三者可以绕成一个跨套件的环 —— 那时本用例拿到的 40P01 **不是目标锁环产生的**，
   * 断言照样绿，结论却是假的；也可能反过来把兄弟套件判死。
   *
   * 用会话级 advisory lock 让两个套件互斥（必须用**专用连接**，池连接会轮换导致锁跟着丢）。
   * 只串行这两个真库套件，`db:test` 里其余纯逻辑套件仍然并行。
   */
  const SUITE_LOCK_KEY = 148137
  let suiteLockClient = null

  /** 按前缀清掉本套件的全部夹具行（可重入用：before 与 after 共用）。 */
  async function purgeFixtures() {
    await q(`DELETE FROM sale_payment_item_receipts WHERE sale_order_id LIKE $1`, [LIKE_P])
    await q(`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [LIKE_P])
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [LIKE_P])
    await q(`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [LIKE_P])
    // org_nodes / stores 上的 inventory_sync_location_from_org_node trigger 会自动建
    // inventory_locations 行，不先删会撞外键
    await q(`DELETE FROM inventory_locations WHERE location_id LIKE $1 OR store_id LIKE $1`, [LIKE_P])
    await q(`DELETE FROM stores WHERE store_id LIKE $1`, [LIKE_P])
    await q(`DELETE FROM org_nodes WHERE id LIKE $1`, [LIKE_P])
  }

  test.before(async () => {
    await assertNotBusinessDatabase(pool)
    dbVerified = true
    // 与兄弟套件互斥（见 SUITE_LOCK_KEY 说明）。取不到就一直等——两个套件都只跑几百毫秒。
    suiteLockClient = new Client({ connectionString: URL })
    await suiteLockClient.connect()
    await suiteLockClient.query('SELECT pg_advisory_lock($1)', [SUITE_LOCK_KEY])
    // 可重入：上一次跑若被 Ctrl-C / 进程崩溃打断，after 不会执行，残留夹具会让 seed 撞唯一键，
    // 报出与锁序毫不相关的 23505。开场先清一次。
    await purgeFixtures()
    // ⚠ 夹具名称必须与兄弟套件（attribution-trigger.pg.test.js 的 T137PG_）**全局不重名**：
    // `stores.store_name` 是全局 UNIQUE，两套件在同一个临时库并行跑时，共用「测试门店」会直接 23505，
    // 报出与锁序毫不相关的错误。（org_nodes 是 UNIQUE(parent_id, name)，各自挂在自己的 HQ 下不冲突，
    // 但这里一并加上标识，便于在库里一眼认出归属。）
    await q(`INSERT INTO org_nodes (id, name, type) VALUES ($1,'锁序#148总部','总部') ON CONFLICT (id) DO NOTHING`, [`${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'锁序#148市场','市场',$2) ON CONFLICT (id) DO NOTHING`, [`${P}MK`, `${P}HQ`])
    await q(`INSERT INTO org_nodes (id, name, type, parent_id) VALUES ($1,'锁序#148门店','门店',$2) ON CONFLICT (id) DO NOTHING`, [`${P}ST`, `${P}MK`])
    await q(`INSERT INTO stores (store_id, store_name, org_node_id) VALUES ($1,'锁序#148门店',$1) ON CONFLICT (store_id) DO NOTHING`, [`${P}ST`])
  })

  test.after(async () => {
    // try/finally：任一 DELETE 抛错（新外键、并发清理）都不能跳过连接释放，
    // 否则连接池吊住 event loop → 整个套件挂起，而不是红一条。
    try {
      if (dbVerified) await purgeFixtures()
    } finally {
      await pool.end().catch(() => {})
      // 断开即释放 advisory lock；显式 unlock 只是让意图明确
      if (suiteLockClient) {
        await suiteLockClient.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK_KEY]).catch(() => {})
        await suiteLockClient.end().catch(() => {})
      }
    }
  })

  /**
   * 建一张订单 + 一笔已支付的首次支付流水（改期时 trigger 要回写的就是它）。
   * 支付方式用「线下」：约束 chk_sop_method_txn 要求微信/支付宝必须带 external_txn_id，
   * 而本套件只关心锁，不关心支付渠道。
   */
  async function seedOrderWithPayment(id) {
    // 逐 id 清理，保证单条用例可重入（即便上次跑到一半挂掉）
    await q(`DELETE FROM sale_order_payments WHERE sale_order_id = $1`, [id])
    await q(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [id])
    await q(
      `INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, total_amount, payment_method, performance_attribution_date)
       VALUES ($1,'锁序#148市场',$2,'2026-09-13 10:00:00+08',1000,'线下','2026-09-13')`,
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

  /**
   * 等到「**本用例的**某个连接正卡在锁上」为止。
   *
   * 固定 sleep 在慢机器上会让并发用例假绿；而只数「全库有没有会话在等锁」同样不行——
   * 兄弟套件 attribution-trigger.pg.test.js 也在刻意制造等锁会话，会让这里立刻返回。
   * 所以按本用例两个连接的 backend pid 过滤。
   */
  async function waitUntilBlocked(pids, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND pid = ANY($1::int[])`,
        [pids],
      )
      if (rows[0].n > 0) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(
      `等待超时：本用例的连接（pid ${pids.join(',')}）没有一个在等锁，这个并发用例没有真正跑起来`,
    )
  }

  const backendPid = async (client) =>
    Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)

  /**
   * 起两个独立连接、各自 BEGIN，跑一段并发编排，收尾无条件断开。
   *
   * 把「连接 / 取 pid / 调 deadlock_timeout / 断开」这套样板收到一处，
   * 两个场景函数就只剩真正有差异的时序。**编排本身刻意不抽象**：三条用例的价值
   * 正在于各自不同的交错顺序，套进统一模板反而看不出差别。
   *
   * `track(p)` 登记"可能还悬着"的 promise：就地吞掉 rejection，并在 finally 里 settle。
   * 不这么做的话，中途抛错跳到 finally 断连时它会以 "Connection terminated" 变成
   * unhandled rejection —— Node 默认 `--unhandled-rejections=throw`，**整个 db:test 进程会崩**，
   * 而不是红一条。（兄弟套件 attribution-trigger.pg.test.js 踩过同一个坑。）
   *
   * PG 默认 `deadlock_timeout=1s`：检测器要等满这段时间才去查环，「修复前必死锁」那条
   * 因此恒定耗时 ~1s，占整个套件一半以上。调到 150ms 只影响**多久开始检测**，
   * 不影响是否成环，对结论没有任何削弱。`SET LOCAL` 随事务结束自动失效。
   */
  async function withTwoSessions(run) {
    const a = new Client({ connectionString: URL })
    const b = new Client({ connectionString: URL })
    const tracked = []
    const track = (p) => { p.catch(() => {}); tracked.push(p); return p }
    try {
      // connect 也放进 try：在 try 之外时，b 连接失败会让 a 的 socket 永不释放
      await a.connect()
      await b.connect()
      const pids = [await backendPid(a), await backendPid(b)]
      // ⚠ 必须在 BEGIN **之前**、且用会话级 SET（不是 SET LOCAL）：
      // `deadlock_timeout` 是 superuser-only 参数，普通账号跑会报 42501。放在事务里失败的话，
      // 整个事务会进入 aborted 状态、后续语句全报 25P02 —— 一个纯提速的调参不该有能力搞挂套件。
      // 放事务外则失败无害，只是退回默认 1s（套件慢 ~0.85s）。连接断开即失效。
      await a.query("SET deadlock_timeout = '150ms'").catch(() => {})
      await b.query("SET deadlock_timeout = '150ms'").catch(() => {})
      await a.query('BEGIN')
      await b.query('BEGIN')
      return await run({ a, b, pids, track })
    } finally {
      // ⚠ 顺序不能反：**先断开，再 settle**。
      // 反过来写的话，`tracked` 里若有 query 正卡在对方尚未释放的行锁上，
      // `allSettled` 会永久等待、连 `end()` 都执行不到 → 整个 db:test 挂起（而不是红一条）。
      // `end()` 会让在途 query 立刻以 "Connection terminated" reject，allSettled 随即返回。
      await a.end().catch(() => {})
      await b.end().catch(() => {})
      await Promise.allSettled(tracked)
    }
  }

  /**
   * 交错跑「改期」(T1) 与「分配」(T2) 两个事务，返回各自的结局。
   *
   * @param {boolean} lockOrderFirst 分配事务是否先取订单行锁（true = 修复后，false = 修复前）
   * @returns {Promise<{t1: Error|null, t2: Error|null}>}
   */
  async function raceAttributionVsAllocation(orderId, paymentId, lockOrderFirst) {
    return withTwoSessions(async ({ a: t1, b: t2, pids, track }) => {
      let t1Err = null
      let t2Err = null

      // T1 第 1 步：锁订单（与两端 updatePerformanceAttribution 一致）
      await t1.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE', [orderId])

      // T2 第 1 步：修复后先锁订单（这一步会直接排队等 T1，环从此不成立）；
      // 修复前则直接去改款项行，拿住 payments 锁。
      // 锁强度与实现保持一致：分配侧用 FOR NO KEY UPDATE（放行 FK 子表 INSERT，
      // 同时仍与改期的 FOR UPDATE 冲突，足以消环）。
      const t2Step1 = track(lockOrderFirst
        ? t2.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR NO KEY UPDATE', [orderId])
            .then(() => t2.query(
              `UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1`, [paymentId]))
        : t2.query(
            `UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1`, [paymentId]))

      if (lockOrderFirst) {
        // T2 卡在订单行锁上，等它真的排上队再推进 T1
        await waitUntilBlocked(pids)
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
        await waitUntilBlocked(pids)
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
        await t2.query('COMMIT').catch((e) => { t2Err = t2Err || e })
      }

      // 收尾：T1 在 lockOrderFirst 分支已提交过，这里只处理尚未结束的事务，
      // 避免对已结束事务重复 COMMIT 而收到 "no transaction in progress" 噪音。
      if (!lockOrderFirst) {
        await t1.query(t1Err ? 'ROLLBACK' : 'COMMIT').catch(() => {})
        await t2.query(t2Err ? 'ROLLBACK' : 'COMMIT').catch(() => {})
      }
      return { t1: t1Err, t2: t2Err }
    })
  }

  /**
   * 反向到达顺序：**分配先拿到订单锁**，改期随后到达。
   *
   * 上面那个编排里改期总是先到，分配在第一条就被挡住 —— 验证的是「排队而不是死锁」。
   * 但真实并发两个方向都会发生，而且这个方向才是分配事务**持锁并继续写 payments** 的场景：
   * 分配持 so 锁 → 写 payments → 刷 so 汇总；改期在 so 锁上排队。若哪天分配事务里
   * 又混进「先写 payments 再取 so 锁」的语句，这条会抓到。
   */
  async function raceAllocationFirst(orderId, paymentId) {
    return withTwoSessions(async ({ a: tAlloc, b: tAttr, pids, track }) => {
      let allocErr = null
      let attrErr = null

      // 分配先到：取订单锁（修复后的第一条语句），再写款项行
      await tAlloc.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR NO KEY UPDATE', [orderId])
      await tAlloc.query(`UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1`, [paymentId])

      // 改期随后到达，应在订单锁上排队（而不是与分配互等）
      const attrStep = track(
        tAttr.query('SELECT 1 FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE', [orderId]),
      )
      await waitUntilBlocked(pids)

      // 分配继续刷订单汇总并提交 —— 若锁序有问题，这里会与 tAttr 互等
      await tAlloc.query(
        `UPDATE sale_orders SET allocation_status = '已分配', updated_at = NOW() WHERE sale_order_id = $1`,
        [orderId],
      ).catch((e) => { allocErr = e })
      await tAlloc.query(allocErr ? 'ROLLBACK' : 'COMMIT').catch(() => {})

      // 分配放手后，改期才拿到锁并完成
      await attrStep.catch((e) => { attrErr = e })
      await tAttr.query(
        `UPDATE sale_orders SET performance_attribution_date = '2026-09-10',
                performance_attribution_adjusted_at = NOW(), updated_at = NOW()
          WHERE sale_order_id = $1`,
        [orderId],
      ).catch((e) => { attrErr = attrErr || e })
      await tAttr.query(attrErr ? 'ROLLBACK' : 'COMMIT').catch(() => {})
      return { alloc: allocErr, attr: attrErr }
    })
  }

  const isDeadlock = (e) => Boolean(e) && e.code === '40P01'
  const describeErr = (e) => (e ? `${e.code}/${e.message}` : 'null')

  test('修复前的语句序列（分配不先锁订单）：与订单改期并发必然 40P01 —— 证明本用例真能抓到环', async () => {
    const id = `${P}BEFORE`
    const paymentId = await seedOrderWithPayment(id)

    const { t1, t2 } = await raceAttributionVsAllocation(id, paymentId, false)

    assert.ok(
      isDeadlock(t1) || isDeadlock(t2),
      `期望两个事务之一被 PG 以 40P01 中止，实际 t1=${describeErr(t1)} t2=${describeErr(t2)}。`
      + '没死锁说明这个用例没有构造出真实的环，那么下面那条"修复后不死锁"就是假绿。',
    )
  })

  test('修复后 · 改期先到：分配在订单锁上排队而不是与它互等，两个事务都跑完', async () => {
    const id = `${P}AFTER`
    const paymentId = await seedOrderWithPayment(id)

    // 注：这条里分配必然要等改期提交后才推进——这正是锁序修复的效果（串行化而非成环）。
    // `waitUntilBlocked` 已确认分配确实卡在锁上排队，不是「还没开始跑」。
    const { t1, t2 } = await raceAttributionVsAllocation(id, paymentId, true)

    assert.equal(isDeadlock(t1), false, `改期事务不应死锁，实际：${describeErr(t1)}`)
    assert.equal(isDeadlock(t2), false, `分配事务不应死锁，实际：${describeErr(t2)}`)
    assert.equal(t1, null, `改期事务不应报错，实际：${describeErr(t1)}`)
    assert.equal(t2, null, `分配事务不应报错，实际：${describeErr(t2)}`)
  })

  test('修复后 · 分配先到：分配持订单锁继续写款项行与汇总，改期排队，双方都不死锁', async () => {
    const id = `${P}ALLOCFIRST`
    const paymentId = await seedOrderWithPayment(id)

    const { alloc, attr } = await raceAllocationFirst(id, paymentId)

    assert.equal(isDeadlock(alloc), false, `分配事务不应死锁，实际：${describeErr(alloc)}`)
    assert.equal(isDeadlock(attr), false, `改期事务不应死锁，实际：${describeErr(attr)}`)
    assert.equal(alloc, null, `分配事务不应报错，实际：${describeErr(alloc)}`)
    assert.equal(attr, null, `改期事务不应报错，实际：${describeErr(attr)}`)
  })

  test('修复后两事务串行落定：改期值同步到款项行，分配状态也写成功（没有一方被悄悄回滚）', async () => {
    const id = `${P}RESULT`
    const paymentId = await seedOrderWithPayment(id)

    // 不丢弃返回值：任一事务出错时直接报出真实 PG 错误，
    // 而不是让它以「改期未生效」这种下游断言的形式出现、把根因吞掉。
    const { t1, t2 } = await raceAttributionVsAllocation(id, paymentId, true)
    assert.equal(t1, null, `改期事务不应报错，实际：${describeErr(t1)}`)
    assert.equal(t2, null, `分配事务不应报错，实际：${describeErr(t2)}`)

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
    assert.equal(rows.length, 1, '夹具行不见了：订单或款项行被并发清理？')
    assert.equal(rows[0].order_date, '2026-09-10', '改期未生效')
    assert.equal(rows[0].payment_date, '2026-09-10', '款项行未被 trigger 同步（迁移 0040）')
    assert.equal(rows[0].payment_alloc, '已分配', '分配状态未落库')
    assert.equal(rows[0].order_alloc, '已分配', '订单汇总未刷新')
  })
}
