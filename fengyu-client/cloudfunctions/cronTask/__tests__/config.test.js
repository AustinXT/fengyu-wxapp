/**
 * cronTask config.js 单元测试 — getMemberThreshold 缓存 + 兜底
 *
 * cronTask 使用扁平结构，config.js 内部通过 pg 库创建独立 Pool。
 * 通过直接打 require.cache 替换 pg 模块模拟 DB 响应。
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
  },
}

function loadFreshConfig() {
  const configPath = require.resolve('../config')
  delete require.cache[configPath]
  return require('../config')
}

describe('cronTask config — getMemberThreshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockReset()
  })

  test('首次调用查 DB 并缓存', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({
      rows: [{ value: '2000', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(2000)
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
      rows: [{ value: '-1', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(1980)

    mockQuery.mockResolvedValueOnce({
      rows: [{ value: 'abc', updated_at: '2026-04-10T00:00:00Z' }],
    })
    expect(await config.getMemberThreshold()).toBe(1980)
  })

  test('DB 无该 key 记录 → 走兜底', async () => {
    const config = loadFreshConfig()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    expect(await config.getMemberThreshold()).toBe(1980)
  })
})
