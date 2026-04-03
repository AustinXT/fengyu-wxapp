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
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/cloudbase', () => ({
  uploadFile: vi.fn(),
  reuploadToFixedPath: vi.fn(),
  deleteByCloudPaths: vi.fn(),
}))

import { getSettings, saveSettings } from './settings'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logUpdate } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin' }],
  permissions: { actions: ['system:config'], scopeStoreIds: [] },
}

// ── getSettings ───────────────────────────────────────────────────────────────

describe('getSettings — 系统配置读取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('DB 有记录 → 覆盖默认值', async () => {
    ;(db.execute as any).mockResolvedValue([
      { key: 'new_member_threshold', value: '3000' },
      { key: 'order_timeout', value: '15' },
    ])

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('3000')
    expect(result.orderTimeout).toBe('15')
  })

  it('DB 无记录 → 返回默认值', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('1980')
    expect(result.orderTimeout).toBe('10')
  })

  it('部分配置缺失 → 缺失项用默认值', async () => {
    ;(db.execute as any).mockResolvedValue([
      { key: 'new_member_threshold', value: '3000' },
    ])

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('3000')
    expect(result.orderTimeout).toBe('10') // 默认
  })

  it('DB 异常 → 返回默认值（静默降级）', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('table not found'))

    const result = await getSettings()

    expect(result.newMemberThreshold).toBe('1980')
    expect(result.orderTimeout).toBe('10')
  })
})

// ── saveSettings ──────────────────────────────────────────────────────────────

describe('saveSettings — 系统配置保存', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('正常保存 → 执行 CREATE TABLE + 4 次 UPSERT + banner_count 查询/保存 + 日志', async () => {
    ;(db.execute as any).mockResolvedValue([])

    const result = await saveSettings({
      newMemberThreshold: '2000',
      orderTimeout: '20',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('保存成功')
    // getSettings SELECT + CREATE TABLE + 4 UPSERT + SELECT banner_count + UPSERT banner_count = 8
    expect(db.execute).toHaveBeenCalledTimes(8)
    expect(logUpdate).toHaveBeenCalledWith(
      mockSession, 'system.saveConfig', 'system_config', 'all',
      expect.anything(), expect.objectContaining({ newMemberThreshold: '2000' }),
    )
  })

  it('DB 异常 → 返回失败消息', async () => {
    ;(db.execute as any).mockRejectedValue(new Error('disk full'))

    const result = await saveSettings({
      newMemberThreshold: '1980',
      orderTimeout: '10',
      bannerImages: [],
      fengyuguanImage: '',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('保存失败')
  })
})
