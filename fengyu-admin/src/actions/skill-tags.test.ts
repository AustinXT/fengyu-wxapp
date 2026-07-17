import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
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

import { deleteSkillTag, updateSkillTag } from './skill-tags'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
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
