import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/permission', () => ({
  permissionRoleDefinitions: {
    roleKey: 'role_key',
    name: 'name',
    description: 'description',
    actions: 'actions',
    allowedScopeTypes: 'allowed_scope_types',
    canAccessAdmin: 'can_access_admin',
    isSuperAdmin: 'is_super_admin',
    isStoreManager: 'is_store_manager',
    updatedAt: 'updated_at',
  },
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', isResigned: 'is_resigned' },
}))

vi.mock('@/lib/with-permission', () => ({
  withPermission: vi.fn((_action: string, handler: Function) => (
    async (...args: unknown[]) => handler({ employeeId: 'ADMIN-001' }, ...args)
  )),
  withAnyPermission: vi.fn((_actions: string[], handler: Function) => handler),
}))

vi.mock('@/lib/permissions', () => ({
  requireAdmin: vi.fn(),
  invalidatePermissionMatrixCache: vi.fn(),
  KNOWN_PERMISSION_ACTIONS: [
    'dashboard:view',
    'system:config',
    'system:diagnostics',
    'permission:assign_admin',
    'admin:reset_password',
    // 进销存三层级动作样例：总部 / 市场 / 门店。
    'inventory:supply_chain_operate',
    'inventory:market_operate',
    'inventory:store_operate',
  ],
}))

vi.mock('@/lib/permission-contract', () => ({
  getMissingUiDependencies: vi.fn(() => []),
  isActionGrantableForRoleDefinition: vi.fn(() => true),
  sanitizeRoleDefinitionActions: vi.fn((actions: string[]) => actions),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
}))

vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn() }))
// 「系统零超管」的计数已收口到共用 helper（#318 第 2 轮），与另外三个入口同一个
vi.mock('@/lib/admin-guard', () => ({ countActiveAdmins: vi.fn().mockResolvedValue(5) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  asc: vi.fn((column: unknown) => ({ type: 'asc', column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  ne: vi.fn((left: unknown, right: unknown) => ({ type: 'ne', left, right })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    { raw: vi.fn((value: string) => value) },
  ),
}))

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { updateRoleDefinition } from './role-definitions'
import { countActiveAdmins } from '@/lib/admin-guard'

function mockSelectOnce(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  return { from }
}

/** 记录 update().set() 入参的事务桩，便于断言 allowedScopeTypes 的归一化结果。 */
function mockTxCapturingSet(): { setValues: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {}
  const set = vi.fn((values: Record<string, unknown>) => {
    captured = values
    return {
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ roleKey: 'role-custom' }]),
      })),
    }
  })
  ;(db.transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (callback: Function) => callback({
    update: vi.fn(() => ({ set })),
    select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([]) })),
    execute: vi.fn().mockResolvedValue(undefined),
  }))
  return { setValues: () => captured }
}

