import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

import {
  lockOrgTree, lockActiveAdminCount, lockPermissionMatrixMirror,
  ORG_TREE_LOCK_KEY, ACTIVE_ADMIN_LOCK_KEY, PERMISSION_MATRIX_LOCK_KEY,
} from './invariant-locks'

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
    await lockPermissionMatrixMirror(tx as never)

    for (const call of tx.execute.mock.calls) {
      expect(sqlTextOf(call[0])).not.toMatch(/pg_advisory_lock\(/)
    }
  })

  it('lockPermissionMatrixMirror 取的是 permission_matrix:mirror 这把事务级 advisory lock', async () => {
    const tx = { execute: vi.fn().mockResolvedValue([]) }
    await lockPermissionMatrixMirror(tx as never)

    const text = sqlTextOf(tx.execute.mock.calls[0][0])
    expect(text).toContain('pg_advisory_xact_lock')
    expect(text).toContain(PERMISSION_MATRIX_LOCK_KEY)
    expect(PERMISSION_MATRIX_LOCK_KEY).toBe('permission_matrix:mirror')
  })

  /** 不同不变量共用一把 key 会无谓串行化（也会掩盖「谁在等谁」） */
  it('三把锁的 key 互不相同', () => {
    const keys = [ORG_TREE_LOCK_KEY, ACTIVE_ADMIN_LOCK_KEY, PERMISSION_MATRIX_LOCK_KEY]
    expect(new Set(keys).size).toBe(keys.length)
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
    /**
     * 该 action 里出现的锁调用序列，**精确**匹配（不是「至少包含」）。
     *
     * 精确比较是 codex 第 6 轮 P3 的要求：只查「期望锁第一次出现的位置」时，
     * 往 `deleteRoleDefinition` 的 ② 后面新增一个 ① 会形成 `admin → org` 反序，
     * 而它仍已登记、期望的 admin 锁仍在 —— 两条守护都通过。精确序列才抓得到。
     * 条件取锁（`if (...) await lockX(tx)`）也算一次出现，顺序按文本先后。
     */
    locks: LockKind[]
    /** 该 action 是否必须有 `FOR UPDATE` 行锁（③）。缺了要报错，不能静默跳过 */
    rowLock?: true
    /** 为什么需要这些锁 —— 出现在断言失败信息里，省得下一个人去翻 issue */
    why: string
  }

  const EXPECTATIONS: readonly Expectation[] = [
    {
      file: 'employees.ts', action: 'createEmployee', locks: ['org'],
      why: '归属自洽按组织树形态判；与 updateOrgNode 改挂/改类型互斥',
    },
    {
      file: 'employees.ts', action: 'updateEmployee', locks: ['org', 'admin'], rowLock: true,
      why: '动归属或复职要 ①；标离职会减少活跃超管要 ②；锁内重读员工行要 ③',
    },
    {
      file: 'employees.ts', action: 'deleteEmployee', locks: ['admin'], rowLock: true,
      why: '物理删除会减少活跃超管；锁内重读员工行要 ③',
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

  /** 剥注释（保留长度与行号），避免注释里提到 `lockOrgTree(` 被算成一次取锁 */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  }

  /** 取出某个导出 action 的源码区间：从 `export const <name>` 到下一个顶层 `export ` */
  function sliceAction(src: string, action: string): string {
    const start = src.search(new RegExp(`export const ${action}\\b`))
    if (start === -1) return ''
    const rest = src.slice(start + 1)
    const next = rest.search(/\nexport (const|async function|function) /)
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
  }

  /** 按文本先后取出实际的锁调用序列 */
  function lockSequence(body: string): LockKind[] {
    const hits: { at: number; kind: LockKind }[] = []
    for (const [kind, call] of Object.entries(CALL) as [LockKind, string][]) {
      let at = body.indexOf(call)
      while (at !== -1) {
        hits.push({ at, kind })
        at = body.indexOf(call, at + 1)
      }
    }
    return hits.sort((a, b) => a.at - b.at).map((h) => h.kind)
  }

  it.each(EXPECTATIONS)('$file › $action 取 [$locks]（$why）', (exp) => {
    const { file, action, locks, why, rowLock } = exp
    const src = stripComments(readFileSync(resolve(ACTIONS_DIR, file), 'utf8'))
    const body = sliceAction(src, action)
    expect(body, `${file} 里找不到 ${action}`).not.toBe('')

    /**
     * **精确**比较序列，而不是「至少包含期望的那几把」。
     * 「至少包含」挡不住「在 ② 后面又加了一个 ①」这种反序（codex 第 6 轮 P3），
     * 也挡不住「helper 里悄悄多取一把」（GLM 第 6 轮 P3-1）。
     */
    expect(lockSequence(body), `${action} 的取锁序列必须恰好是 [${locks.join(', ')}] —— ${why}`)
      .toEqual(locks)

    // 行锁必须排在所有 advisory 锁之后；期望有却找不到 → 报错，不静默跳过
    const rowLockAt = body.search(/\.for\(\s*['"]update['"]\s*\)/)
    if (rowLock) {
      expect(rowLockAt, `${action} 期望有 FOR UPDATE 行锁却找不到（被重构进 helper 了？）`)
        .toBeGreaterThan(-1)
    }
    if (rowLockAt > -1) {
      const lastAdvisory = Math.max(
        body.lastIndexOf(CALL.org), body.lastIndexOf(CALL.admin),
      )
      expect(lastAdvisory, `${action}: ③ 行锁必须排在 advisory 锁之后`).toBeLessThan(rowLockAt)
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
      const src = stripComments(readFileSync(resolve(ACTIONS_DIR, file), 'utf8'))
      if (!src.includes('lockOrgTree(') && !src.includes('lockActiveAdminCount(')) continue
      for (const m of src.matchAll(/export const (\w+) = with/g)) {
        const body = sliceAction(src, m[1])
        const takesLock = body.includes('lockOrgTree(') || body.includes('lockActiveAdminCount(')
        if (takesLock && !registered.has(`${file}:${m[1]}`)) unregistered.push(`${file}:${m[1]}`)
      }
    }
    expect(unregistered, '这些 action 取了锁但没登记进 EXPECTATIONS，锁序与锁集合都没人守').toEqual([])
  })

  /**
   * 取锁只许出现在**导出的 action 区间**里（GLM 第 6 轮 P3-1）。
   *
   * `sliceAction` 切到下一个顶层 `export` 为止，所以夹在两个 export 之间的 helper
   * 会被算进**前一个** action 的切片 —— 往那种 helper 里加锁，反向守护会把它归因到
   * 一个已登记的 action，而正向守护若用「至少包含」就查不出多出来的那把。
   * 现在正向已改精确序列，这条再从另一头钉住：锁调用不得出现在非导出函数体内。
   */
  it('取锁调用不出现在非导出的 helper 里', () => {
    const offenders: string[] = []
    for (const file of readdirSync(ACTIONS_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const src = stripComments(readFileSync(resolve(ACTIONS_DIR, file), 'utf8'))
      if (!src.includes('lockOrgTree(') && !src.includes('lockActiveAdminCount(')) continue
      // 把所有 export const 区间挖掉，剩下的就是顶层 helper / import 等
      let rest = src
      for (const m of src.matchAll(/export const (\w+) = /g)) {
        const body = sliceAction(src, m[1])
        if (body) rest = rest.replace(body, '')
      }
      for (const call of Object.values(CALL)) {
        if (rest.includes(call)) offenders.push(`${file} → ${call}`)
      }
    }
    expect(offenders, '锁必须在 action 的事务里显式取，不要藏进 helper —— 藏了就没人守得住顺序').toEqual([])
  })

  /**
   * ## 镜像锁：取锁点必须在 `writeCompatibilityMirror` **内部**（#318 第 7 轮 GLM P1）
   *
   * `system_configs['permission_matrix']` 的写法是「读全表 → UPSERT 一行」，
   * 三个写角色定义的事务都会重写它，不互斥就会丢更新 —— 表里权限已收、镜像里还留着，
   * staffApi 按旧矩阵继续放行直到下一次任意角色写（无界期）。
   *
   * 取锁点放在函数内部是**刻意**的：它必须是每个事务的最后一把（镜像写在 UPDATE/DELETE
   * 之后，那些语句已持行锁），放进函数里就没人能把顺序写错。所以它是上面那条
   * 「锁不得出现在非导出 helper 里」的唯一豁免，由这两条专门守着。
   */
  it('writeCompatibilityMirror 自己取镜像锁', () => {
    const src = stripComments(readFileSync(resolve(ACTIONS_DIR, 'role-definitions.ts'), 'utf8'))
    const start = src.indexOf('async function writeCompatibilityMirror')
    expect(start, '找不到 writeCompatibilityMirror').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}', start))
    expect(body, '镜像写必须自己取 ④ 锁').toContain('lockPermissionMatrixMirror(tx)')
    // 取锁必须在读全表之前，否则读到的还是未互斥的快照
    expect(body.indexOf('lockPermissionMatrixMirror(tx)')).toBeLessThan(body.indexOf('.select('))
  })

  it('三个写角色定义的路径都经由 writeCompatibilityMirror 写镜像（没人绕过去直接 UPSERT）', () => {
    const src = stripComments(readFileSync(resolve(ACTIONS_DIR, 'role-definitions.ts'), 'utf8'))
    for (const action of ['createRoleDefinition', 'updateRoleDefinition', 'deleteRoleDefinition']) {
      const body = sliceAction(src, action)
      expect(body, `找不到 ${action}`).not.toBe('')
      expect(body, `${action} 必须走 writeCompatibilityMirror`).toContain('writeCompatibilityMirror(tx)')
    }
    // 直接 UPSERT permission_matrix 的地方只许有一处（就是那个函数里）
    const upserts = src.match(/permission_matrix/g) ?? []
    expect(upserts.length, '镜像的 UPSERT 只该出现在 writeCompatibilityMirror 里').toBe(1)
  })

  /**
   * 反方向的守护（GLM 第 6 轮 P3-3）：「改树形态 / 改门店↔节点映射的路径必须取 ①」这条
   * 目前靠人评维持。`updateStore` 之所以不必取锁，唯一理由是**它不碰 `org_node_id`** ——
   * 那是一条**载重断言**，将来有人给它加上那列就无感回退（不取锁、不进 EXPECTATIONS、无人报警）。
   */
  it('updateStore 不得写 org_node_id（它是「无需取锁」的唯一依据）', () => {
    const src = stripComments(readFileSync(resolve(ACTIONS_DIR, 'stores.ts'), 'utf8'))
    const body = sliceAction(src, 'updateStore')
    expect(body, 'stores.ts 里找不到 updateStore').not.toBe('')
    /**
     * 判的是**写**（对象字面量里的 `orgNodeId:`）而不是「提到这个标识符」——
     * `updateStore` 会**读** `before.orgNodeId` 去同步节点名（改 name 不改树形态，不需要锁）。
     * 第一版写成 `includes('orgNodeId')` 直接误报，正好说明判据要卡在「写」上。
     */
    const writes = body.match(/orgNodeId\s*:/g) ?? []
    expect(
      writes,
      'updateStore 开始写 org_node_id 了 —— 它必须像 createStore 一样取 ① 并登记进 EXPECTATIONS',
    ).toEqual([])
  })
})
