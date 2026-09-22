import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', name: 'name', phone: 'phone', storeId: 'store_id', isResigned: 'is_resigned' },
}))
vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id' },
}))
vi.mock('@db/permission', () => ({ permissionRoles: { employeeId: 'employee_id' } }))
vi.mock('@db/admin-auth', () => ({ adminPasswords: { employeeId: 'employee_id' } }))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  // 保留模板参数，否则断言不到 SQL 文本（与 employees.test.ts 的 mock 对齐）
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ type: 'sql', args })), { raw: vi.fn() }),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  desc: vi.fn((c) => ({ type: 'desc', c })),
  asc: vi.fn((c) => ({ type: 'asc', c })),
}))
vi.mock('drizzle-orm/pg-core', () => ({ alias: vi.fn((t) => t) }))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  employeeScopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
  isOrgNodeInScope: vi.fn(() => true),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn(async () => 3),
  isAdminEmployee: vi.fn(async () => false),
}))
vi.mock('@/lib/datetime', () => ({ shanghaiToday: vi.fn(() => '2026-06-01') }))
vi.mock('@/lib/list-filters', () => ({ parseEmployeeFilters: vi.fn(() => ({})) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deleteEmployee } from './employees'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { isAdminEmployee, countActiveAdmins } from '@/lib/admin-guard'
import { staffWechatUsers } from '@db/user'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

/**
 * 事务：staffWechatUsers 删除按 staffResult 控制（count 或 throw），其余从属删除恒成功。
 *
 * 守卫与 `employee.delete` 审计现在**都在事务内**（与 `updateEmployee` 同构，
 * GLM 谱系第 10 轮 P2-2）：守卫留在事务外是 check-then-act，两个超级 admin 并发互删会
 * 双双通过 → 零管理员；审计留在事务外则会留下「员工已删 + 前端 500」。
 * 所以 tx 上还要有 `execute`（advisory lock）。
 *
 * @returns `tx()` 交出那个句柄，审计的 executor 断言要用**同一性**
 *   —— 形状匹配对全局 `db` 也成立，等于没锁。
 */
/**
 * @param lockedRow 事务内 `FOR UPDATE` 重读到的那一行。守卫的「目标是否在职」与审计快照
 *   都用它 —— 事务外那份 `emp` 到这时可能已被并发改过（codex / GLM 第 12 轮）。
 *   默认与事务外同值；要测「事务外已离职、锁内已复职」这类交错就显式传。
 */
function setupTx(
  staffResult: { count?: number; throwErr?: any },
  lockedRow: any = { name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false },
) {
  let handedTx: any
  const txExecute = vi.fn().mockResolvedValue([])
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const limit = vi.fn().mockResolvedValue(lockedRow ? [lockedRow] : [])
    handedTx = {
      execute: txExecute,
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit }), limit }),
        }),
      }),
      delete: vi.fn().mockImplementation((table: any) => ({
        where: vi.fn().mockImplementation(async () => {
          if (table === staffWechatUsers) {
            if (staffResult.throwErr) throw staffResult.throwErr
            return { count: staffResult.count ?? 1 }
          }
          return { count: 1 }
        }),
      })),
    }
    return fn(handedTx)
  })
  return { tx: () => handedTx, txExecute }
}