describe('updateRoleDefinition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 编辑路径的存量分配复核（hasConflictingScopeAssignment）默认无冲突；
    // 个别用例用 mockResolvedValueOnce 覆盖为有冲突。
    vi.mocked(db.execute).mockResolvedValue([] as never)
    // ⚠️ clearAllMocks 不清 mockImplementation：某条用例设的 0 会泄漏到后面
    vi.mocked(countActiveAdmins).mockResolvedValue(5)
  })

  it('拒绝将已有非总部授权的角色升级为超级管理员', async () => {
    const before = {
      roleKey: 'role-market-manager',
      name: '市场经理',
      description: null,
      actions: ['dashboard:view'],
      canAccessAdmin: true,
      isSuperAdmin: false,
      isStoreManager: false,
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    }
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
    ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ exists: 1 }])

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      isSuperAdmin: true,
      actions: ['system:config', 'permission:assign_admin', 'admin:reset_password'],
    })).rejects.toThrow(/INVALID_STATE.*非总部范围分配.*不能直接升级/)

    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('以毫秒精度比较页面传入的版本，避免数据库微秒导致误报并发冲突', async () => {
    const before = {
      roleKey: 'role-custom',
      name: '测试角色',
      description: null,
      actions: ['dashboard:view'],
      canAccessAdmin: true,
      isSuperAdmin: false,
      isStoreManager: false,
      // JS Date 无法表达数据库里实际保存的额外微秒。
      updatedAt: new Date('2026-08-12T08:00:00.123Z'),
    }
    const expectedUpdatedAt = '2026-08-12T08:00:00.123Z'
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
    ;(db.transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (callback) => callback({
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ roleKey: before.roleKey }]),
          })),
        })),
      })),
      select: vi.fn(() => ({ from: vi.fn().mockResolvedValue([]) })),
      execute: vi.fn().mockResolvedValue(undefined),
    }))

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      actions: before.actions,
      expectedUpdatedAt,
    })).resolves.toEqual({ success: true, message: '角色已保存' })

    const lockCall = vi.mocked(sql).mock.calls.find(([strings]) => (
      String(strings).includes("date_trunc('milliseconds'")
    ))
    expect(lockCall?.[2]).toBe(expectedUpdatedAt)
  })

  /**
   * ## 降级超管角色是「至少保留 1 名在职超管」的第四个入口（#318）
   *
   * 另外三个是 `updateEmployee` 标离职、`deleteEmployee`、`revokeRole` 撤超管 ——
   * 它们都取 `admin:active_count` 那把 advisory lock，这里当时既没取锁、计数还在事务外。
   * 并发「降级角色 R1」+「撤销某人的 R2 绑定」各自都读到「还有别的在职超管」→ 双双提交 → 零超管。
   */
  describe('降级超管角色 —— 与其它三个入口共用 admin:active_count 锁（#318）', () => {
    const superBefore = {
      roleKey: 'role-super',
      name: '超级管理员',
      description: null,
      actions: ['system:config', 'permission:assign_admin', 'admin:reset_password'],
      allowedScopeTypes: ['总部'],
      canAccessAdmin: true,
      isSuperAdmin: true,
      isStoreManager: false,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }

    /**
     * @param casRowCount CAS UPDATE 命中行数（0 = 乐观锁未命中）
     * @returns `txExecute` 断言取过锁；`txUpdate` 断言写库时机
     */
    function mockDowngradeTx(casRowCount = 1) {
      const txExecute = vi.fn().mockResolvedValue(undefined)
      const order: string[] = []
      const txUpdate = vi.fn(() => {
        order.push('update')
        return {
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue(
                casRowCount > 0 ? [{ roleKey: superBefore.roleKey }] : [],
              ),
            })),
          })),
        }
      })
      let handedTx: Record<string, unknown> = {}
      ;(db.transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (callback: Function) => {
        handedTx = {
          execute: txExecute,
          update: txUpdate,
          // 兼容镜像表的全量读是 `await select().from()`，所以 from() 的返回值要自身可 await
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              then: (resolve: (v: unknown[]) => unknown) => resolve([]),
            })),
          })),
        }
        return callback(handedTx)
      })
      return { txExecute, txUpdate, order, tx: () => handedTx }
    }

    it('降级时取的是 admin:active_count 那把锁，且计数走事务句柄', async () => {
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([superBefore]))
      const t = mockDowngradeTx()

      await updateRoleDefinition(superBefore.roleKey, {
        name: superBefore.name,
        isSuperAdmin: false,
        actions: ['dashboard:view'],
      })

      expect(JSON.stringify(t.txExecute.mock.calls[0]?.[0])).toContain('admin:active_count')
      expect(vi.mocked(countActiveAdmins).mock.calls[0][0], '计数必须走事务句柄').toBe(t.tx())
    })

    /**
     * 「先改再数」（#318 第 2 轮，codex P2）：守卫排在 CAS UPDATE **之后**。
     * 排在前面时，一次注定失败的乐观锁提交会先撞上「至少保留 1 名超管」，
     * 把用户带到完全错误的方向。
     */
    it('别无在职超管时拒绝降级（回滚），且守卫发生在 UPDATE 之后', async () => {
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([superBefore]))
      vi.mocked(countActiveAdmins).mockResolvedValue(0)
      const t = mockDowngradeTx()

      await expect(updateRoleDefinition(superBefore.roleKey, {
        name: superBefore.name,
        isSuperAdmin: false,
        actions: ['dashboard:view'],
      })).rejects.toThrow(/INVALID_STATE.*至少需保留 1 名在职超级管理员/)

      expect(t.txUpdate, 'UPDATE 先发生，靠回滚撤销').toHaveBeenCalled()
    })

    /** 乐观锁未命中时不该去数超管 —— 该报的是「已被其他人修改」 */
    it('CAS 未命中 → 报并发冲突，不查超管计数', async () => {
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([superBefore]))
      vi.mocked(countActiveAdmins).mockResolvedValue(0)
      mockDowngradeTx(0)

      const result = await updateRoleDefinition(superBefore.roleKey, {
        name: superBefore.name,
        isSuperAdmin: false,
        actions: ['dashboard:view'],
      })

      expect(result).toEqual({ success: false, message: '角色已被其他人修改，请刷新重试' })
      expect(countActiveAdmins).not.toHaveBeenCalled()
    })

    /**
     * capability 变更的**两个方向都取锁**（#318 第 2 轮）——「谁是活跃超管」由绑定与
     * 角色定义的超管位共同决定，而 assign/revoke 是按锁内重读的 `is_super_admin` 决策的；
     * 升级方向不取锁，它们就会读到一个正在变的判据。
     */
    it('升级为超管也取锁（不只降级）', async () => {
      const normalBefore = { ...superBefore, roleKey: 'role-custom', isSuperAdmin: false }
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([normalBefore]))
      const t = mockDowngradeTx()

      await updateRoleDefinition(normalBefore.roleKey, {
        name: normalBefore.name,
        isSuperAdmin: true,
        actions: [
          'system:config', 'system:diagnostics', 'permission:assign_admin', 'admin:reset_password',
        ],
      })

      const lockTaken = t.txExecute.mock.calls.some(
        (c) => JSON.stringify(c[0]).includes('admin:active_count'),
      )
      expect(lockTaken).toBe(true)
    })

    /** 不动 capability 的普通编辑（改名/改动作）不该取锁 —— 别无谓串行化所有角色编辑 */
    it('不动 capability 的普通编辑 → 不取锁、不查计数', async () => {
      const normalBefore = { ...superBefore, roleKey: 'role-custom', isSuperAdmin: false, actions: ['dashboard:view'] }
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([normalBefore]))
      const t = mockDowngradeTx()

      await updateRoleDefinition(normalBefore.roleKey, {
        name: '改个名字',
        actions: ['dashboard:view'],
      })

      const lockTaken = t.txExecute.mock.calls.some(
        (c) => JSON.stringify(c[0]).includes('admin:active_count'),
      )
      expect(lockTaken).toBe(false)
      expect(countActiveAdmins).not.toHaveBeenCalled()
    })
  })
})

