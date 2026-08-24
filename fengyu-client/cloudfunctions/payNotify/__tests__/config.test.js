/**
 * payNotify config.js 单元测试 — getMemberThreshold 缓存 + 兜底
 *
 * payNotify 使用扁平结构，config.js 内部通过 pg 库创建独立 Pool。
 * 通过直接打 require.cache 替换 pg 模块模拟 DB 响应（CJS 模式，绕过 vi.mock）。
 */

const mockQuery = vi.fn()
const pgPath = require.resolve('pg')
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: vi.fn(() => ({
      query: (...args) => mockQuery(...args),
      on: vi.fn(),
    })),
    // config.js 模块加载时调用 pg.types.setTypeParser（commit 3544deb9 引入的
    // numeric/bigint 全局 OID 解析）；mock 需提供 types 否则 require 即抛
    types: {
      setTypeParser: vi.fn(),
    },
  },
}

function loadFreshConfig() {
  const configPath = require.resolve('../config')
  delete require.cache[configPath]
  return require('../config')
}

describe('payNotify config — getMemberThreshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockReset()
  })

  test('首次调用查 DB 并缓存', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2000', updated_at: '2026-04-10T00:00:00Z' }],
    })

    const v = await config.getMemberThreshold()
    expect(v).toBe(2000)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  test('30 秒内重复调用不再查 DB', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2000', updated_at: '2026-04-10T00:00:00Z' }],
    })
    await config.getMemberThreshold()
    await config.getMemberThreshold()
    await config.getMemberThreshold()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  test('updated_at 戳变化时重读 value', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2000', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(2000)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '3000', updated_at: '2026-04-10T01:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(3000)
    vi.useRealTimers()
  })

  test('DB 报错时返回 1980 兜底且不写缓存', async () => {
    const config = loadFreshConfig()
    mockQuery.mockRejectedValueOnce(new Error('conn refused'))
    expect(await config.getMemberThreshold()).toBe(1980)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2500', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(2500)
  })

  test('invalidateCache() 强制下次重读', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2000', updated_at: '2026-04-10T00:00:00Z' }],
    })
    await config.getMemberThreshold()

    config.invalidateCache()

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2500', updated_at: '2026-04-10T02:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(2500)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  test('无效 value（0/负数/NaN）走兜底', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(1980)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '-100', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(1980)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: 'xyz', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(1980)
  })

  test('DB 无该 key 记录 → 走兜底', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await config.getMemberThreshold()).toBe(1980)
  })
})

describe('payNotify config — getPointsDeductionMaxRate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockReset()
  })

  test('首次调用查 DB 并缓存（活动期 0.05）', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.05)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  test('30 秒内重复调用不再查 DB', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    await config.getPointsDeductionMaxRate()
    await config.getPointsDeductionMaxRate()
    await config.getPointsDeductionMaxRate()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  test('updated_at 戳变化时重读 value（活动结束 0.05→0.03）', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.05)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.03', updated_at: '2026-07-24T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)
    vi.useRealTimers()
  })

  test('已缓存合法值后 updated_at 变为无效值 → 清缓存走兜底', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.05)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 31_000)
      mockQuery.mockResolvedValueOnce({
        rows: [{ value: '1.5', updated_at: '2026-07-24T00:00:00Z' }],
      })
      expect(await config.getPointsDeductionMaxRate()).toBe(0.03)

      mockQuery.mockResolvedValueOnce({
        rows: [{ value: '0.04', updated_at: '2026-07-25T00:00:00Z' }],
      })
      expect(await config.getPointsDeductionMaxRate()).toBe(0.04)
      expect(mockQuery).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  test('DB 报错时返回 0.03 兜底且不写缓存', async () => {
    const config = loadFreshConfig()
    mockQuery.mockRejectedValueOnce(new Error('conn refused'))
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.05)
  })

  test('invalidateCache() 强制下次重读', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.05', updated_at: '2026-07-23T00:00:00Z' }],
    })
    await config.getPointsDeductionMaxRate()

    config.invalidateCache()

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0.03', updated_at: '2026-07-24T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  test('无效 value（>1 / <0 / NaN）走兜底 0.03', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '1.5', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '-0.1', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: 'foo', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)
  })

  test('下边界 0 合法（禁用积分抵扣）', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '0', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(0)
  })

  test('上边界 1 合法（可 100% 抵扣）', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '1', updated_at: '2026-07-23T00:00:00Z' }],
    })
    expect(await config.getPointsDeductionMaxRate()).toBe(1)
  })

  test('DB 无该 key 记录 → 走兜底 0.03', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await config.getPointsDeductionMaxRate()).toBe(0.03)
  })
})
