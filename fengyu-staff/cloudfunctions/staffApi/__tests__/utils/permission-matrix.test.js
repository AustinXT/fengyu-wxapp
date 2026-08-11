/**
 * staff 管理层视图与 admin 数据中心权限矩阵对齐。
 */

const fs = require('node:fs')
const path = require('node:path')

const pg = globalThis.__mocks__.pg
const {
  FALLBACK_DASHBOARD_ROLES,
  getDashboardRoles,
  hasDataCenterDashboard,
  invalidatePermissionMatrixCache,
} = require('../../utils/permission-matrix')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const ADMIN_PERMISSIONS_FILE = path.join(REPO_ROOT, 'fengyu-admin/src/lib/permissions.ts')

function getAdminDefaultDashboardRoles() {
  const source = fs.readFileSync(ADMIN_PERMISSIONS_FILE, 'utf8')
  const roles = ['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr', 'staff']

  return roles.filter((role) => {
    const block = source.match(new RegExp(`^  ${role}: \\[([\\s\\S]*?)\\],`, 'm'))
    if (!block) {
      throw new Error(`未能解析 admin DEFAULT_PERMISSION_MATRIX.${role}`)
    }
    return /['"]data_center:dashboard['"]/.test(block[1])
  })
}

describe('permission-matrix data_center:dashboard', () => {
  beforeEach(() => {
    invalidatePermissionMatrixCache()
    pg.query.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('按运行时矩阵授予和撤销 dashboard 权限', async () => {
    pg.query
      .mockResolvedValueOnce([{ role_key: 'manager', actions: ['data_center:dashboard'] }, { role_key: 'finance', actions: [] }])
      .mockResolvedValueOnce([{ role_key: 'manager', actions: [] }, { role_key: 'finance', actions: ['data_center:dashboard'] }])

    expect(await hasDataCenterDashboard([{ role: 'manager' }])).toBe(true)
    expect(await hasDataCenterDashboard([{ role: 'finance' }])).toBe(false)

    invalidatePermissionMatrixCache()

    expect(await hasDataCenterDashboard([{ role: 'manager' }])).toBe(false)
    expect(await hasDataCenterDashboard([{ role: 'finance' }])).toBe(true)
  })

  test('成功读取的矩阵缓存 30 秒，过期后重新读取', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'))
    pg.query
      .mockResolvedValueOnce([{ role_key: 'hr', actions: ['data_center:dashboard'] }])
      .mockResolvedValueOnce([{ role_key: 'finance', actions: ['data_center:dashboard'] }])

    expect(await hasDataCenterDashboard(['hr'])).toBe(true)
    expect(await hasDataCenterDashboard(['finance'])).toBe(false)
    expect(pg.query).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_001)

    expect(await hasDataCenterDashboard(['finance'])).toBe(true)
    expect(pg.query).toHaveBeenCalledTimes(2)
  })

  test('没有角色持有 dashboard 权限时返回空集合，不恢复旧默认值', async () => {
    pg.query.mockResolvedValueOnce([
      { role_key: 'admin', actions: [] },
      { role_key: 'role_custom', actions: [] },
    ])

    const roles = await getDashboardRoles()

    expect([...roles]).toEqual([])
  })

  test('查询角色定义表并识别自定义角色', async () => {
    pg.query.mockResolvedValueOnce([{ role_key: 'role_custom', actions: ['data_center:dashboard'] }])
    expect(await hasDataCenterDashboard(['role_custom'])).toBe(true)
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM permission_role_definitions'),
    )
  })

  test('数据库异常不缓存，回退默认角色', async () => {
    pg.query.mockRejectedValue(new Error('database unavailable'))

    expect(await hasDataCenterDashboard(['manager'])).toBe(true)
    expect(await hasDataCenterDashboard(['product'])).toBe(false)
    expect(pg.query).toHaveBeenCalledTimes(2)
  })

  test('降级角色集与 admin DEFAULT_PERMISSION_MATRIX 保持一致', () => {
    expect([...FALLBACK_DASHBOARD_ROLES].sort()).toEqual(
      getAdminDefaultDashboardRoles().sort(),
    )
  })
})
