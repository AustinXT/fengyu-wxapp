/**
 * #545 退款通道降档的**执行级**用例。
 *
 * 为什么需要它：本通道此前只有 readFileSync + 正则的源码守护，守不住「结果形状 / 运行时取值 /
 * catch 语义」这类缺陷。第 2 轮整改给 getMemberThresholdStrict 加 client 参数时误把
 * `client.query()` 的 QueryResult 当行数组（rows[0]），导致退款通道恒判「配置不可用」并静默
 * 跳过降档 —— 正则测试全绿、执行即坏。这里用 mock client 真正跑一遍。
 */

const config = require('../../utils/config')
const { __testables__ } = require('../../routes/order')
const { recalcCustomerType } = __testables__
const REAL_CONFIG_PATH = require.resolve('../../utils/config')

/** setup.js 把 utils/config 换成了 mock；真实实现需绕开缓存单独加载（避免触碰真实 pg）。 */
function loadRealConfig(pgQuery) {
  const pgPath = require.resolve('../../db/pg')
  const saved = { cfg: require.cache[REAL_CONFIG_PATH], pg: require.cache[pgPath] }
  delete require.cache[REAL_CONFIG_PATH]
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { query: pgQuery } }
  const real = require('../../utils/config')
  // 还原，避免污染其它用例
  require.cache[REAL_CONFIG_PATH] = saved.cfg
  require.cache[pgPath] = saved.pg
  return real
}

describe('getMemberThresholdStrict — 返回形状与失败语义', () => {
  test('传 client：读 QueryResult.rows（回归：曾把 QueryResult 当行数组，恒抛「不可用」）', async () => {
    const real = loadRealConfig(async () => [])
    const client = { query: vi.fn(async () => ({ rows: [{ value: '1990' }], rowCount: 1 })) }
    await expect(real.getMemberThresholdStrict(client)).resolves.toBe(1990)
    expect(client.query).toHaveBeenCalledTimes(1)
  })

  test('不传 client：走连接池，pg.query 返回的是行数组', async () => {
    const pgQuery = vi.fn(async () => [{ value: '2500' }])
    const real = loadRealConfig(pgQuery)
    await expect(real.getMemberThresholdStrict()).resolves.toBe(2500)
    expect(pgQuery).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['无该 key', []],
    ['空串', [{ value: '' }]],
    ['0', [{ value: '0' }]],
    ['负数', [{ value: '-5' }]],
    ['非数字', [{ value: 'no' }]],
  ])('配置不可用（%s）→ 抛 THRESHOLD_UNAVAILABLE_MSG，不兜底', async (_label, rows) => {
    const real = loadRealConfig(async () => [])
    const client = { query: vi.fn(async () => ({ rows, rowCount: rows.length })) }
    await expect(real.getMemberThresholdStrict(client)).rejects.toThrow(real.THRESHOLD_UNAVAILABLE_MSG)
  })

  test('查询本身失败 → 原样抛出（不被改写成「配置不可用」）', async () => {
    const real = loadRealConfig(async () => [])
    const client = { query: vi.fn(async () => { throw Object.assign(new Error('connection terminated'), { code: '08006' }) }) }
    await expect(real.getMemberThresholdStrict(client)).rejects.toThrow('connection terminated')
  })

  test('setup 的 mock 与真实常量同字面（捕获方按它精确匹配）', () => {
    const real = loadRealConfig(async () => [])
    expect(config.THRESHOLD_UNAVAILABLE_MSG).toBe(real.THRESHOLD_UNAVAILABLE_MSG)
  })
})

