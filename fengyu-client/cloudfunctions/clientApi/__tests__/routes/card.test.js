/**
 * 充值卡路由测试
 * 覆盖：list（跨店共享，一户一账户）、balance（按 user_id 查余额）、history（交易记录+分页+所有权校验）
 */

const pg = globalThis.__mocks__.pg
const { createBoundCtx, createCtx, sqlConjuncts } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(require.cache).forEach(key => {
    if (key.includes('/routes/card') || key.includes('/middleware/auth')) delete require.cache[key]
  })
  routes = require('../../routes/card')
})

describe('card.list', () => {
  test('返回充值卡列表（无 storeId/storeName 字段）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: 500, created_at: '2025-01-01' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.cards).toHaveLength(1)
    expect(ctx.result.cards[0].cardId).toBe('card-1')
    expect(ctx.result.cards[0].balance).toBe(500)
    expect(ctx.result.cards[0].createdAt).toBe('2025-01-01')
    expect(ctx.result.cards[0].storeId).toBeUndefined()
    expect(ctx.result.cards[0].storeName).toBeUndefined()
  })

  test('无充值卡返回空数组', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(ctx.result.cards).toEqual([])
  })

  test('使用 userId 查询', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({}, { userId: 'user-abc' })
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][1]).toEqual(['user-abc'])
  })

  test('按创建时间倒序排列', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('ORDER BY pc.created_at DESC')
  })

  test('SQL 不含 LEFT JOIN stores（跨店共享，不取 store_name）', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(pg.query.mock.calls[0][0]).not.toContain('LEFT JOIN stores')
    expect(pg.query.mock.calls[0][0]).not.toContain('store_id')
  })

  test('PG numeric 字符串 balance 转为 number（避免前端 toFixed 报错）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '7378.52', created_at: '2025-01-01' },
    ])

    const ctx = createBoundCtx({})
    await routes.list(ctx)

    expect(typeof ctx.result.cards[0].balance).toBe('number')
    expect(ctx.result.cards[0].balance).toBe(7378.52)
  })
})

describe('card.balance', () => {
  test('无卡返回 balance=0, cardId=null', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(ctx.result).toEqual({ balance: 0, cardId: null })
  })

  test('有卡按 user_id 查出余额', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '320.50' },
    ])

    const ctx = createBoundCtx({}, { userId: 'user-xyz' })
    await routes.balance(ctx)

    expect(ctx.result.cardId).toBe('card-1')
    expect(ctx.result.balance).toBe(320.5)
    expect(typeof ctx.result.balance).toBe('number')

    // 参数化查询，SQL 按 user_id
    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('user_id = $1')
    expect(sql).not.toContain('store_id')
    expect(params).toEqual(['user-xyz'])
  })

  test('未绑定手机号 → PHONE_REQUIRED', async () => {
    const ctx = createCtx({
      payload: {},
      auth: { phone: null },
    })
    await expect(routes.balance(ctx)).rejects.toThrow(/PHONE_REQUIRED/)
  })

  test('不接受 storeId 参数（payload 有 storeId 被忽略）', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '100' },
    ])

    const ctx = createBoundCtx({ storeId: 'any-store' }, { userId: 'user-1' })
    await routes.balance(ctx)

    // SQL 只按 user_id 查询，不会把 storeId 作为参数
    const params = pg.query.mock.calls[0][1]
    expect(params).toEqual(['user-1'])
    expect(ctx.result.balance).toBe(100)
  })

  test('返回的 balance 是 number 而非字符串', async () => {
    pg.query.mockResolvedValueOnce([
      { card_id: 'card-1', balance: '0.00' },
    ])

    const ctx = createBoundCtx({})
    await routes.balance(ctx)

    expect(typeof ctx.result.balance).toBe('number')
    expect(ctx.result.balance).toBe(0)
  })
})

