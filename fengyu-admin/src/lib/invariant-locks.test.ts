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
 * ## 锁序与「谁必须取」的守护
 *
 * 粒度从粗到细：① 组织树 → ② admin 计数 → ③ 行锁。反序就是 lock ordering inversion，
 * PG 抛 `40P01`，而各 action 的 catch 都不翻译它 —— 用户看到 500。
 * #249/#259 那轮已经踩过一次（`updateEmployee` 是「行锁 → advisory」而 `deleteEmployee`
 * 是「advisory → 行锁」，两个评审谱系各自独立报出）。
 *
 * 这是**源码守护**：运行时测不出来（要真造并发死锁），但顺序写反是最容易犯的错。
 *
 * ⚠️ 演进史（别再退回去）：
 * - v1 拿**整文件**的首次出现位置比 → 假绿：`employees.ts` 里 `lockOrgTree` 的第一次出现在
 *   `createEmployee`，于是把 `updateEmployee` 的组织树锁挪到行锁之后照样通过（codex 第 2 轮 P3）。
 * - v2 按 `db.transaction(` 切块逐块判顺序 → 仍不够：它只能确认「文件里**某个**事务取过锁」，
 *   删掉某一个事务里的锁不会变红；「未登记文件」检测也只能发现文件、发现不了漏掉的 action
 *   （codex 第 5 轮 P3）。
 * - v3（现在）：维护一张**逐 action 的期望清单**，断言每个 action 所在的事务块取了哪几把锁。
 *   新增取锁路径时把它加进 `EXPECTATIONS` —— 漏加会被最后那条「未登记」守护抓到。
 */
describe('invariant-locks — 逐 action 的取锁期望（源码守护）', () => {
  const ACTIONS_DIR = resolve(__dirname, '..', 'actions')

  type LockKind = 'org' | 'admin'
  interface Expectation {
    file: string
    /** action 的导出名，用来定位它的代码区间 */
    action: string
    /** 该 action 的事务里必须出现的锁，按**期望顺序**列出 */
    locks: LockKind[]
    /** 为什么需要这些锁 —— 出现在断言失败信息里，省得下一个人去翻 issue */
    why: string
  }

  const EXPECTATIONS: readonly Expectation[] = [
    {
      file: 'employees.ts', action: 'createEmployee', locks: ['org'],
      why: '归属自洽按组织树形态判；与 updateOrgNode 改挂/改类型互斥',
    },
    {
      file: 'employees.ts', action: 'updateEmployee', locks: ['org', 'admin'],
      why: '动归属或复职要 ①；标离职会减少活跃超管要 ②',
    },
    {
      file: 'employees.ts', action: 'deleteEmployee', locks: ['admin'],
      why: '物理删除会减少活跃超管',
    },
    {
      file: 'org.ts', action: 'createOrgNode', locks: ['org'],
      why: '父节点类型必须锁内重读，否则与改类型那侧交叉穿透出非法树',
    },
    {
      file: 'org.ts', action: 'updateOrgNode', locks: ['org', 'admin'],
      why: '改树形态要 ①；改 type 会动「节点类型 × 角色白名单 × 存量绑定」三元关系要 ②',
    },
    {
      file: 'org.ts', action: 'deleteOrgNode', locks: ['org'],
      why: '删除同样改树形态；不取锁会让改挂/授权那两侧撞出未翻译的 23503',
    },
    {
      file: 'permissions.ts', action: 'assignRole', locks: ['org', 'admin'],
      why: '判「节点类型 ∈ 白名单」与「scope 是否还在管辖范围」要 ①；超管闸与计数要 ②',
    },
    {
      file: 'permissions.ts', action: 'revokeRole', locks: ['org', 'admin'],
      why: 'scope 复判要 ①；最后一名超管守卫要 ②',
    },
    {
      file: 'role-definitions.ts', action: 'updateRoleDefinition', locks: ['org', 'admin'],
      why: '白名单变更要按当前节点类型复核存量绑定（①）；降级超管要 ②',
    },
    {
      file: 'role-definitions.ts', action: 'deleteRoleDefinition', locks: ['admin'],
      why: '「还有人在用就不许删」要与 assignRole 互斥',
    },
    {
      file: 'stores.ts', action: 'createStore', locks: ['org'],
      why: 'stores.org_node_id 是门店↔节点映射的写入方，与 org 侧改类型的守卫共用 ①',
    },
  ]

  const CALL: Record<LockKind, string> = { org: 'lockOrgTree(', admin: 'lockActiveAdminCount(' }

  /** 取出某个导出 action 的源码区间：从 `export const <name>` 到下一个顶层 `export ` */
  function sliceAction(src: string, action: string): string {
    const start = src.search(new RegExp(`export const ${action}\\b`))
    if (start === -1) return ''
    const rest = src.slice(start + 1)
    const next = rest.search(/\nexport (const|async function|function) /)
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
  }

  it.each(EXPECTATIONS)('$file › $action 取 [$locks]（$why）', ({ file, action, locks, why }) => {
    const src = readFileSync(resolve(ACTIONS_DIR, file), 'utf8')
    const body = sliceAction(src, action)
    expect(body, `${file} 里找不到 ${action}`).not.toBe('')

    const positions = locks.map((kind) => {
      const at = body.indexOf(CALL[kind])
      expect(at, `${action} 必须取 ${CALL[kind]} —— ${why}`).toBeGreaterThan(-1)
      return at
    })
    // 期望顺序即文本顺序（① 组织树 → ② admin 计数）
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1], `${action} 的取锁顺序必须是 ${locks.join(' → ')}（反了就是 40P01）`)
        .toBeLessThan(positions[i])
    }

    // 行锁必须排在所有 advisory 锁之后
    const rowLockAt = body.search(/\.for\(\s*['"]update['"]\s*\)/)
    if (rowLockAt > -1) {
      expect(Math.max(...positions), `${action}: ③ 行锁必须排在 advisory 锁之后`)
        .toBeLessThan(rowLockAt)
    }
  })

  /**
   * 反向守护：有 action 取了锁却没登记进 `EXPECTATIONS`。
   * 这条才是「清单不会悄悄过期」的保证 —— 上一条只能验已登记的。
   */
  it('没有未登记的取锁 action', () => {
    const registered = new Set(EXPECTATIONS.map((e) => `${e.file}:${e.action}`))
    const unregistered: string[] = []
    for (const file of readdirSync(ACTIONS_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const src = readFileSync(resolve(ACTIONS_DIR, file), 'utf8')
      if (!src.includes('lockOrgTree(') && !src.includes('lockActiveAdminCount(')) continue
      for (const m of src.matchAll(/export const (\w+) = with/g)) {
        const body = sliceAction(src, m[1])
        const takesLock = body.includes('lockOrgTree(') || body.includes('lockActiveAdminCount(')
        if (takesLock && !registered.has(`${file}:${m[1]}`)) unregistered.push(`${file}:${m[1]}`)
      }
    }
    expect(unregistered, '这些 action 取了锁但没登记进 EXPECTATIONS，锁序与锁集合都没人守').toEqual([])
  })
})
