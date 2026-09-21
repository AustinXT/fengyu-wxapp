import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
}))

vi.mock('@db/lookup', () => ({
  skillTags: { id: 'id', name: 'name', sortOrder: 'sort_order', isValid: 'is_valid', updatedAt: 'updated_at' },
}))
vi.mock('@db/user', () => ({
  staffWechatUsers: { skills: 'skills', updatedAt: 'updated_at' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
  asc: vi.fn((c) => ({ type: 'asc', c })),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn(() => null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createSkillTag, deleteSkillTag, getSkillTags, updateSkillTag } from './skill-tags'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import { staffWechatUsers } from '@db/user'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:update'], scopeStoreIds: [] },
}

/** db.select(...).from().where().limit() 链式 mock，limit 解析为给定行数组。 */
function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

/**
 * deleteSkillTag 事务：① tx.update(staffWechatUsers) 级联返回 cascadeCount；
 * ② tx.delete(skillTags) 返回 delCount（0 = 并发已删）。返回 tx 供断言级联调用。
 */
function setupDeleteTx({ cascadeCount, delCount }: { cascadeCount: number; delCount: number }) {
  let exposedTx: any
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      update: vi.fn().mockImplementation((table: any) => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ count: cascadeCount }),
        }),
      })),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ count: delCount }),
      }),
    }
    exposedTx = tx
    return fn(tx)
  })
  return () => exposedTx
}

/**
 * updateSkillTag 事务：若触达 staffWechatUsers（改名），其 update.where 返回 staffCount；
 * skillTags 的 update.where 返回 tagCount 或抛 tagThrow。
 */
function setupUpdateTx({
  staffCount,
  tagCount,
  tagThrow,
}: {
  staffCount: number
  tagCount: number
  tagThrow?: any
}) {
  let exposedTx: any
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      update: vi.fn().mockImplementation((table: any) => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(async () => {
            if (table === staffWechatUsers) return { count: staffCount }
            if (tagThrow) throw tagThrow
            return { count: tagCount }
          }),
        }),
      })),
    }
    exposedTx = tx
    return fn(tx)
  })
  return () => exposedTx
}

describe('deleteSkillTag — 删除级联清理员工 skills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('标签不存在 → 拒绝，不进事务', async () => {
    mockSelect([])
    const result = await deleteSkillTag('stag-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('正常删除 → 事务内先级联员工 array_remove，再删字典行；审计含 affectedStaff', async () => {
    mockSelect([{ name: '美容师' }])
    const getTx = setupDeleteTx({ cascadeCount: 3, delCount: 1 })
    const result = await deleteSkillTag('stag-1')
    const tx = getTx()

    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    // 级联触达员工表
    expect(tx.update).toHaveBeenCalledWith(staffWechatUsers)
    expect(tx.delete).toHaveBeenCalled()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'skillTag.delete',
      'skill_tag',
      'stag-1',
      expect.objectContaining({ name: '美容师', affectedStaff: 3 }),
    )
  })

  it('并发已被删（字典 delCount=0）→ 事务回滚，报不存在，不记审计', async () => {
    mockSelect([{ name: '美容师' }])
    setupDeleteTx({ cascadeCount: 1, delCount: 0 })
    const result = await deleteSkillTag('stag-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(logOperation).not.toHaveBeenCalled()
  })

  it('标签无人使用（cascadeCount=0）→ 仍成功，affectedStaff=0', async () => {
    mockSelect([{ name: '冷门技能' }])
    setupDeleteTx({ cascadeCount: 0, delCount: 1 })
    const result = await deleteSkillTag('stag-2')
    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'skillTag.delete',
      'skill_tag',
      'stag-2',
      expect.objectContaining({ name: '冷门技能', affectedStaff: 0 }),
    )
  })
})