describe('normalizeAllowedScopeTypes — 进销存层级与可绑定范围', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.execute).mockResolvedValue([] as never)
  })

  function beforeRow(overrides: Record<string, unknown> = {}) {
    return {
      roleKey: 'role-custom',
      name: '测试角色',
      description: null,
      actions: ['dashboard:view'],
      allowedScopeTypes: ['总部', '市场', '门店'],
      canAccessAdmin: true,
      isSuperAdmin: false,
      isStoreManager: false,
      updatedAt: new Date('2026-08-12T08:00:00.000Z'),
      ...overrides,
    }
  }

  it('持市场层级进销存动作的角色可绑定层级被锁定为市场，忽略传入的多层级', async () => {
    const before = beforeRow({ actions: ['dashboard:view', 'inventory:market_operate'] })
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
    const tx = mockTxCapturingSet()

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      actions: before.actions,
      allowedScopeTypes: ['总部', '市场', '门店'],
    })).resolves.toEqual({ success: true, message: '角色已保存' })

    expect((tx.setValues().allowedScopeTypes as string[])).toEqual(['市场'])
  })

  it('普通角色同时勾选多个进销存层级的动作被拒绝', async () => {
    const before = beforeRow()
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      actions: ['inventory:supply_chain_operate', 'inventory:store_operate'],
    })).rejects.toThrow(/INVALID_PARAMS.*不能混合多个进销存层级/)

    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('超级管理员角色的可绑定层级恒为总部，即使传入市场', async () => {
    const before = beforeRow({
      isSuperAdmin: true,
      actions: ['system:config', 'system:diagnostics', 'permission:assign_admin', 'admin:reset_password'],
      allowedScopeTypes: ['总部'],
    })
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
    const tx = mockTxCapturingSet()

    await expect(updateRoleDefinition(before.roleKey, {
      name: before.name,
      isSuperAdmin: true,
      actions: before.actions,
      allowedScopeTypes: ['市场'],
    })).resolves.toEqual({ success: true, message: '角色已保存' })

    expect(tx.setValues().allowedScopeTypes).toEqual(['总部'])
  })

  it('无进销存动作时保留传入层级（去重），空数组或非法层级报错', async () => {
    const keep = beforeRow()
    ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([keep]))
    const tx = mockTxCapturingSet()
    await expect(updateRoleDefinition(keep.roleKey, {
      name: keep.name,
      actions: keep.actions,
      allowedScopeTypes: ['门店', '门店'],
    })).resolves.toEqual({ success: true, message: '角色已保存' })
    expect(tx.setValues().allowedScopeTypes).toEqual(['门店'])

    for (const invalid of [[], ['区域']] as string[][]) {
      const before = beforeRow()
      ;(db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockSelectOnce([before]))
      await expect(updateRoleDefinition(before.roleKey, {
        name: before.name,
        actions: before.actions,
        allowedScopeTypes: invalid as never,
      })).rejects.toThrow(/INVALID_PARAMS.*至少需要一个有效的可绑定层级/)
    }
    expect(db.transaction).toHaveBeenCalledTimes(1)
  })
})