describe('card.history', () => {
  test('返回交易记录', async () => {
    // 第一次查询：所有权校验
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    // 第二次查询：交易记录
    pg.query.mockResolvedValueOnce([
      { id: 'ct-1', type: '充值', amount: 500, ref_order_id: null, created_at: '2025-06-01' },
      { id: 'ct-2', type: '消费', amount: -100, ref_order_id: 'ord-1', created_at: '2025-06-02' },
    ])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(ctx.result.records).toHaveLength(2)
    expect(ctx.result.records[0].type).toBe('充值')
    expect(ctx.result.records[1].amount).toBe(-100)
  })

  test('缺少 cardId → INVALID_PARAMS', async () => {
    const ctx = createBoundCtx({})
    await expect(routes.history(ctx)).rejects.toThrow(/INVALID_PARAMS.*cardId/)
  })

  test('卡不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([]) // 所有权校验返回空

    const ctx = createBoundCtx({ cardId: 'nonexistent' })
    await expect(routes.history(ctx)).rejects.toThrow(/INVALID_PARAMS.*充值卡不存在/)
  })

  test('校验卡的所有权（user_id 匹配）', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' }, { userId: 'user-xyz' })
    await routes.history(ctx)

    const [sql, params] = pg.query.mock.calls[0]
    expect(sql).toContain('card_id = $1')
    expect(sql).toContain('user_id = $2')
    expect(params).toEqual(['card-1', 'user-xyz'])
  })

  test('分页参数正确', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1', page: 2, pageSize: 10 })
    await routes.history(ctx)

    const params = pg.query.mock.calls[1][1]
    expect(params).toEqual(['card-1', 10, 10]) // cardId, pageSize, offset
  })

  test('默认分页', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    const params = pg.query.mock.calls[1][1]
    expect(params).toEqual(['card-1', 20, 0])
  })

  test('仅查询最近6个月记录', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    const sql = pg.query.mock.calls[1][0]
    expect(sql).toContain("'6 months'")
  })

  test('无交易记录返回空数组', async () => {
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(ctx.result.records).toEqual([])
  })

  test('PG numeric 字符串 amount 转为 number（避免前端 toFixed 报错）', async () => {
    // node-postgres 将 numeric 类型返回为字符串，必须在云函数端转数字
    pg.query.mockResolvedValueOnce([{ card_id: 'card-1' }])
    pg.query.mockResolvedValueOnce([
      { id: 'ct-1', type: '充值', amount: '500.00', ref_order_id: null, created_at: '2025-06-01' },
      { id: 'ct-2', type: '消费', amount: '-120.50', ref_order_id: 'ord-1', created_at: '2025-06-02' },
    ])

    const ctx = createBoundCtx({ cardId: 'card-1' })
    await routes.history(ctx)

    expect(typeof ctx.result.records[0].amount).toBe('number')
    expect(ctx.result.records[0].amount).toBe(500)
    expect(ctx.result.records[1].amount).toBe(-120.5)
  })
})

/**
 * `_closeExpiredPendingByUser`（充值时顺带关掉过期待支付单）的 CAS 门。
 *
 * 这是**第二条**会把待支付单置「已关闭」的路径，守卫与 order.closeExpiredOrder 同源，
 * 但释放侧原本漏了一道门：CAS UPDATE 影响 0 行时仍无条件释放优惠券。
 * 由于上面的 SELECT 没有行锁，选出来之后、CAS 之前这张单完全可能被并发支付掉；
 * 那时把**已经用于支付**的券退回「未使用」，券可再次抵扣 —— 直接的资金损失。
 * （issue #215 双谱系评审 round-4 报出的既有 P0，顺带修掉。）
 */
