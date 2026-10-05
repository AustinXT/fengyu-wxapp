import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), log: vi.fn(), org: vi.fn(), admin: vi.fn(), scope: vi.fn(), employee: vi.fn(), global: true, revoke: true, roles: [] as any[] }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }))
vi.mock('@/lib/with-permission', () => ({ withPermission: (_: string, fn: any) => (...args: any[]) => fn({ employeeId: 'operator', roles: mocks.roles }, ...args) }))
vi.mock('@/lib/permissions', () => ({ isAdminScope: () => mocks.global, hasPermission: () => mocks.revoke }))
vi.mock('@/lib/org-ancestry', () => ({ isEmployeeWithinScopeRoots: mocks.employee, isNodeWithinScopeRoots: mocks.scope }))
vi.mock('@/lib/invariant-locks', () => ({ lockOrgTree: mocks.org, lockActiveAdminCount: mocks.admin }))
vi.mock('@/lib/operation-log', () => ({ logOperation: mocks.log }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
import { reviewEmployeeRoleMigration, getEmployeeRoleMigration } from './role-migrations'
const dialect = new PgDialect()
const input = { employeeId: 'E', targetScopeId: 'new', decision: 'migrate' as const, bindings: [{ id: 1, role: 'manager', scopeId: 'old' }] }
let casRows: any[], existing: any[], current: any[], resigned: boolean, targets: any[], pending: any[], preview: any[]
const statements: string[] = []
beforeEach(() => {
  vi.clearAllMocks(); mocks.roles = [{ scopeId: 'root', actions: ['permission:list', 'permission:assign', 'permission:revoke'], scopeStoreIds: [], scopeOrgNodeIds: ['root'] }]; mocks.global = true; mocks.revoke = true; casRows = [{ id: 1 }]; existing = []; current = [{ id: 1 }]; resigned = false; targets = [{ org_node_id: 'new' }]; pending = []; preview = []; statements.length = 0
  mocks.scope.mockResolvedValue(true); mocks.employee.mockResolvedValue(true)
  mocks.transaction.mockImplementation((fn: any) => fn({ execute: mocks.execute }))
  mocks.execute.mockImplementation(async query => {
    const text = dialect.sqlToQuery(query).sql; statements.push(text)
    if (text.includes('SELECT store_id AS')) return [{ storeId: 'S', orgNodeId: 'new', is_resigned: resigned }]
    if (text.includes('SELECT s.org_node_id')) return targets
    if (text.includes('WITH latest')) return pending
    if (text.includes('pr.id::float8 AS id')) return preview
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
  it('无目标门店仍能确认保留，所有匹配历史事件闭环', async () => {
    targets = []; pending = [{ event_id: '10', binding_id: 1 }, { event_id: '11', binding_id: 1 }];
    await reviewEmployeeRoleMigration({ ...input, targetScopeId: null, decision: 'retain', eventId: '10' })
    expect(statements.some(s => s.includes('RETURNING id'))).toBe(false)
    expect(mocks.log.mock.calls.map(c => c[4].eventId)).toEqual(['10', '11'])
  })
  it('预览不向员工可见但旧scope不可见者泄露绑定', async () => {
    mocks.global = false; mocks.scope.mockResolvedValue(false); preview = [{ id: 1, scope_id: 'secret', target_scope_id: 'new' }]; pending = [{ binding_id: 1, event_id: '10' }];
    expect(await getEmployeeRoleMigration('E')).toMatchObject({ roles: [], pending: [] })
  })
  it('超管或定义不允许门店的旧绑定在预览不可迁移', async () => {
    preview = [{ id: 1, scope_id: 'old', target_scope_id: 'new', is_super_admin: true, allowed_scope_types: ['门店'] }];
    expect((await getEmployeeRoleMigration('E')).roles[0].canMigrate).toBe(false)
    preview = [{ id: 1, scope_id: 'old', target_scope_id: 'new', is_super_admin: false, allowed_scope_types: ['总部'] }];
    expect((await getEmployeeRoleMigration('E')).roles[0].canMigrate).toBe(false)
  })
  it('新版角色元数据：assign与revoke分属不同角色不能拼接scope', async () => {
    mocks.global = false;
    mocks.roles = [
      { scopeId: 'A', actions: ['permission:assign'], scopeStoreIds: [], scopeOrgNodeIds: ['A'] },
      { scopeId: 'B', actions: ['permission:revoke'], scopeStoreIds: [], scopeOrgNodeIds: ['B'] },
    ];
    await expect(reviewEmployeeRoleMigration(input)).rejects.toThrow('PERMISSION_DENIED:')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('新版角色元数据：仅双动作角色scope进入迁移判断', async () => {
    mocks.global = false;
    mocks.roles = [
      { scopeId: 'read', actions: ['permission:list'], scopeStoreIds: [], scopeOrgNodeIds: ['read'] },
      { scopeId: 'both', actions: ['permission:assign', 'permission:revoke'], scopeStoreIds: [], scopeOrgNodeIds: ['both'] },
    ];
    mocks.scope.mockImplementation(async (_node, roots) => roots.length === 1 && roots[0] === 'both')
    await reviewEmployeeRoleMigration(input)
    expect(mocks.scope.mock.calls.every(c => c[1].length === 1 && c[1][0] === 'both')).toBe(true)
    expect(statements.some(s => s.includes('UPDATE permission_roles'))).toBe(true)
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
