/**
 * cron config — getMemberThreshold 双层缓存 + 兜底
 * 迁自 cronTask/__tests__/config.test.js（原 require.cache 替换 pg 模块 → 改 vi.mock @/db）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

import { db } from '@/db'
import {
  getMemberThreshold,
  invalidateCache,
  FALLBACK_THRESHOLD,
} from '../config'

const mockExecute = db.execute as unknown as ReturnType<typeof vi.fn>

describe('cron config — getMemberThreshold', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    invalidateCache()
    vi.useRealTimers()
  })

  it('首次调用查 DB 并缓存', async () => {
    mockExecute.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(2000)
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('30 秒内重复调用不再查 DB', async () => {
    mockExecute.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    await getMemberThreshold(db)
    await getMemberThreshold(db)
    await getMemberThreshold(db)
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('updated_at 戳变化时重读 value', async () => {
    mockExecute.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(2000)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31_000)
    mockExecute.mockResolvedValueOnce([
      { value: '3000', updated_at: '2026-04-10T01:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(3000)
  })

  it('DB 报错时返回 FALLBACK_THRESHOLD 且不写缓存', async () => {
    mockExecute.mockRejectedValueOnce(new Error('conn refused'))
    expect(await getMemberThreshold(db)).toBe(FALLBACK_THRESHOLD)

    mockExecute.mockResolvedValueOnce([
      { value: '2500', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(2500)
  })

  it('invalidateCache() 强制下次重读', async () => {
    mockExecute.mockResolvedValueOnce([
      { value: '2000', updated_at: '2026-04-10T00:00:00Z' },
    ])
    await getMemberThreshold(db)

    invalidateCache()

    mockExecute.mockResolvedValueOnce([
      { value: '2500', updated_at: '2026-04-10T02:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(2500)
    expect(mockExecute).toHaveBeenCalledTimes(2)
  })

  it('无效 value（0/负数/NaN）走兜底', async () => {
    mockExecute.mockResolvedValueOnce([
      { value: '0', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(FALLBACK_THRESHOLD)

    invalidateCache()
    mockExecute.mockResolvedValueOnce([
      { value: '-1', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(FALLBACK_THRESHOLD)

    invalidateCache()
    mockExecute.mockResolvedValueOnce([
      { value: 'abc', updated_at: '2026-04-10T00:00:00Z' },
    ])
    expect(await getMemberThreshold(db)).toBe(FALLBACK_THRESHOLD)
  })

  it('DB 无该 key 记录 → 走兜底', async () => {
    mockExecute.mockResolvedValueOnce([])
    expect(await getMemberThreshold(db)).toBe(FALLBACK_THRESHOLD)
  })
})