describe('deleteEmployee — 守卫 + 级联 + FK 兜底', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminEmployee as any).mockResolvedValue(false)
    ;(countActiveAdmins as any).mockResolvedValue(3)
    /**
     * ⚠️ `vi.clearAllMocks()` 只清调用记录，**不清 mockImplementation** ——
     * 上一条用例把 `logOperation` 设成 reject 会一路泄漏。
     * 这个坑本 PR 里踩了三次（审计 mock、admin 计数、这里），一律在 beforeEach 显式恢复。
     */
    ;(logOperation as any).mockResolvedValue(undefined)
  })

  it('删除自己 → 拒绝', async () => {
    const result = await deleteEmployee('ADMIN-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('自己')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('员工不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deleteEmployee('EMP-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 守卫**在事务内**（GLM 第 10 轮 P2-2）：事务会开、但整体回滚。
   * 判据因此从「事务没开」变成「一行都没删 + 守卫的两次查询都走 tx + 取过 advisory lock」。
   */
  it('最后一个活跃管理员 → 拒绝，且事务回滚、一行未删', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false }])
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(1)
    const t = setupTx({ count: 1 })

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('最后一个活跃管理员')
    expect(t.tx().delete, '守卫应在任何删除之前抛出').not.toHaveBeenCalled()
    expect((isAdminEmployee as any).mock.calls[0][1], '守卫查询要走 tx').toBe(t.tx())
    expect((countActiveAdmins as any).mock.calls[0][0], '计数查询要走 tx').toBe(t.tx())
    expect(JSON.stringify(t.txExecute.mock.calls[0][0]), '守卫前要取 advisory lock')
      .toContain('pg_advisory_xact_lock')
  })

  /** 两个超级 admin 并发互删的不变量：锁与离职路径**同一把**（源码守护，见 employees.test.ts） */
  it('删除非最后管理员 → 放行，但仍取过 advisory lock', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false }])
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(3)
    const t = setupTx({ count: 1 })

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(true)
    expect(JSON.stringify(t.txExecute.mock.calls[0][0])).toContain('pg_advisory_xact_lock')
  })

  it('纯测试号 → 级联删除成功 + 审计走同一个事务', async () => {
    mockSelect([{ name: '测试', phone: '13800000001', storeId: 'S1', isResigned: false }])
    const t = setupTx({ count: 1 })
    const result = await deleteEmployee('EMP-TEST')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'employee.delete', 'employee', 'EMP-TEST',
      expect.objectContaining({ snapshot: expect.any(Object) }),
      // 第 6 参必须是**那个 tx**：留在事务外时它失败会留下「员工已删 + 前端 500」
      t.tx(),
    )
  })

  it('被业务表引用（23503）→ 回滚 + 提示改离职', async () => {
    mockSelect([{ name: '老员工', phone: '13800000002', storeId: 'S1', isResigned: false }])
    const fkErr: any = new Error('insert or update violates foreign key constraint')
    fkErr.code = '23503'
    setupTx({ throwErr: fkErr })
    const result = await deleteEmployee('EMP-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('业务关联')
    expect(result.message).toContain('离职')
  })

  /**
   * **两谱系第 12 轮共识**：`23503` 必须按**阶段**归因，不能按约束名前缀。
   *
   * 员工只要登录过后台就有操作日志，主表 `DELETE` 撞的正是
   * `operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk` ——
   * 按前缀分类会把这个**最高频**的拦截场景误报成「数据冲突，请稍后重试」，
   * 用户重试永远不会成功，也永远拿不到「建议改为离职」这个正确指引。
   */
  it('删除有操作日志的员工（主表撞 operation_logs FK）→ 提示改为离职，不是「数据冲突」', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false }])
    setupTx({
      throwErr: Object.assign(new Error('fk'), {
        code: '23503',
        // 真名（drizzle 默认命名规则），已用 pg_constraint 核对
        constraint: 'operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk',
      }),
    })

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('建议改为离职')
    expect(result.message).not.toContain('数据冲突')
  })

  /** 而审计写入阶段撞同一个约束（操作者被并发删）才是暂时性冲突 */
  it('审计写入阶段撞同一个 FK → 「数据冲突，请稍后重试」', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false }])
    setupTx({ count: 1 })
    ;(logOperation as any).mockRejectedValue(Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk',
    }))

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(false)
    expect(result.message).toBe('数据冲突，请稍后重试')
  })

  /**
   * 守卫的「目标是否在职」必须用**锁内**重读的行（codex 第 12 轮 P1）。
   *
   * 事务外读到「E 已离职（残留 admin 角色）」→ 跳过守卫；期间 E 被复职、另一名活跃 admin
   * 合法离职 → E 成了唯一活跃 admin，却因旧快照被删掉 → 零管理员。
   */
  it('事务外读到已离职、锁内已复职 → 守卫仍生效，拒绝删除唯一活跃 admin', async () => {
    mockSelect([{ name: '张三', phone: '13800000000', storeId: 'S1', isResigned: true }])
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(1)
    // 锁内重读到的是「已复职」
    const t = setupTx({ count: 1 }, { name: '张三', phone: '13800000000', storeId: 'S1', isResigned: false })

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('最后一个活跃管理员')
    expect(t.tx().delete, '守卫拦住后一行都不该删').not.toHaveBeenCalled()
  })

  /** 审计快照也用锁内那份 —— 事务外那份可能是并发改之前的旧姓名/手机号 */
  it('审计快照用锁内重读的行，不是事务外那份', async () => {
    mockSelect([{ name: '旧名', phone: '13800000000', storeId: 'S1', isResigned: false }])
    const t = setupTx({ count: 1 }, { name: '新名', phone: '13900000000', storeId: 'S2', isResigned: false })

    const result = await deleteEmployee('EMP-1')

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'employee.delete', 'employee', 'EMP-1',
      expect.objectContaining({ snapshot: expect.objectContaining({ name: '新名', phone: '13900000000' }) }),
      t.tx(),
    )
  })

  it('主表删除 rowCount=0（并发）→ 提示刷新', async () => {
    mockSelect([{ name: 'x', phone: '13800000003', storeId: 'S1', isResigned: false }])
    setupTx({ count: 0 })
    const result = await deleteEmployee('EMP-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
