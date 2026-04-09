import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

// 捕获 unstable_cache 原始函数便于直接断言，并 stub revalidateTag
const mockRevalidateTag = vi.fn()
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
  revalidateTag: (tag: string) => mockRevalidateTag(tag),
}))

import {
  getMemberThreshold,
  invalidateMemberThreshold,
  MEMBER_THRESHOLD_FALLBACK,
  MEMBER_THRESHOLD_TAG,
} from './member-threshold'
import { db } from '@/db'

describe('getMemberThreshold — 会员门槛读取 + 缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('DB 有记录 → 返回配置值', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '2000' }])
    const v = await getMemberThreshold()
    expect(v).toBe(2000)
  })

  it('DB 无记录 → 返回 FALLBACK (1980)', async () => {
    ;(db.execute as any).mockResolvedValue([])
    const v = await getMemberThreshold()
    expect(v).toBe(MEMBER_THRESHOLD_FALLBACK)
    expect(v).toBe(1980)
  })

  it('DB 异常 → 返回 FALLBACK (1980)', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('conn refused'))
    const v = await getMemberThreshold()
    expect(v).toBe(1980)
  })

  it('无效 value (0) → 返回 FALLBACK', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '0' }])
    const v = await getMemberThreshold()
    expect(v).toBe(1980)
  })

  it('无效 value (负数) → 返回 FALLBACK', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: '-100' }])
    const v = await getMemberThreshold()
    expect(v).toBe(1980)
  })

  it('无效 value (非数字) → 返回 FALLBACK', async () => {
    ;(db.execute as any).mockResolvedValue([{ value: 'foo' }])
    const v = await getMemberThreshold()
    expect(v).toBe(1980)
  })
})

describe('invalidateMemberThreshold — 主动失效缓存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('调用 revalidateTag 且传入正确的 tag', () => {
    invalidateMemberThreshold()
    expect(mockRevalidateTag).toHaveBeenCalledWith(MEMBER_THRESHOLD_TAG)
    expect(mockRevalidateTag).toHaveBeenCalledWith('new_member_threshold')
  })
})