describe('updateSkillTag — 改名级联 array_replace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('改名 → 事务内先级联员工 array_replace，再更新字典行（update 调 2 次）', async () => {
    mockSelect([{ name: '旧名', sortOrder: 0, isValid: true, updatedAt: '2026-01-01T00:00:00Z' }])
    const getTx = setupUpdateTx({ staffCount: 5, tagCount: 1 })
    const result = await updateSkillTag('stag-1', { name: '新名' }, '2026-01-01T00:00:00Z')
    const tx = getTx()

    expect(result.success).toBe(true)
    expect(tx.update).toHaveBeenCalledTimes(2)
    // 第一次 update 必须作用在员工表（级联）
    expect(tx.update.mock.calls[0][0]).toBe(staffWechatUsers)
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession,
      'skillTag.update',
      'skill_tag',
      'stag-1',
      expect.objectContaining({ name: '旧名' }),
      expect.objectContaining({ name: '新名', affectedStaff: 5 }),
    )
  })

  it('仅改 sortOrder → 不触发员工级联（update 只调 1 次，作用于字典表）', async () => {
    mockSelect([{ name: '美容师', sortOrder: 0, isValid: true, updatedAt: '2026-01-01T00:00:00Z' }])
    const getTx = setupUpdateTx({ staffCount: 99, tagCount: 1 })
    const result = await updateSkillTag('stag-1', { sortOrder: 5 }, '2026-01-01T00:00:00Z')
    const tx = getTx()

    expect(result.success).toBe(true)
    expect(tx.update).toHaveBeenCalledTimes(1)
    expect(tx.update.mock.calls[0][0]).not.toBe(staffWechatUsers)
  })

  it('name 与旧名相同 → 视为未改名，不触发员工级联', async () => {
    mockSelect([{ name: '美容师', sortOrder: 0, isValid: true, updatedAt: '2026-01-01T00:00:00Z' }])
    const getTx = setupUpdateTx({ staffCount: 99, tagCount: 1 })
    await updateSkillTag('stag-1', { name: '美容师' })
    const tx = getTx()
    expect(tx.update).toHaveBeenCalledTimes(1)
    expect(tx.update.mock.calls[0][0]).not.toBe(staffWechatUsers)
  })

  it('乐观锁冲突（字典 count=0 + expectedUpdatedAt）→ 已被其他人修改', async () => {
    mockSelect([{ name: '美容师', sortOrder: 0, isValid: true, updatedAt: '2026-01-02T00:00:00Z' }])
    setupUpdateTx({ staffCount: 1, tagCount: 0 })
    const result = await updateSkillTag('stag-1', { name: '新名' }, '2026-01-01T00:00:00Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('唯一约束 23505（新名已存在）→ 该标签名称已存在', async () => {
    mockSelect([{ name: '旧名', sortOrder: 0, isValid: true, updatedAt: '2026-01-01T00:00:00Z' }])
    const dupErr: any = new Error('duplicate key')
    dupErr.code = '23505'
    ;(pgErrorCode as any).mockReturnValue('23505')
    setupUpdateTx({ staffCount: 1, tagCount: 0, tagThrow: dupErr })
    const result = await updateSkillTag('stag-1', { name: '已存在名' }, '2026-01-01T00:00:00Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已存在')
  })

  it('标签不存在 → 拒绝，不进事务', async () => {
    mockSelect([])
    const result = await updateSkillTag('stag-404', { name: '新名' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('空名 → 拒绝，不进事务（与 createSkillTag 一致）', async () => {
    const result = await updateSkillTag('stag-1', { name: '   ' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入标签名称')
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('技能标签写操作 — 仅系统管理员硬闸门（#211）', () => {
  // 店长(manager)/HR 在默认权限矩阵里持有 employee:update，外层 withPermission 放行，
  // 拦截只能来自函数体首行的 requireAdmin。这里模拟它抛错，验证三个写操作都接了闸门
  // 且在拦下时一行 SQL 都不发（UI 隐藏按钮是第二道，不能作为唯一防线）。
  const nonAdminSession = {
    employeeId: 'MGR-001',
    roles: [{ role: 'manager', scopeId: 'store-1' }],
    permissions: { actions: ['employee:update'], scopeStoreIds: ['store-1'] },
  }

  function denyAdmin() {
    ;(requireAdmin as any).mockImplementation(() => {
      throw new Error('PERMISSION_DENIED: 仅系统管理员可执行该操作')
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(nonAdminSession)
  })

  afterEach(() => {
    // 复位为 noop，避免污染同文件后续（及重跑时前面的）用例
    ;(requireAdmin as any).mockImplementation(() => {})
  })

  it('createSkillTag：非管理员 → 抛 PERMISSION_DENIED，不写库', async () => {
    denyAdmin()
    await expect(
      createSkillTag({ id: 'stag-x', name: '新标签', sortOrder: 0 }),
    ).rejects.toThrow('PERMISSION_DENIED')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('updateSkillTag：非管理员 → 抛 PERMISSION_DENIED，连旧值都不读', async () => {
    denyAdmin()
    await expect(updateSkillTag('stag-1', { name: '改名' })).rejects.toThrow('PERMISSION_DENIED')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('deleteSkillTag：非管理员 → 抛 PERMISSION_DENIED，连旧值都不读', async () => {
    denyAdmin()
    await expect(deleteSkillTag('stag-1')).rejects.toThrow('PERMISSION_DENIED')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('空名等入参守卫排在硬闸门之后：非管理员传空名同样抛 PERMISSION_DENIED 而非返回提示', async () => {
    denyAdmin()
    // 若 requireAdmin 被放在空名守卫之后，这里会拿到 {success:false,'请输入标签名称'}，
    // 等于把「该标签名是否合法」的信息泄露给无权者，也说明闸门位置不对。
    await expect(createSkillTag({ id: 'stag-x', name: '  ' })).rejects.toThrow('PERMISSION_DENIED')
    await expect(updateSkillTag('stag-1', { name: '  ' })).rejects.toThrow('PERMISSION_DENIED')
  })

  it('管理员会话：三个写操作都实际调用了 requireAdmin（闸门已接线）', async () => {
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(requireAdmin as any).mockImplementation(() => {})

    const insertChain: any = { values: vi.fn().mockResolvedValue(undefined) }
    ;(db.insert as any).mockReturnValue(insertChain)
    await createSkillTag({ id: 'stag-1', name: '美容师' })
    expect(requireAdmin).toHaveBeenCalledTimes(1)
    // 断言入参而不只是次数：否则 requireAdmin(null)、或传了别人的 session 也能绿
    expect(requireAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'ADMIN-001' }),
    )

    mockSelect([])
    await updateSkillTag('stag-1', { name: '新名' })
    expect(requireAdmin).toHaveBeenCalledTimes(2)

    mockSelect([])
    await deleteSkillTag('stag-1')
    expect(requireAdmin).toHaveBeenCalledTimes(3)
  })

  it('传给 requireAdmin 的是 scopeSessionToActions 收紧后的 session（admin 角色不持 employee:update 会被裁掉）', async () => {
    // 锁定 UI 侧必须用同一口径的原因：withPermission 先把 session 按 employee:update 收紧
    // （with-permission.ts:70 → action-scope.ts:25，只留自身 actions 含该动作的角色行），
    // 再交给业务函数。运营若在矩阵 UI 摘掉 admin 的 employee:update，admin+hr 双角色会话
    // 仍能靠 hr 过外层闸门，但收紧后 roles 只剩 hr —— requireAdmin 看到的已不是管理员。
    // 故 employees/page.tsx 的显隐判定也必须跑一遍 scopeSessionToActions，否则按钮可见却必被拒。
    ;(getSession as any).mockResolvedValue({
      employeeId: 'MIX-001',
      roles: [
        {
          role: 'admin', scopeId: 'hq-1', isSuperAdmin: true,
          actions: ['system:config'], scopeStoreIds: [], scopeOrgNodeIds: ['hq-1'],
        },
        {
          role: 'hr', scopeId: 'mkt-1', isSuperAdmin: false,
          actions: ['employee:update'], scopeStoreIds: ['store-1'], scopeOrgNodeIds: ['mkt-1'],
        },
      ],
      permissions: {
        actions: ['system:config', 'employee:update'],
        scopeStoreIds: ['store-1'], scopeOrgNodeIds: ['mkt-1'],
      },
    })
    ;(requireAdmin as any).mockImplementation(() => {})
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) })

    await createSkillTag({ id: 'stag-9', name: '新标签' })

    const received = (requireAdmin as any).mock.calls[0][0]
    expect(received.roles.map((r: any) => r.role)).toEqual(['hr'])
  })

  it('getSkillTags 读取不受硬闸门影响：非管理员可读，requireAdmin 不参与', async () => {
    // 读取口径刻意停留在 employee:list —— 员工列表/详情/新建、营业额分配三个详情页、
    // 提成矩阵页都依赖它；误加 requireAdmin 会让店长/HR/财务的技能筛选项整体丢数据。
    denyAdmin()
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockResolvedValue([
      { id: 'stag-1', name: '美容师', sortOrder: 0, createdAt: null, updatedAt: null },
    ])
    ;(db.select as any).mockReturnValue(chain)

    const rows = await getSkillTags()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('美容师')
    expect(requireAdmin).not.toHaveBeenCalled()
  })
})
