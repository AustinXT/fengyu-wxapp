/**
 * utils/config.js 单元测试 — getMemberThreshold 缓存 + 兜底
 */

const pg = globalThis.__mocks__.pg

function loadFreshConfig() {
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

  test('30 秒内重复调用不再查 DB', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])

    await config.getMemberThreshold()
    await config.getMemberThreshold()
    await config.getMemberThreshold()

    expect(pg.query).toHaveBeenCalledTimes(1)
  })

  test('updated_at 戳变化时重读 value', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    const v1 = await config.getMemberThreshold()
    expect(v1).toBe(2000)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    pg.query.mockResolvedValueOnce([
      { value: '3000', updated_at: '2026-04-10T01:00:00Z' },
    ])
    const v2 = await config.getMemberThreshold()
    expect(v2).toBe(3000)
    vi.useRealTimers()
  })

  test('DB 报错时返回 1980 兜底且不写缓存', async () => {
    const config = loadFreshConfig()
    pg.query.mockRejectedValueOnce(new Error('conn refused'))
    const v = await config.getMemberThreshold()
    expect(v).toBe(1980)

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

  test('无效 value（0/负数/NaN）走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([{ value: '0', updated_at: '2026-04-10T00:00:00Z' }])
    expect(await config.getMemberThreshold()).toBe(1980)

    pg.query.mockResolvedValueOnce([{ value: '-5', updated_at: '2026-04-10T00:00:00Z' }])
    expect(await config.getMemberThreshold()).toBe(1980)

    pg.query.mockResolvedValueOnce([{ value: 'foo', updated_at: '2026-04-10T00:00:00Z' }])
    expect(await config.getMemberThreshold()).toBe(1980)
  })

  test('DB 无该 key 记录 → 走兜底', async () => {
    const config = loadFreshConfig()
    pg.query.mockResolvedValueOnce([])
    expect(await config.getMemberThreshold()).toBe(1980)
  })
})
