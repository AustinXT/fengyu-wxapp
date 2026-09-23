import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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
 * 所以按文本位置钉住。
 *
 * ⚠️ 必须**按事务块分别判**，不能拿整文件的首次出现比（codex 第 2 轮 P3）：
 * `employees.ts` 里 `lockOrgTree` 的第一次出现在 `createEmployee`，于是把
 * `updateEmployee` 的组织树锁挪到行锁之后，整文件口径照样通过 —— 那是个假绿。
 */
describe('invariant-locks — 取锁顺序（源码守护）', () => {
  const ACTIONS_DIR = resolve(__dirname, '..', 'actions')
  /** 取过锁的 action 文件 —— 新增取锁路径时把文件名加进来 */
  const LOCKING_FILES = ['employees.ts', 'org.ts', 'permissions.ts', 'role-definitions.ts']

  /**
   * 按 `db.transaction(` 切开，每段就是一个事务体（含其后所有文本，但下一段起点即本段终点）。
   * 粗糙但足够：判的是同一事务内三类锁的**相对位置**。
   */
  function transactionBlocks(src: string): string[] {
    const parts = src.split('db.transaction(')
    return parts.slice(1)
  }

  it.each(LOCKING_FILES)('%s：每个事务块内的取锁顺序都是 ① 组织树 → ② admin 计数 → ③ 行锁', (file) => {
    const src = readFileSync(resolve(ACTIONS_DIR, file), 'utf8')
    const blocks = transactionBlocks(src)
    expect(blocks.length, `${file} 应当至少有一个事务`).toBeGreaterThan(0)

    for (const block of blocks) {
      const orgAt = block.indexOf('lockOrgTree(')
      const adminAt = block.indexOf('lockActiveAdminCount(')
      const rowAt = block.search(/\.for\(\s*['"]update['"]\s*\)/)

      if (orgAt > -1 && adminAt > -1) {
        expect(orgAt, `${file}: ① 组织树必须排在 ② admin 计数之前`).toBeLessThan(adminAt)
      }
      const lastAdvisory = Math.max(orgAt, adminAt)
      if (lastAdvisory > -1 && rowAt > -1) {
        expect(lastAdvisory, `${file}: advisory 锁必须排在 ③ 行锁之前`).toBeLessThan(rowAt)
      }
    }

    /**
     * 上面的断言是条件式的（两把锁同时出现才比顺序），所以必须另外钉住
     * 「这个文件真的在事务里取过锁」—— 否则谁把取锁整段删掉，这条守护会静默通过。
     * 只有一把锁、或没有行锁的文件（`org.ts` / `permissions.ts` / `role-definitions.ts`）
     * 本来就没有相对顺序可比，那不是缺陷。
     */
    const locksInsideTx = blocks.some((b) => (
      b.includes('lockOrgTree(') || b.includes('lockActiveAdminCount(')
    ))
    expect(locksInsideTx, `${file} 登记在 LOCKING_FILES 里，却没有任何事务块在取锁`).toBe(true)
  })

  /** 清单本身的守护：取锁函数只应出现在 `LOCKING_FILES` 列的文件里，新增了就得登记 */
  it('没有未登记的文件在取锁', () => {
    const unlisted = readdirSync(ACTIONS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !LOCKING_FILES.includes(f))
      .filter((f) => {
        const src = readFileSync(resolve(ACTIONS_DIR, f), 'utf8')
        return src.includes('lockOrgTree(') || src.includes('lockActiveAdminCount(')
      })
    expect(unlisted, '这些文件取了锁但没登记进 LOCKING_FILES，锁序守护覆盖不到它们').toEqual([])
  })
})
