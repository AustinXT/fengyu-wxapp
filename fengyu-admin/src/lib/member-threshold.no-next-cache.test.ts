/**
 * getMemberThreshold 在**没有 Next incrementalCache** 的进程里必须能用（#292 pr-ready P1）。
 *
 * export-worker 是独立 node 进程：真实的 `unstable_cache` 在那里一调用就抛
 * `Invariant: incrementalCache missing`。member-threshold.test.ts 把 next/cache mock 成透传，
 * 所以测不到这一点 —— 本文件**刻意不 mock next/cache**，走真实实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

import { unstable_cache } from 'next/cache'
import { getMemberThreshold, MEMBER_THRESHOLD_FALLBACK } from './member-threshold'
import { db } from '@/db'

const exec = db.execute as unknown as ReturnType<typeof vi.fn>

describe('getMemberThreshold — 无 Next 缓存上下文（export-worker）', () => {
  const prev = process.env.FENGYU_EXPORT_WORKER
  beforeEach(() => {
    exec.mockReset()
    delete process.env.FENGYU_EXPORT_WORKER
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.FENGYU_EXPORT_WORKER
    else process.env.FENGYU_EXPORT_WORKER = prev
  })

  it('前提：真实 unstable_cache 在此环境会抛 incrementalCache missing（否则本组测试失去意义）', async () => {
    await expect(unstable_cache(async () => 1, ['probe'])()).rejects.toThrow(/incrementalCache missing/)
  })

  it('export-worker（FENGYU_EXPORT_WORKER=1）直读配置，不经 unstable_cache', async () => {
    process.env.FENGYU_EXPORT_WORKER = '1'
    exec.mockResolvedValue([{ value: '2990' }])
    await expect(getMemberThreshold()).resolves.toBe(2990)
  })

  it('未设标志但缺 incrementalCache → 回退直读，返回真实配置而不是 FALLBACK', async () => {
    exec.mockResolvedValue([{ value: '2990' }])
    await expect(getMemberThreshold()).resolves.toBe(2990)
  })

  it('直读时 DB 异常 → FALLBACK（并打告警，不抛）', async () => {
    process.env.FENGYU_EXPORT_WORKER = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    exec.mockRejectedValue(new Error('conn refused'))
    await expect(getMemberThreshold()).resolves.toBe(MEMBER_THRESHOLD_FALLBACK)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
