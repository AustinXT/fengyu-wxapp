import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { execute: vi.fn() },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))
vi.mock('child_process', () => ({
  default: { execFile: mockExecFile },
  execFile: mockExecFile,
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { getSyncHistory, triggerSync } from './sync'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin' }],
  permissions: { actions: ['sync:trigger', 'sync:status'], scopeStoreIds: [] },
}

// ── getSyncHistory ────────────────────────────────────────────────────────────

describe('getSyncHistory — 同步历史', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回格式化的历史记录', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        id: 1,
        operator_name: '管理员',
        action: 'sync.full',
        detail: { status: '成功', duration: '3m20s' },
        created_at: new Date('2026-03-15T08:00:00Z'),
      },
      {
        id: 2,
        operator_name: '管理员',
        action: 'sync.incremental',
        detail: null,
        created_at: '2026-03-14T08:00:00',
      },
    ])

    const result = await getSyncHistory()

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(1)
    expect(result[0].type).toBe('全量同步')
    expect(result[0].status).toBe('成功')
    expect(result[0].operator).toBe('管理员')
    expect(result[0].duration).toBe('3m20s')
    expect(result[1].type).toBe('增量同步')
    expect(result[1].status).toBe('成功') // null detail → 默认 '成功'
    expect(result[1].duration).toBe('-') // null detail → 默认 '-'
  })

  it('DB 异常 → 返回 []', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('connection lost'))

    const result = await getSyncHistory()

    expect(result).toEqual([])
  })

  it('空结果 → 返回 []', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await getSyncHistory()

    expect(result).toEqual([])
  })

  it('未知 action → 原值返回', async () => {
    ;(db.execute as any).mockResolvedValue([{
      id: 3, operator_name: 'sys', action: 'sync.custom',
      detail: { status: '完成' }, created_at: new Date(),
    }])

    const result = await getSyncHistory()

    expect(result[0].type).toBe('sync.custom')
  })
})

// ── triggerSync ───────────────────────────────────────────────────────────────

describe('triggerSync — 同步触发 + 互斥锁', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('全量同步成功 → 记录日志 + revalidate', async () => {
    ;mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: Function) => cb(null, 'ok', '')
    )

    const result = await triggerSync('full')

    expect(result.success).toBe(true)
    expect(result.message).toContain('全量同步完成')
    expect(result.message).toMatch(/\d+\.\ds/)
    // 记录 2 次日志：开始 + 完成
    expect(logOperation).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'sync.full', 'sync', 'full',
      expect.objectContaining({ status: '同步中' }),
    )
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'sync.full', 'sync', 'full',
      expect.objectContaining({ status: '成功' }),
    )
  })

  it('增量同步 → 传 --incremental 参数', async () => {
    ;mockExecFile.mockImplementation(
      (_cmd: any, args: any, _opts: any, cb: Function) => {
        expect(args[args.length - 1]).toBe('--incremental')
        cb(null, '', '')
      }
    )

    const result = await triggerSync('incremental')

    expect(result.success).toBe(true)
    expect(result.message).toContain('增量同步完成')
  })

  it('脚本执行失败 → 返回错误消息 + 记录失败日志', async () => {
    ;mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: Function) =>
        cb(new Error('timeout'), '', 'process timed out')
    )

    const result = await triggerSync('full')

    expect(result.success).toBe(false)
    expect(result.message).toContain('同步失败')
    expect(result.message).toContain('process timed out')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'sync.full', 'sync', 'full',
      expect.objectContaining({ status: '失败' }),
    )
  })

  it('互斥锁 — 并发触发时第二次被拒', async () => {
    // 第一次同步不完成（cb 不调用），模拟长时间运行
    let firstCb: Function | null = null
    ;mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: Function) => { firstCb = cb }
    )

    // 发起第一次同步（不 await，让它挂起）
    const first = triggerSync('full')

    // 第二次同步应被互斥锁拒绝
    const second = await triggerSync('full')

    expect(second.success).toBe(false)
    expect(second.message).toContain('正在执行中')

    // 完成第一次同步以释放锁
    firstCb!(null, '', '')
    await first
  })

  it('互斥锁 — 失败后释放（finally）', async () => {
    ;mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: Function) =>
        cb(new Error('fail'), '', 'error')
    )

    // 第一次失败
    await triggerSync('full')

    // 第二次应允许（锁已释放）
    ;mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: Function) => cb(null, '', '')
    )
    const result = await triggerSync('full')

    expect(result.success).toBe(true)
  })
})
