/**
 * utils/config.js 单元测试 — getMemberThreshold 缓存 + 兜底
 */

const pg = globalThis.__mocks__.pg

function loadFreshConfig() {
  // 清除模块缓存强制重载，重置内部 _cachedValue / _cachedUpdatedAt / _lastCheckAt
  const configPath = require.resolve('../../utils/config')
  delete require.cache[configPath]
  return require('../../utils/config')
}

describe('utils/config — getMemberThreshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pg.query.mockReset().mockResolvedValue([])
  })

  test('首次调用查 DB 并缓存', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])

    const v = await config.getMemberThreshold()
    expect(v).toBe(2000)
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('30 秒内重复调用不再查 DB（命中 fast path）', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])

    const v1 = await config.getMemberThreshold()
    const v2 = await config.getMemberThreshold()
    const v3 = await config.getMemberThreshold()

    expect(v1).toBe(2000)
    expect(v2).toBe(2000)
    expect(v3).toBe(2000)
    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('updated_at 戳变化时重读 value', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])

    const v1 = await config.getMemberThreshold()
    expect(v1).toBe(2000)

    // 模拟过了 30 秒，需要核对 → 返回新的 updated_at + value
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    pg.query.mockResolvedValueOnce([
      { value: '3000', updated_at: '2026-04-10T01:00:00Z' },
    ])
    const v2 = await config.getMemberThreshold()
    expect(v2).toBe(3000)
    expect(pg.query).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  test('DB 报错时返回 1980 兜底且不写缓存', async () => {
    const config = loadFreshConfig()
    pg.query.mockRejectedValueOnce(new Error('conn refused'))

    const v = await config.getMemberThreshold()
    expect(v).toBe(1980) // FALLBACK
    expect(v).toBe(config.FALLBACK_THRESHOLD)

    // 下次调用应再次重试（没写缓存）
    pg.query.mockResolvedValueOnce([
      { value: '2500', updated_at: '2026-04-10T00:00:00Z' },
    ])
    const v2 = await config.getMemberThreshold()
    expect(v2).toBe(2500)
  })

  test('invalidateCache() 强制下次重读', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    await config.getMemberThreshold()

    config.invalidateCache()

    pg.query.mockResolvedValueOnce([
      { value: '2500', updated_at: '2026-04-10T02:00:00Z' },
    ])
    const v2 = await config.getMemberThreshold()
    expect(v2).toBe(2500)
    expect(pg.query).toHaveBeenCalledTimes(2)
  })

  test('无效 value（0）走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '0', updated_at: '2026-04-10T00:00:00Z' },
    ])
    const v = await config.getMemberThreshold()
    expect(v).toBe(1980)
  })

  test('无效 value（负数）走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '-100', updated_at: '2026-04-10T00:00:00Z' },
    ])
    const v = await config.getMemberThreshold()
    expect(v).toBe(1980)
  })

  test('无效 value（NaN/非数字字符串）走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: 'not-a-number', updated_at: '2026-04-10T00:00:00Z' },
    ])
    const v = await config.getMemberThreshold()
    expect(v).toBe(1980)
  })

  test('DB 无该 key 记录 → 走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([])
    const v = await config.getMemberThreshold()
    expect(v).toBe(1980)
  })
})
