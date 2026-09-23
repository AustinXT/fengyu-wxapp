import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

import { lockOrgTree, lockActiveAdminCount, ORG_TREE_LOCK_KEY, ACTIVE_ADMIN_LOCK_KEY } from './invariant-locks'

/**
 * 这里用**真** drizzle 的 `sql` 模板（不 mock），所以 `queryChunks` 里能读到实际 SQL 文本与绑定值。
 * 各 action 的测试文件把 drizzle 整个 mock 掉了，只能断言「从这里取锁」；
 * 「取的是哪把、用的哪个 PG 函数」这层由本文件负责 —— `employees.test.ts` 的源码守护
 * 明确把这部分委托了过来，别把这里删掉。
 */
function sqlTextOf(call: unknown) {
  return JSON.stringify(call)
}

describe('invariant-locks — 锁的取法', () => {
  it('lockOrgTree 取的是 org_nodes:reparent 这把事务级 advisory lock', async () => {
    const tx = { execute: vi.fn().mockResolvedValue([]) }
    await lockOrgTree(tx as never)

    const text = sqlTextOf(tx.execute.mock.calls[0][0])
    expect(text).toContain('pg_advisory_xact_lock')
    expect(text).toContain('hashtext')
    expect(text).toContain(ORG_TREE_LOCK_KEY)
    expect(ORG_TREE_LOCK_KEY).toBe('org_nodes:reparent')
  })

  it('lockActiveAdminCount 取的是 admin:active_count 这把事务级 advisory lock', async () => {
    const tx = { execute: vi.fn().mockResolvedValue([]) }
    await lockActiveAdminCount(tx as never)

    const text = sqlTextOf(tx.execute.mock.calls[0][0])
    expect(text).toContain('pg_advisory_xact_lock')
    expect(text).toContain('hashtext')
    expect(text).toContain(ACTIVE_ADMIN_LOCK_KEY)
    expect(ACTIVE_ADMIN_LOCK_KEY).toBe('admin:active_count')
  })

  /**
   * `pg_advisory_lock`（会话级）取了之后连接归池仍然持有 —— 云函数/Next.js 复用连接的场景下
   * 等于永久泄漏一把锁。必须是 `_xact_` 那个变体，事务一结束自动释放。
   */
  it('必须是事务级（_xact_）而非会话级 advisory lock', async () => {
    const tx = { execute: vi.fn().mockResolvedValue([]) }
    await lockOrgTree(tx as never)
    await lockActiveAdminCount(tx as never)

    for (const call of tx.execute.mock.calls) {
      expect(sqlTextOf(call[0])).not.toMatch(/pg_advisory_lock\(/)
    }
  })

  /** 两个不变量互不相干，共用一把 key 会无谓串行化（也会掩盖「谁在等谁」） */
  it('两把锁的 key 不同', () => {
    expect(ORG_TREE_LOCK_KEY).not.toBe(ACTIVE_ADMIN_LOCK_KEY)
  })

  it('用传进来的事务句柄取锁，不落到全局 db 上', async () => {
    const { db } = await import('@/db')
    const tx = { execute: vi.fn().mockResolvedValue([]) }
    await lockOrgTree(tx as never)
    await lockActiveAdminCount(tx as never)

    expect(tx.execute).toHaveBeenCalledTimes(2)
    expect((db as unknown as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled()
  })
})

/**
 * ## 锁序守护
 *
 * 粒度从粗到细：① 组织树 → ② admin 计数 → ③ 行锁。反序就是 lock ordering inversion，
 * PG 抛 `40P01`，而各 action 的 catch 都不翻译它 —— 用户看到 500。
 * #249/#259 那轮已经踩过一次（`updateEmployee` 是「行锁 → advisory」而 `deleteEmployee`
 * 是「advisory → 行锁」，两个评审谱系各自独立报出）。
 *
 * 这是**源码守护**：运行时测不出来（要真造并发死锁），但顺序写反是最容易犯的错，
 * 所以按文本位置钉住。新增同时取两把锁的 action 时，把文件名加进 `BOTH_LOCK_FILES`。
 */
describe('invariant-locks — 取锁顺序（源码守护）', () => {
  const ACTIONS_DIR = resolve(__dirname, '..', 'actions')
  /** 同时取两把锁的文件 —— 目前只有 employees（标离职既动归属字段又减 admin 数） */
  const BOTH_LOCK_FILES = ['employees.ts']

  it.each(BOTH_LOCK_FILES)('%s：组织树锁必须排在 admin 计数锁之前', (file) => {
    const src = readFileSync(resolve(ACTIONS_DIR, file), 'utf8')
    const orgAt = src.indexOf('lockOrgTree(')
    const adminAt = src.indexOf('lockActiveAdminCount(')

    expect(orgAt, `${file} 应当调用 lockOrgTree`).toBeGreaterThan(-1)
    expect(adminAt, `${file} 应当调用 lockActiveAdminCount`).toBeGreaterThan(-1)
    expect(orgAt, '① 组织树 → ② admin 计数，反序即 40P01').toBeLessThan(adminAt)
  })

  /**
   * 行锁（`.for('update')`）必须排在两把 advisory lock**之后**。
   * 只看 import 顺序会漏 —— 这里比的是调用点位置。
   */
  it.each(BOTH_LOCK_FILES)('%s：行锁排在 advisory lock 之后', (file) => {
    const src = readFileSync(resolve(ACTIONS_DIR, file), 'utf8')
    const lastAdvisory = Math.max(src.indexOf('lockOrgTree('), src.indexOf('lockActiveAdminCount('))
    const firstRowLock = src.search(/\.for\(\s*['"]update['"]\s*\)/)

    expect(firstRowLock, `${file} 应当有 FOR UPDATE 行锁`).toBeGreaterThan(-1)
    expect(lastAdvisory, '②/① 之后才轮到 ③ 行锁').toBeLessThan(firstRowLock)
  })
})