describe('recalcCustomerType — 退款通道（allowDowngrade=true）', () => {
  /** 按 SQL 特征分派的 mock client：记录每条语句，便于断言「写没写 / 怎么写」。 */
  function buildClient({ currentType, computedType }) {
    const calls = []
    const client = {
      calls,
      query: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (/SELECT customer_type FROM client_wechat_users/.test(sql)) {
          return { rows: [{ customer_type: currentType }], rowCount: 1 }
        }
        if (/AS computed_type/.test(sql)) return { rows: [{ computed_type: computedType }], rowCount: 1 }
        if (/UPDATE client_wechat_users\s+SET customer_type/.test(sql)) {
          return { rows: [{ customer_type: computedType }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
    }
    return client
  }
  const updateOf = (client) => client.calls.find((c) => /UPDATE client_wechat_users\s+SET customer_type/.test(c.sql))

  beforeEach(() => {
    config.getMemberThresholdStrict.mockReset().mockResolvedValue(1990)
    config.getMemberThreshold.mockReset().mockResolvedValue(1980)
  })

  test('会员客 + 达标单已退款 → 降到计算档位，UPDATE 的 $3 为 true，返回 {from,to}', async () => {
    const client = buildClient({ currentType: '会员客', computedType: '小美客' })
    const change = await recalcCustomerType(client, 'U1', 'O1', true)
    expect(change).toEqual({ from: '会员客', to: '小美客' })
    expect(updateOf(client).params).toEqual(['U1', '小美客', true])
    // 退款通道走严格读取，且传的是事务 client（不二次借池连接）
    expect(config.getMemberThresholdStrict).toHaveBeenCalledWith(client)
    expect(config.getMemberThreshold).not.toHaveBeenCalled()
  })

  test('默认通道（allowDowngrade=false）：会员客早退，既不读阈值也不写', async () => {
    const client = buildClient({ currentType: '会员客', computedType: '小美客' })
    await expect(recalcCustomerType(client, 'U1', 'O1')).resolves.toBeNull()
    expect(updateOf(client)).toBeUndefined()
    expect(config.getMemberThresholdStrict).not.toHaveBeenCalled()
  })

  test('默认通道 UPDATE 的 $3 恒为 false（只升不降）', async () => {
    const client = buildClient({ currentType: '流量客', computedType: '小美客' })
    await recalcCustomerType(client, 'U1', 'O1')
    expect(updateOf(client).params).toEqual(['U1', '小美客', false])
    expect(config.getMemberThreshold).toHaveBeenCalled()
    expect(config.getMemberThresholdStrict).not.toHaveBeenCalled()
  })

  test('阈值配置不可用 → 跳过本次分类重算：不写库、不抛错（不阻断退款审批）', async () => {
    config.getMemberThresholdStrict.mockRejectedValueOnce(new Error(config.THRESHOLD_UNAVAILABLE_MSG))
    const client = buildClient({ currentType: '会员客', computedType: '小美客' })
    await expect(recalcCustomerType(client, 'U1', 'O1', true)).resolves.toBeNull()
    expect(updateOf(client)).toBeUndefined()
  })

  test('阈值读取遇到查询级错误 → rethrow（事务已 abort，不能假装成功）', async () => {
    config.getMemberThresholdStrict.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '08006' }))
    const client = buildClient({ currentType: '会员客', computedType: '小美客' })
    await expect(recalcCustomerType(client, 'U1', 'O1', true)).rejects.toThrow('connection terminated')
  })

  test('退款通道不执行 #301 入会绑定门禁（即便计算结果仍是会员客）', async () => {
    // 其它订单仍达标 → 计算档位仍是会员客；若门禁生效会多发 current_order_qualifies 查询
    const client = buildClient({ currentType: '会员客', computedType: '会员客' })
    await recalcCustomerType(client, 'U1', 'O1', true)
    expect(client.calls.some((c) => /current_order_qualifies/.test(c.sql))).toBe(false)
  })

  test('计算档位与现值相同 → UPDATE 命中 0 行时返回 null（幂等）', async () => {
    const client = buildClient({ currentType: '小美客', computedType: '小美客' })
    client.query.mockImplementation(async (sql, params) => {
      client.calls.push({ sql, params })
      if (/SELECT customer_type FROM client_wechat_users/.test(sql)) return { rows: [{ customer_type: '小美客' }], rowCount: 1 }
      if (/AS computed_type/.test(sql)) return { rows: [{ computed_type: '小美客' }], rowCount: 1 }
      return { rows: [], rowCount: 0 } // UPDATE 守卫挡住 → 0 行
    })
    await expect(recalcCustomerType(client, 'U1', 'O1', true)).resolves.toBeNull()
  })
})
