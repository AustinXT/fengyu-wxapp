import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), log: vi.fn(), org: vi.fn(), admin: vi.fn(), scope: vi.fn(), employee: vi.fn(), global: true, revoke: true }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }))
vi.mock('@/lib/with-permission', () => ({ withPermission: (_: string, fn: any) => (...args: any[]) => fn({ employeeId: 'operator', roles: [{ scopeId: 'root' }] }, ...args) }))
vi.mock('@/lib/permissions', () => ({ isAdminScope: () => mocks.global, hasPermission: () => mocks.revoke }))
vi.mock('@/lib/org-ancestry', () => ({ isEmployeeWithinScopeRoots: mocks.employee, isNodeWithinScopeRoots: mocks.scope }))
vi.mock('@/lib/invariant-locks', () => ({ lockOrgTree: mocks.org, lockActiveAdminCount: mocks.admin }))
vi.mock('@/lib/operation-log', () => ({ logOperation: mocks.log }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { reviewEmployeeRoleMigration, getEmployeeRoleMigration } from './role-migrations'
const dialect = new PgDialect()
const input = { employeeId: 'E', targetScopeId: 'new', decision: 'migrate' as const, bindings: [{ id: 1, role: 'manager', scopeId: 'old' }] }
let casRows: any[], existing: any[], current: any[], resigned: boolean
const statements: string[] = []
beforeEach(() => {
  vi.clearAllMocks(); mocks.global = true; mocks.revoke = true; casRows = [{ id: 1 }]; existing = []; current = [{ id: 1 }]; resigned = false; statements.length = 0
  mocks.scope.mockResolvedValue(true); mocks.employee.mockResolvedValue(true)
  mocks.transaction.mockImplementation((fn: any) => fn({ execute: mocks.execute }))
  mocks.execute.mockImplementation(async query => {
    const text = dialect.sqlToQuery(query).sql; statements.push(text)
    if (text.includes('SELECT store_id AS')) return [{ storeId: 'S', orgNodeId: 'new', is_resigned: resigned }]
    if (text.includes('SELECT s.org_node_id')) return [{ org_node_id: 'new' }]
    if (text.includes('FOR UPDATE OF pr')) return current
    if (text.includes('SELECT id FROM permission_roles')) return existing
    if (text.includes('RETURNING id')) return casRows
    return []
  })
})
describe('人工角色迁移', () => {
  it('锁序org→admin→员工；UPDATE用完整CAS并写审计', async () => {
    await reviewEmployeeRoleMigration(input)
    expect(mocks.org.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0])
    expect(mocks.admin.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0])
    const update = statements.find(s => s.includes('UPDATE permission_roles'))!
    expect(update).toMatch(/WHERE id = [\s\S]* AND employee_id = [\s\S]* AND role = [\s\S]* AND scope_id = [\s\S]* RETURNING id/)
    expect(mocks.log).toHaveBeenCalledWith(expect.anything(), 'permission.scopeMigrate', 'permission_role', 'E', expect.objectContaining({ oldScopeId: 'old', newScopeId: 'new', keptExisting: false }), expect.anything())
  })
  it('目标已有同角色时移除旧CAS绑定，保留目标，不新增', async () => {
    existing = [{ id: 2 }]; await reviewEmployeeRoleMigration(input)
    expect(statements.some(s => s.includes('DELETE FROM permission_roles'))).toBe(true)
    expect(statements.some(s => s.includes('UPDATE permission_roles'))).toBe(false)
    expect(mocks.log.mock.calls[0][4].keptExisting).toBe(true)
  })
  it('迁移必须兼具撤销权限，拒绝前无写入', async () => {
    mocks.revoke = false; await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('PERMISSION_DENIED:')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('CAS0行必须拒绝且不记成功审计', async () => {
    casRows = []; await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('CONFLICT:')
    expect(mocks.log).not.toHaveBeenCalled()
  })
  it('旧绑定已变化、离职、目标门店变化均拒绝', async () => {
    current = []; await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('CONFLICT:')
    current = [{ id: 1 }]; resigned = true; await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('INVALID_STATE:')
    resigned = false; await expect(reviewEmployeeRoleMigration({ ...input, targetScopeId: 'stale' })).rejects.toThrow('CONFLICT:')
  })
  it('非全局操作者两端scope任一不满足即零修改', async () => {
    mocks.global = false; mocks.scope.mockResolvedValue(false)
    await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('PERMISSION_DENIED:')
    expect(statements.some(s => s.includes('RETURNING id'))).toBe(false)
  })
  it('非法/重复ID与无真实事件的保留兼任请求拒绝', async () => {
    await expect(reviewEmployeeRoleMigration({ ...input, bindings: [input.bindings[0], input.bindings[0]] })).rejects.toThrow('INVALID_PARAMS:')
    await expect(reviewEmployeeRoleMigration({ ...input, decision: 'retain' })).rejects.toThrow('INVALID_PARAMS:')
  })
  it('空绑定元素用参数错误拒绝', async () => {
    await expect(reviewEmployeeRoleMigration({ ...input, bindings: [null] as any })).rejects.toThrow('INVALID_PARAMS:')
  })
  it('按员工查询也验证真实树可见性，不可见不泄露绑定', async () => {
    mocks.global = false; mocks.employee.mockResolvedValue(false)
    await expect(getEmployeeRoleMigration('E')).rejects.toThrow('NOT_FOUND:')
    expect(statements).toHaveLength(1)
  })
})
