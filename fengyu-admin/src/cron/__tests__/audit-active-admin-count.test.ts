/**
 * 活跃超级管理员数量巡检（issue #318）
 *
 * 为什么有这个 STEP：admin 侧四个写入入口都收进 `admin:active_count` 锁了，但
 * `db/scripts/sync-workfine.js` 与裸 SQL 仍能写 `is_resigned` 而不取锁。给一个已停用、
 * 且需要 MSSQL 才能跑的脚本加锁既无法验证也容易改坏，所以这条不变量另配**检测**侧。
 *
 * 关键场景：
 *   A ≥2 人 → level=ok，只发一次 SELECT，不写日志不告警
 *   B 1 人 → level=warn（一步之遥）
 *   C 0 人 → level=critical（后台已锁死）
 *   D 只读：永不 UPDATE 业务表，写入仅限 operation_logs
 *   E source='cronTask'
 *   F int8 返回字符串也要算对
 *   G 口径与 lib/admin-guard.ts 的 countActiveAdmins 一致（源码守护）
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sqlTextOf } from './_helpers'

const mockExecute = vi.fn()
const mockDb = {
  execute: mockExecute,
  transaction: vi.fn(),
}

vi.mock('@/db', () => ({
  get db() {
    return mockDb
  },
}))

const notifyOpsMock = vi.fn<(msg: string) => Promise<void>>()
vi.mock('../lib/notify', () => ({
  notifyOps: (msg: string) => notifyOpsMock(msg),
}))

import { auditActiveAdminCount } from '../steps/audit-active-admin-count'

describe('cron-worker — auditActiveAdminCount', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('A. ≥2 人 → ok，只发一次 SELECT，不写日志不告警', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: 3 }])

    const result = await auditActiveAdminCount(mockDb as never)

    expect(result).toEqual({ activeAdminCount: 3, level: 'ok' })
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(notifyOpsMock).not.toHaveBeenCalled()
  })

  it('B. 只剩 1 人 → warn + 写 operation_logs + 告警', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: 1 }]).mockResolvedValueOnce([])

    const result = await auditActiveAdminCount(mockDb as never)

    expect(result.level).toBe('warn')
    expect(notifyOpsMock).toHaveBeenCalledOnce()
    expect(notifyOpsMock.mock.calls[0][0]).toContain('只剩 1 名')
  })

  it('C. 0 人 → critical（后台已锁死）', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: 0 }]).mockResolvedValueOnce([])

    const result = await auditActiveAdminCount(mockDb as never)

    expect(result).toEqual({ activeAdminCount: 0, level: 'critical' })
    expect(notifyOpsMock.mock.calls[0][0]).toContain('没有')
  })

  it('D+E. 写入只落 operation_logs，且 source=cronTask', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: 0 }]).mockResolvedValueOnce([])

    await auditActiveAdminCount(mockDb as never)

    const writes = mockExecute.mock.calls.slice(1).map((c) => sqlTextOf(c[0]))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('INSERT INTO operation_logs')
    expect(writes[0]).toContain("'cronTask'")
    for (const text of mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))) {
      expect(text, '只读审计不得 UPDATE 业务表').not.toMatch(/UPDATE\s+(permission_roles|staff_wechat_users)/)
    }
  })

  /** `COUNT(...)::int` 在 postgres.js 下是 number，但别赌 —— 口径变成 bigint 时也要算对 */
  it('F. count 以字符串返回也要算对', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: '0' }]).mockResolvedValueOnce([])

    const result = await auditActiveAdminCount(mockDb as never)

    expect(result.activeAdminCount).toBe(0)
    expect(result.level).toBe('critical')
  })

  /**
   * G. 口径守护：这条 SQL 必须与 `lib/admin-guard.ts` 的 `countActiveAdmins` 等价 ——
   * 后者是四个写入入口的判据，两边漂移就会出现「写入侧拒绝、巡检说没事」或反过来。
   * cron 是独立 bundle、那边走 drizzle query builder，没法直接 import，所以按特征比对。
   */
  it('G. 与 countActiveAdmins 口径一致：超管角色 × 在职 × 按员工去重', async () => {
    mockExecute.mockResolvedValueOnce([{ active_admins: 5 }])
    await auditActiveAdminCount(mockDb as never)
    const auditSql = sqlTextOf(mockExecute.mock.calls[0][0])

    expect(auditSql).toContain('COUNT(DISTINCT pr.employee_id)')
    expect(auditSql).toContain('d.is_super_admin = true')
    expect(auditSql).toContain('e.is_resigned = false')

    const guardSrc = readFileSync(resolve(process.cwd(), 'src/lib/admin-guard.ts'), 'utf8')
    expect(guardSrc, 'admin-guard 侧也必须是这三条').toContain('count(DISTINCT')
    expect(guardSrc).toContain('permissionRoleDefinitions.isSuperAdmin, true')
    expect(guardSrc).toContain('staffWechatUsers.isResigned, false')
  })
})