describe('card 充值路径的过期单清理 — 券释放必须跟着 CAS 走', () => {
  /** 直接驱动 _closeExpiredPendingByUser，返回它执行过的 SQL 列表 */
  async function runCleanup({ closeRowCount }) {
    const executed = []
    const clientQuery = vi.fn(async (sql) => {
      executed.push(sql)
      if (/SELECT sale_order_id FROM sale_orders/.test(sql)) {
        return { rows: [{ sale_order_id: 'FY-EXPIRED' }], rowCount: 1 }
      }
      if (/UPDATE sale_orders SET status = '已关闭'/.test(sql)) {
        return { rows: [], rowCount: closeRowCount }
      }
      return { rows: [], rowCount: 0 }
    })
    await routes._closeExpiredPendingByUser({ query: clientQuery }, 'user-001')
    return executed
  }

  test('CAS 命中（关成了）→ 释放该单的优惠券', async () => {
    const executed = await runCleanup({ closeRowCount: 1 })
    expect(executed.some((s) => /UPDATE sale_orders SET status = '已关闭'/.test(s))).toBe(true)
    expect(executed.some((s) => /UPDATE user_coupons/.test(s))).toBe(true)
  })

  test('CAS 落空（单子已被并发支付）→ 绝不释放优惠券', async () => {
    const executed = await runCleanup({ closeRowCount: 0 })
    expect(executed.some((s) => /UPDATE sale_orders SET status = '已关闭'/.test(s))).toBe(true)
    // 这张单此刻已经是「已支付」，那张券正被它消费着，退回去就能再花一次
    expect(executed.some((s) => /UPDATE user_coupons/.test(s))).toBe(false)
  })
})

/**
 * 充值路径的过期单清理，其关单守卫必须与 `order.closeExpiredOrder` 的 UPDATE 同源
 * （issue #215）。
 *
 * ⚠️ 这条锁**必须待在 card.test.js**：改 card.js 守卫的人跑的是这个文件。
 * 它先前借住在 order.test.js（为了复用 conjuncts），改守卫的人全绿通过却不会
 * 想到去 order 的测试文件里看一眼（双谱系评审 round-5 P3）。
 * 规范化 helper 已提到 `__tests__/helpers.js`，两边共用。
 */
describe('card 充值路径的关单守卫 — 与 order.closeExpiredOrder 同源', () => {
  test('card.js 的第三份守卫副本：条件集合必须是三条守卫 + 转换单排除，且必须是纯合取', () => {
    // `_closeExpiredPendingByUser` 是**第二条**会把待支付单置「已关闭」的路径（顾客充值时触发），
    // 守卫在这三条之外多一条 `sale_order_type <> '转换单'` —— 条件严格强化、命中集合是真子集，
    // 方向安全。少了任何一条，充值路径就会去关「顾客那边正显示着没有倒计时」的单，
    // 口径分叉当场复发。
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const cardSrc = readFileSync(resolve(__dirname, '../../routes/card.js'), 'utf8')

    const fnAt = cardSrc.indexOf('async function _closeExpiredPendingByUser(')
    expect(fnAt, '未找到 _closeExpiredPendingByUser').toBeGreaterThanOrEqual(0)
    const fnBody = cardSrc.slice(fnAt, fnAt + 2500)
    const updateAt = fnBody.indexOf('UPDATE sale_orders')
    expect(updateAt, '未找到充值路径的 UPDATE sale_orders').toBeGreaterThanOrEqual(0)
    const whereAt = fnBody.indexOf('WHERE sale_order_id = $1', updateAt)
    expect(whereAt, '未找到充值路径 UPDATE 的 WHERE 子句').toBeGreaterThan(updateAt)
    const cardWhere = fnBody.slice(whereAt, fnBody.indexOf('`', whereAt))
    expect(cardWhere.length, '充值路径 WHERE 切片异常').toBeGreaterThan(0)

    // ⚠️ 同样不能只做 `toContain`：`AND → OR` 会让充值路径去关**不属于当前顾客、
    // 或仍有在途支付意图**的订单，而四个子串照样都在（codex 评审 round-3 P1）。
    // `conjuncts` 内部对 OR 直接判失败，并把条件规范化成集合做**全等**比较 ——
    // 给充值路径再加一条强化条件也会在这里转红，那时按新口径更新本断言即可。
    expect(sqlConjuncts(cardWhere)).toEqual([
      "lakala_out_order_no IS NULL",
      "opened_by IS NULL",
      "sale_order_type <> '转换单'",
      "status = '待支付'",
    ])
  })
})
