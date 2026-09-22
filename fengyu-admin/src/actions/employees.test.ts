import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: {
    employeeId: 'employee_id',
    phone: 'phone',
    name: 'name',
    gender: 'gender',
    idCard: 'id_card',
    storeId: 'store_id',
    orgNodeId: 'org_node_id',
    positionName: 'position_name',
    birthday: 'birthday',
    skills: 'skills',
    isResigned: 'is_resigned',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name', type: 'type', sortOrder: 'sort_order', parentId: 'parent_id' },
}))

vi.mock('@db/permission', () => ({
  permissionRoles: {
    id: 'id',
    employeeId: 'employee_id',
    role: 'role',
    scopeId: 'scope_id',
    updatedBy: 'updated_by',
  },
}))

vi.mock('@/lib/admin-guard', () => ({
  countActiveAdmins: vi.fn().mockResolvedValue(5),
  isAdminEmployee: vi.fn().mockResolvedValue(false),
}))

/**
 * 两条递归 CTE 抽到 `@/lib/org-ancestry` 之后在这里整体 mock。本文件只负责
 * 「action 拿到什么答案就走哪条分支」；CTE 自身的语义由真库冒烟
 * `tests/e2e-actions/smoke-org-ancestry.mjs` 负责。理由见 `mockSelectByTable` 的注释。
 */
vi.mock('@/lib/org-ancestry', () => ({
  findNearestStoreAncestor: vi.fn(),
  findRolesBoundWithinSubtree: vi.fn(),
}))

/**
 * 「该员工现在有没有角色」一律实查，不从 `is_resigned` 推 —— 复职提示据此分岔。
 * 独立模块便于在这里直接摆布返回值，不用去动 `mockSelectByTable` 对
 * `db.select(permissionRoles)` 恒空的守护设计。
 */
vi.mock('@/lib/employee-roles', () => ({ findAllRoleBindings: vi.fn() }))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  employeeScopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
  isOrgNodeInScope: vi.fn(() => true),
  isEmployeeRowVisible: vi.fn(() => true),
  // 默认 false = 非 admin：本文件演的全是「受 scope 限制的角色」。
  // admin 短路语义在此测不到（判据被整体 mock），见 employees.scope-integration.test.ts。
  isAdminScope: vi.fn(() => false),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
  gt: vi.fn((col, val) => ({ type: 'gt', col, val })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  sql: Object.assign(
    vi.fn((...args) => ({ type: 'sql', args })),
    {
      raw: vi.fn((s) => ({ type: 'sql.raw', value: s })),
      join: vi.fn((chunks, sep) => ({ type: 'sql.join', chunks, sep })),
      param: vi.fn((value) => ({ type: 'sql.param', value })),
    },
  ),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((_table, aliasName) => ({ _aliasName: aliasName })),
}))

vi.mock('@/actions/skill-tags', () => ({
  getSkillTags: vi.fn(),
  createSkillTag: vi.fn(),
  updateSkillTag: vi.fn(),
  deleteSkillTag: vi.fn(),
}))

import { createEmployee, updateEmployee, getAllocationEmployeeCandidates, getServiceStaffCandidates, getEmployees, getEmployeesPaginated, getOrgLevel2ForFilter, exportEmployees, searchEmployees } from './employees'
import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { staffWechatUsers } from '@db/user'
import { getSession } from '@/lib/auth'
import { isInScope, isOrgNodeInScope, isAdminScope, isEmployeeRowVisible } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { eq, ilike, inArray, isNull, sql, gt } from 'drizzle-orm'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { findNearestStoreAncestor, findRolesBoundWithinSubtree } from '@/lib/org-ancestry'
import { findAllRoleBindings } from '@/lib/employee-roles'
import { getSkillTags } from '@/actions/skill-tags'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['employee:create', 'employee:update'], scopeStoreIds: [] },
}

describe('searchEmployees — 推荐员工检索（全部在职员工，可跨店）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['employee:list'], scopeStoreIds: ['store-1'] },
    })
  })

  it('少于 3 位关键词直接返回空，不查数据库', async () => {
    await expect(searchEmployees('12')).resolves.toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('返回员工编号、门店和脱敏手机号，不泄露完整手机号', async () => {
    const rows = [{
      employeeId: 'EMP-001', name: '王员工', phone: '13812345678',
      storeName: '一店', isResigned: false,
    }]
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)

    const result = await searchEmployees('13812345678')

    expect(result).toEqual([{
      employeeId: 'EMP-001', name: '王员工', phoneMasked: '138****5678',
      storeName: '一店', isResigned: false,
    }])
    expect(chain.limit).toHaveBeenCalledWith(20)
  })
})

/**
 * 这一组轻量辅助按**表**分派（与下面 `mockSelectByTable` 同策略，只是不带 plan）。
 *
 * `stores` 一律返回一行：#259 的存在性校验只要 `storeId` 非空就查 `stores`，返回空会被判成
 * 「所选门店不存在」而提前退出 —— 本组用例测的是别的东西，不该被这一步拦住。行里
 * `orgNodeId` 给 null 也不会走进「本门店未配置组织节点」：`beforeEach` 给
 * `findNearestStoreAncestor` 的默认答案是「节点存在、无门店祖先」，归属自洽在比对之前就放行。
 */
/**
 * 事务内的锁行重读是 `.where(...).for('update').limit(1)` —— 所有 select 替身的 `where`
 * 返回值都要带 `for`，否则链在 `.for` 上炸（codex 谱系第 10 轮加的 `FOR UPDATE`）。
 */
function selectChain(rows: unknown) {
  const limit = vi.fn().mockResolvedValue(rows)
  const forUpdate = vi.fn().mockReturnValue({ limit })
  /**
   * `where` 的返回值必须**既可 await 又能继续链**：
   * 查角色是 `.from(t).where(c)` 直接 await（无 limit），锁行重读是
   * `.where(c).for('update').limit(1)`。所以给 Promise 挂上 `limit` / `for`。
   */
  const whereResult: any = Promise.resolve(rows)
  whereResult.limit = limit
  whereResult.for = forUpdate
  return { where: vi.fn().mockReturnValue(whereResult), limit, for: forUpdate }
}

function rowsForTable(table: unknown, employeeRow?: Record<string, unknown>) {
  if (table === stores) return [{ orgNodeId: null }]
  if (table === staffWechatUsers && employeeRow) return [employeeRow]
  return []
}

/**
 * `@/lib/org-ancestry` 的默认答案：节点存在、无门店祖先 → 归属自洽放行。
 * 凡是不测 #259/#249 的用例都用这个默认值，专测那两条的用例用 `mockSelectByTable` 覆盖。
 */
function defaultAncestryMocks() {
  ;(findNearestStoreAncestor as any).mockResolvedValue({ exists: true, storeAncestorId: null })
  ;(findRolesBoundWithinSubtree as any).mockResolvedValue([])
  ;(findAllRoleBindings as any).mockResolvedValue([])
}

function mockSelectEmpty() {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation((table: unknown) => selectChain(rowsForTable(table))),
  })
}

/**
 * #228 之后「查不到」与「不可见」合并成了同一个立即返回分支（零写入），
 * 所以凡是期望流程走到 UPDATE 的用例都必须让读旧行这一次查到行。
 */
function mockSelectExistingEmployee(row: Record<string, unknown> = { storeId: 'store-A', orgNodeId: 'org-store-A' }) {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation((table: unknown) => selectChain(rowsForTable(table, row))),
  })
}

/**
 * @returns `inserted` —— 事务内 `tx.insert().values(...)` 真正收到的那一组值。
 *   断言「校验放行」是不够的：空串日期能过校验却撞 PG `22007`，而 mock 看不见 22007 ——
 *   测试全绿 + 生产 500（GLM 谱系第 7 轮）。所以要断言**写库值**已归一为 null。
 */
function mockTransactionSuccess(employeeId = 'FY-260315001') {
  const inserted: Record<string, unknown>[] = []
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([{ id: employeeId }]),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          inserted.push(v)
          return Promise.resolve({})
        }),
      }),
    }
    return fn(tx)
  })
  return inserted
}

describe('createEmployee — 服务端输入校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
    ;(isEmployeeRowVisible as any).mockReturnValue(true)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  it('姓名为空 → 拒绝', async () => {
    const result = await createEmployee({ name: '', phone: '13812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('姓名不能为空')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号为空 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入手机号')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号格式错误（非 11 位）→ 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '123456' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('手机号不以 1 开头 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '23812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
  })

  it('身份证为空 → 拒绝（必填）', async () => {
    const result = await createEmployee({ name: '张三', phone: '13812345678' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('请输入身份证号')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 非法日期原先一路走到 INSERT，PG 日期转换失败抛出去 → 500。
   * 它同时是零写入信道的一个触发器（GLM 谱系第 5 轮；边界见 invalidDateMessage 的注释）。
   */
  it('生日格式非法 → 打库前就拒，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '1990/03/07',
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('生日格式不正确（需为 YYYY-MM-DD）')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 只校验外形不够（第 6 轮两谱系共识）：这些都能过 `^\d{4}-\d{2}-\d{2}$`，
   * 却被 PG 判为不存在的日期（22007/22008，两处 catch 都没翻译）→ 仍是 500。
   * ⚠️ `new Date('2026-02-30')` 会**静默滚到** 3 月 2 日，只判 isNaN 抓不到。
   */
  it.each(['2026-02-30', '2026-13-01', '9999-99-99', '2026-00-10', '2025-02-29'])(
    '形似但不存在的日期 %s → 拒，不进事务',
    async (bad) => {
      ;(db.select as any).mockImplementation(mockSelectEmpty())
      const result = await createEmployee({
        name: '张三', phone: '13812345678', idCard: '110101199003078888',
        storeId: 'store-A', birthday: bad,
      })
      expect(result.success).toBe(false)
      expect(result.message).toBe('生日不是一个存在的日期')
      expect(db.transaction).not.toHaveBeenCalled()
    },
  )

  /** 闰年 2 月 29 日是合法的，别把它一起拦掉 */
  it('闰年 2024-02-29 → 放行', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '2024-02-29',
    })
    expect(result.success).toBe(true)
  })

  /**
   * 空串 = 「不填」，不该被当成非法格式拦下（前端清空日期时传的就是空串）。
   *
   * ⚠️ 只断言 `success === true` **不够**（GLM 谱系第 7 轮）：空串过了校验之后若不归一，
   * 会直达 INSERT 撞 PG `22007`，而 mock 看不见 22007 —— 测试全绿而生产 500。
   * 所以这里断言的是真正写进库的值：`birthday` 归一为 null，`hiredAt` 回落到今天。
   */
  it('日期传空串 → 视为不填，且写库值已归一（不是把空串塞进 date 列）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const inserted = mockTransactionSuccess()
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '', hiredAt: '',
    })
    expect(result.success).toBe(true)
    expect(inserted[0]?.birthday).toBeNull()
    expect(inserted[0]?.hiredAt).not.toBe('')   // 空串必须已回落为今天
    expect(typeof inserted[0]?.hiredAt).toBe('string')
  })

  /** codex/GLM 第 7 轮：`Date.UTC` 把 0–99 年映射到 1900–1999，会误拒合法的四位年份 */
  it('四位年份 0096-02-29（1996 是闰年、96 也是）→ 放行，不被 0–99 映射误拒', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const inserted = mockTransactionSuccess()
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '0096-02-29',
    })
    expect(result.success).toBe(true)
    expect(inserted[0]?.birthday).toBe('0096-02-29')
  })

  /** PG 没有公元 0 年（BC 1 直接接 AD 1），`0000-01-01` 过 JS 回读但入库报越界（codex 第 8 轮） */
  it('公元 0000 年 → 拒（PG 不接受，否则入库越界变 500）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '0000-01-01',
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('生日不是一个存在的日期')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('四位年份 0099-02-29（99 非闰年，而映射目标 1999 也非闰年）→ 仍拒', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', birthday: '0099-02-29',
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('生日不是一个存在的日期')
  })

  it('入职日期格式非法 → 同样拒（两个日期列都校验）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', hiredAt: '2026-9-1',
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('入职日期格式不正确（需为 YYYY-MM-DD）')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('身份证格式错误 → 拒绝', async () => {
    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '12345' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('身份证号格式不正确')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 手机号唯一性已不做事务外预查重（那是零写入探测信道），改由 DB 的
   * `uq_staff_users_phone` 约束 + 23505 转译承担 —— 所以这条现在**必须**进事务。
   */
  it('手机号已被使用 → DB 抛 23505 → 友好文案（不再事务外预查）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_staff_users_phone',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'store-1' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    // 冲突必须由真实写入触发 —— 这正是「不再有零写入探测」的体现
    expect(db.transaction).toHaveBeenCalled()
  })

  it('storeId 不在 scope 内 → 拒绝，不进事务', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'other-store' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内 → 正常创建', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'store-1' })

    expect(result.success).toBe(true)
  })

  it('storeId 为 null → 跳过 scope 校验，允许创建（未分配门店员工）', async () => {
    ;(isInScope as any).mockReturnValue(false) // 不会被调用
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: null })

    expect(result.success).toBe(true)
    // isInScope 不应被调用（storeId=null 时跳过校验）
    expect(isInScope).not.toHaveBeenCalled()
  })

  /**
   * `employee.create` 审计也在事务内（GLM 谱系第 10 轮 P2-4）——
   * 留在事务外时它失败会留下「员工已建、前端 500」，重试还会撞手机号唯一约束报
   * 「该手机号已被其他员工使用」，把操作者带到完全错误的方向。
   */
  it('创建成功时 employee.create 审计走同一个事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    let handedTx: unknown
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      handedTx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-260315001' }]),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(handedTx)
    })

    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888', storeId: 'store-A',
    })

    expect(result.success).toBe(true)
    expect((logOperation as any).mock.calls[0][5]).toBe(handedTx)
  })

  /** 与 update 侧同构（#228：只修一侧等于没修）—— GLM 第 12 轮 P2-2 */
  it('create 侧 skills 传非数组 → 打库前拒，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', skills: '美容' as any,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('技能标签格式不正确')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /** codex 第 13 轮 P2：update 侧三个 boolean 刚修完，create 侧这个又漏了（#228 同一教训） */
  it('create 侧 socialInsurance 传非 boolean → 打库前拒，不进事务', async () => {
    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', socialInsurance: 'yes' as any,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('参数格式不正确')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('正常创建 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

    expect(result.success).toBe(true)
    expect(result.employeeId).toBe('FY-260315001')
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('并发唯一冲突（23505 手机号）→ 友好消息而非 500', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
  })

  it('并发唯一冲突（23505 其他约束）→ 通用提示', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (employee_id)=(FY-260315001) already exists.',
    })
    ;(db.transaction as any).mockRejectedValue(pgError)

    const result = await createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('数据冲突')
  })

  it('其他 DB 异常重新抛出（非 23505）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(
      createEmployee({ name: '张三', phone: '13812345678', idCard: '110101199003078888' }),
    ).rejects.toThrow('connection lost')
  })
})

describe('updateEmployee — 服务端输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
    ;(isEmployeeRowVisible as any).mockReturnValue(true)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  it('手机号格式错误 → 拒绝', async () => {
    const result = await updateEmployee('FY-001', { phone: 'abc' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('身份证格式错误 → 拒绝', async () => {
    const result = await updateEmployee('FY-001', { idCard: 'invalid' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('身份证号格式不正确')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 离职状态与离职日期的**双写不变量**：在职 ⇒ null，离职 ⇒ 非 null。
   * 显式传入的 `resignedAt` 不得绕过它（codex 谱系第 8 轮 P2 / GLM P3-1）。
   */
  it.each([
    ['离职 + 空串日期 → 自动填今天（不能写出「已离职但无离职日期」）',
      { isResigned: true, resignedAt: '' }, (v: any) => expect(v.resignedAt).toBeTruthy()],
    ['复职 + 显式离职日期 → 日期被清空（不能写出「在职却挂着离职日期」）',
      { isResigned: false, resignedAt: '2026-09-01' }, (v: any) => expect(v.resignedAt).toBeNull()],
  ])('%s', async (_label, payload, assertSet) => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: !payload.isResigned,
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((v: any) => {
          set(v)
          return { where: vi.fn().mockResolvedValue({ count: 1 }) }
        }),
      }),
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
    }))

    const result = await updateEmployee('FY-001', payload)

    expect(result.success).toBe(true)
    assertSet(set.mock.calls.at(-1)?.[0])
  })

  /**
   * GLM 谱系第 9 轮：判据必须是「**本次操作之后**是否离职态」而不是「本次是否显式传了
   * isResigned」。否则在职员工直调 `{ resignedAt }` 就能挂上离职日期。
   */
  it('在职员工只传 resignedAt（不带 isResigned）→ 日期被清空，不允许「在职挂离职日期」', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null,
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { resignedAt: '2026-01-01' })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ resignedAt: null }))
  })

  it('在职员工只传 resignationReason → 一并清空（同一不变量的另一半）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null,
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { resignationReason: '编的' })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ resignationReason: null }))
  })

  /** ⚠️ 离职态缺日期时回落**旧值**，不能无条件写今天 —— 否则普通编辑会篡改离职日期 */
  it('已离职员工普通编辑（不带 isResigned）→ 离职日期保持原值，不被重置为今天', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30',
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ resignedAt: '2025-06-30' }))
  })

  /** 复职时离职原因也要一起清 —— 否则在职员工挂着一条离职原因 */
  it('复职 → resignedAt 与 resignationReason 一起清空', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true,
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })
    ;(findAllRoleBindings as any).mockResolvedValue([])

    const result = await updateEmployee('FY-001', { isResigned: false })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      resignedAt: null, resignationReason: null,
    }))
  })

  /**
   * update 侧的空串归一（GLM 谱系第 7 轮 P2-A）：`updateData = {...data}` 原先只归一
   * leave / 归属四个字段，三个 date 列的 `''` 会直达 UPDATE 撞 PG `22007` → 500。
   * 断言写库值而不只是 success。
   */
  it('update 传空串日期 → 写库值归一为 null（不是把空串塞进 date 列）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { birthday: '', hiredAt: '', resignedAt: '' })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      birthday: null, hiredAt: null, resignedAt: null,
    }))
  })

  /**
   * 请假区间以前只校验「成对 + 字典序」，垃圾串与自身可比 → 一路打到 UPDATE 撞
   * PG `22007/22008` → 500（GLM 谱系第 7 轮 P2-B）。Server Action 可直调，前端 widget
   * 不产生这种值不代表服务端不用挡。
   */
  it.each([
    ['垃圾串', '不是时间', '不是时间'],
    ['缺时分', '2026-03-01', '2026-03-02'],
    ['不存在的日期部分', '2026-02-30T10:00', '2026-03-01T10:00'],
    ['小时越界', '2026-03-01T24:00', '2026-03-02T10:00'],
    ['分钟越界', '2026-03-01T10:60', '2026-03-02T10:00'],
  ])('请假时间 %s → 打库前就拒', async (_label, ls, le) => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { leaveStart: ls, leaveEnd: le })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/请假(开始|结束)时间(格式不正确|不是一个存在的日期)/)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('合法的请假区间 → 放行', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    ;(db.update as any).mockReturnValue({ set: vi.fn().mockReturnValue({ where }) })

    const result = await updateEmployee('FY-001', {
      leaveStart: '2026-03-01T09:00', leaveEnd: '2026-03-03T18:30',
    })

    expect(result.success).toBe(true)
  })

  /** #228 的教训：只修一侧等于没修 —— update 侧同样在打库前校验三个日期列 */
  it('生日 / 入职日期 / 离职日期格式非法 → 打库前就拒，不读旧行', async () => {
    for (const [payload, message] of [
      [{ birthday: '1990/03/07' }, '生日格式不正确（需为 YYYY-MM-DD）'],
      [{ hiredAt: '2026-9-1' }, '入职日期格式不正确（需为 YYYY-MM-DD）'],
      [{ resignedAt: '昨天' }, '离职日期格式不正确（需为 YYYY-MM-DD）'],
    ] as const) {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      ;(isAdminScope as any).mockReturnValue(true)
      ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
      const result = await updateEmployee('FY-001', payload)
      expect(result.success).toBe(false)
      expect(result.message).toBe(message)
      expect(db.select).not.toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    }
  })

  it('手机号 null → 跳过格式校验（合法清除）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: null })
    // phone=null 时跳过格式校验，直接进入 DB update
    expect(db.update).toHaveBeenCalled()
  })

  it('乐观锁冲突（rowCount=0）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee(
      'FY-001',
      { name: '李四' },
      '2026-01-01T00:00:00.000Z',
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  /**
   * ⚠️ 这条曾经变成过假阳性（codex 谱系第 3 轮发现）：当年手机号查重排在读旧行**之前**，
   * 第一次 select 就是查重，而 `mockSelectExistingEmployee` 恰好在第一次返回一行 ——
   * 于是函数提前返回「手机号已被使用」，mock 的 23505 根本不执行，删掉生产代码里的
   * 23505 catch 测试照样绿。事务外查重后来**整体删除**（见「零写入信道」那组的终局注释），
   * 本例因此恢复有效；下面那条 `db.update` 断言是为了让这类失效下次能被直接看出来。
   */
  it('DB 唯一冲突（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const pgError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (phone)=(13812345678) already exists.',
    })
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(pgError) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { phone: '13812345678' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('手机号已被其他员工使用')
    // 必须真的走到 UPDATE 才谈得上「DB 抛 23505」——否则这条测的是别的分支
    expect(db.update).toHaveBeenCalled()
  })

  it('正常更新 → 成功', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
  })

  it('rowCount=0，无乐观锁 → 报告员工不存在或无权（不再静默成功）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-999', { name: '张三' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  /** 离职事务 mock：返回员工现有角色列表 + delete + log 链 */
  /**
   * 离职路径现在整体在一个事务里：`tx.update`（员工行，带乐观锁 CAS）→ `tx.select`（角色）
   * → `tx.delete` → 逐条 revoke 审计（传 tx）。
   * 员工行 UPDATE 与角色撤销必须同生共死（codex 谱系第 8 轮 P1），所以 `tx` 上要有 `update`。
   *
   * @param roles 事务内查到的角色
   * @param updateCount 员工行 UPDATE 的 rowCount（0 = 乐观锁未命中）
   */
  /**
   * 事务体现在是：锁行重读（`FOR UPDATE`）→ advisory lock（`tx.execute`）→ admin 守卫
   * → `tx.update`（CAS）→ 角色查询/删除 → 各条审计。所以 tx 上还要有 `execute`，
   * 且 `select` 链要能接 `.for('update')`。
   *
   * @param lockedRow 锁行重读拿到的旧离职态；默认在职
   */
  function mockResignTransaction(roles: any[], updateCount = 1, lockedRow: any = { isResigned: false, resignedAt: null }) {
    const txDelete = vi.fn().mockResolvedValue({})
    let selectCall = 0
    // 第 1 次 select = 锁行重读，之后 = 查角色
    const txSelect = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => selectChain(selectCall++ === 0 ? [lockedRow] : roles)),
    }))
    const txUpdateWhere = vi.fn().mockResolvedValue({ count: updateCount })
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })
    let handedTx: any
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      handedTx = {
        execute: vi.fn().mockResolvedValue([]),      // advisory lock
        update: vi.fn().mockReturnValue({ set: txUpdateSet }),
        select: txSelect,
        delete: vi.fn().mockReturnValue({ where: txDelete }),
      }
      return fn(handedTx)
    })
    // 导出句柄：revoke 审计的 executor 断言要用**同一性**，形状匹配对 db 也成立（GLM 第 10 轮 P2-3）
    return { txDelete, txUpdateSet, tx: () => handedTx }
  }

  it('isResigned=true (非 admin) → 事务清理权限角色 + 逐条 logOperation', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    const resignTx = mockResignTransaction([
      { id: 11, role: 'manager', scopeId: 'store-A' },
      { id: 12, role: 'staff', scopeId: 'store-A' },
    ])

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledTimes(2)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'permission.revoke',
      'permission_role',
      '11',
      expect.objectContaining({ role: 'manager', scopeId: 'store-A', employeeId: 'FY-001', batch: 'resignation' }),
      /**
       * 第 6 参是 executor，必须是**那个 tx 本身**。
       * ⚠️ 原来写的是 `objectContaining({ update: any(Function), delete: any(Function) })` ——
       * mock 的 `db` 同样有这两个方法，形状匹配对 db 也成立，等于没锁（GLM 第 10 轮 P2-3）。
       */
      resignTx.tx(),
    )
  })

  it('isResigned=true 但是最后一个活跃 admin → 抛 INVALID_STATE (UPDATE 未发生)', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(isAdminEmployee as any).mockResolvedValueOnce(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(1)

    await expect(
      updateEmployee('FY-001', { isResigned: true }),
    ).rejects.toThrow(/INVALID_STATE: 该员工是系统最后一个活跃 admin/)

    /**
     * 守卫现在在**事务内**重读（codex 谱系第 9 轮）：两个 admin 被并发离职时，
     * 事务外 check-then-act 会让双方都读到 count = 2、各自成功，最终零管理员。
     * 所以这里事务会开、但整体回滚 —— 判据是「UPDATE 没发生」而不是「事务没开」。
     */
    expect(db.update, '守卫应在 UPDATE 之前抛出').not.toHaveBeenCalled()
    expect(db.transaction, '守卫在事务内重读，所以事务会开（随后回滚）').toHaveBeenCalled()
  })

  it('isResigned=true admin 但 count=2 → 成功离职 + 角色清理', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(isAdminEmployee as any).mockResolvedValueOnce(true)
    ;(countActiveAdmins as any).mockResolvedValueOnce(2)
    const empWhere = vi.fn().mockResolvedValue({ count: 1 })
    const empSet = vi.fn().mockReturnValue({ where: empWhere })
    ;(db.update as any).mockReturnValue({ set: empSet })
    const resignTx2 = mockResignTransaction([{ id: 99, role: 'admin', scopeId: 'hq-1' }])

    const result = await updateEmployee('FY-002', { isResigned: true })

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'permission.revoke',
      'permission_role',
      '99',
      expect.objectContaining({ role: 'admin', scopeId: 'hq-1', employeeId: 'FY-002', batch: 'resignation' }),
      resignTx2.tx(),
    )
  })

  /**
   * codex 谱系第 8 轮 P1：员工行 UPDATE 与角色撤销必须**同生共死**。
   *
   * 原先它们是两次独立提交 —— `is_resigned = true` 先落盘，角色事务失败时员工保留全部角色，
   * 而 `login` / `getSession` 都不校验在职（本 PR 范围外的独立缺口），账号继续有后台权限。
   * 现在整条链在一个事务里：断言「员工行 UPDATE 走的是 tx 而不是 db」+「delete 失败时抛出」，
   * 前者才是「会一起回滚」的结构保证（后者只证明异常没被吞）。
   */
  it('事务内 delete 抛错 → 整个 updateEmployee 抛出，且员工行 UPDATE 走的是同一个 tx', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })
    const txUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        update: txUpdate,
        select: (db as any).select,
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('connection lost')),
        }),
      }
      return fn(tx)
    })

    await expect(updateEmployee('FY-001', { isResigned: true })).rejects.toThrow('connection lost')
    expect(txUpdate, '员工行必须在事务内更新，否则角色删除失败时离职状态已经落盘').toHaveBeenCalled()
    expect(db.update, '离职路径不得走事务外的 db.update').not.toHaveBeenCalled()
  })

  /**
   * GLM 谱系第 9 轮 P3：`23505`/`23503` 的既有用例全走非事务的 `db.update`，
   * 离职路径换成 `tx.update` 之后这条翻译链没有用例。错误从事务回调传播到外层 catch，
   * 代码路径明确 —— 但本项目的惯例是「锁住而非推断」。
   */
  it('离职事务内撞 FK 23503 → 翻译成友好文案（不是 500）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      select: (db as any).select,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(Object.assign(new Error('fk'), {
            code: '23503', constraint: 'staff_wechat_users_org_node_id_org_nodes_id_fk',
          })),
        }),
      }),
      delete: vi.fn(),
    }))

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选门店或组织节点已被删除，请刷新后重试')
  })

  it('离职事务内撞手机号唯一约束 23505 → 翻译成友好文案', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      select: (db as any).select,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), {
            code: '23505', constraint: 'uq_staff_users_phone',
          })),
        }),
      }),
      delete: vi.fn(),
    }))

    const result = await updateEmployee('FY-001', { isResigned: true, phone: '13900000009' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('该手机号已被其他员工使用')
  })

  /**
   * codex 谱系第 10 轮 P1：仅把 `countActiveAdmins` 传进 `tx` **不够串行** ——
   * READ COMMITTED 下两笔并发离职分别针对 admin A / B 时各自都读到 `count = 2`，
   * 更新的是不同员工行、删的是不同角色行，两边都能提交 → 零活跃 admin。
   * 要真串行得有一把公共的 advisory lock。
   */
  it('离职路径在守卫之前取 advisory lock（否则并发离职两个 admin 会双双通过）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const order: string[] = []
    const txExecute = vi.fn().mockImplementation(() => {
      order.push('lock')
      return Promise.resolve([])
    })
    ;(isAdminEmployee as any).mockImplementation(() => {
      order.push('guard')
      return Promise.resolve(false)
    })
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: txExecute,
      update: (db as any).update,
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
      insert: (db as any).insert,
    }))
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    await updateEmployee('FY-001', { isResigned: true })

    expect(txExecute.mock.calls[0][0], 'advisory lock 的 SQL').toBeDefined()
    expect(JSON.stringify(txExecute.mock.calls[0][0])).toContain('pg_advisory_xact_lock')
    expect(order, '锁必须在守卫查询之前').toEqual(['lock', 'guard'])
  })

  /**
   * codex 谱系第 10 轮 P2：双写不变量依赖「旧离职态」，而事务**外**读到的旧值到写入之间
   * 可被插队 —— 不带 `expectedUpdatedAt` 的普通编辑读到「在职」算出 `resignedAt = null`，
   * 另一请求先完成离职，这次提交就把离职日期清空了。事务内 `FOR UPDATE` 锁行重读修掉它。
   */
  it('事务内用 FOR UPDATE 锁行重读，并按锁内旧值重算双写字段', async () => {
    // 事务外读到「在职」，锁内重读却是「已离职于 2025-06-30」（模拟被并发离职插队）
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table !== staffWechatUsers) return selectChain(table === stores ? [{ orgNodeId: null }] : [])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }
          : { isResigned: true, resignedAt: '2025-06-30' }])
      }),
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    // 按锁内旧值（已离职）推导 → 保留原离职日期，而不是按事务外那个「在职」清成 null
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ resignedAt: '2025-06-30' }))
  })

  /** 锁行重读查不到（事务外读到过、这会儿没了）→ 与「不存在/不可见」同句，不泄露发生了什么 */
  it('锁行重读查不到员工 → 统一文案，且不写库', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table !== staffWechatUsers) return selectChain([])
        return selectChain(selectCall++ === 0
          ? [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }]
          : [])
      }),
    }))
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('员工不存在或无权修改')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 结构守护：并发隔离本身单测**证明不了**。
   *
   * 红检「把 `.for('update')` 删掉」时全套照样绿 —— mock 的 select 链无论带不带 `.for`
   * 都返回同一组数据，`FOR UPDATE` 的语义在 PG 层，要真验得开两个连接并发跑。
   * 同理 advisory lock 的互斥效果也只能验「SQL 发出去了」而非「真的互斥了」。
   *
   * 所以这里退一步只钉源码形态，并如实声明上限：
   * **它只防「被顺手删掉」，不证明隔离成立。** 要提高保障等级得上双连接并发冒烟
   * （真库 + 两个 client 同时提交），本 PR 未做 —— 那是独立的测试基建活。
   */
  it('源码守护：锁行重读带 FOR UPDATE + 两条 admin 路径共用同一把 advisory lock', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/actions/employees.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
    /**
     * ⚠️ 必须**分别**锁两个 action（codex 第 13 轮 P1）：
     * 原先只断言「全文件至少出现一次 `.for('update')`」，删掉任一处另一处仍让正则通过，
     * 核心并发修复可以被单边回退而不报警。这里按函数体切开各判一次。
     */
    const updateBody = src.slice(src.indexOf('export const updateEmployee'), src.indexOf('export const deleteEmployee'))
    const deleteBody = src.slice(src.indexOf('export const deleteEmployee'))
    expect(updateBody, 'updateEmployee 的锁内重读必须 FOR UPDATE')
      .toMatch(/\.for\(\s*['"]update['"]\s*\)/)
    expect(deleteBody, 'deleteEmployee 的锁内重读必须 FOR UPDATE')
      .toMatch(/\.for\(\s*['"]update['"]\s*\)/)
    expect(src, 'advisory lock 的 key 必须收口成常量，两条路径共用')
      .toMatch(/ACTIVE_ADMIN_LOCK_KEY = 'admin:active_count'/)
    expect(src, '锁必须真的用 pg_advisory_xact_lock 取')
      .toMatch(/pg_advisory_xact_lock\(hashtext\(\$\{ACTIVE_ADMIN_LOCK_KEY\}\)/)
    /**
     * 会减少活跃 admin 的**两条**路径（标记离职 / 物理删除）都必须取这把锁。
     * 只修一侧等于没修（#228 的教训，GLM 谱系第 10 轮在 `deleteEmployee` 上又抓到一次）。
     */
    expect(src.match(/lockActiveAdminCount\(tx\)/g)?.length,
      '标记离职与物理删除两处都要取锁').toBe(2)
  })

  /**
   * **P0（GLM 谱系第 11 轮）**：`updateData` 原先是 `{ ...data }` 全量展开，而 Server Action
   * 可被直调（TS 类型只在编译期）、drizzle `.set()` 按表列映射 ——
   * `staff_wechat_users.openid` 是真实列，且 `staffApi/middleware/auth.js:185` 用
   * `WHERE u.openid = $1` 认证员工，于是持 `employee:update` 的低权操作者能把自己 scope 内
   * 任一员工的 openid 改成攻击者的，攻击者登录员工端小程序即**接管该员工账号**。
   */
  it.each([
    ['openid（账号接管）', 'openid', 'o_attacker'],
    ['employeeId（改主键）', 'employeeId', 'FY-HIJACK'],
    ['createdAt（伪造时序）', 'createdAt', '2020-01-01T00:00:00.000Z'],
    ['updatedAt（伪造乐观锁基准）', 'updatedAt', '2020-01-01T00:00:00.000Z'],
  ])('直调注入 %s → 该键不得进入写库 payload', async (_label, key, value) => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '张三', [key]: value } as any)

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalled()
    expect(Object.keys(set.mock.calls.at(-1)![0]), `${key} 必须被白名单丢弃`).not.toContain(key)
  })

  /**
   * 白名单不能把合法字段一起丢掉。
   *
   * ⚠️ 上一版这条用 `FULL_FORM` 断言，标题说「全部 17 个」而 `FULL_FORM` 只有 15 键 ——
   * 缺 `isResigned` / `resignedAt` / `resignationReason`，把它们从白名单里删掉全套仍绿
   * （`resignedAt` 有归一行兜底、`resignationReason` 被 invariant 无条件清空、角色删除分支只看
   * `data.isResigned`）。生产上的后果是「标记离职」写不进 `is_resigned`、「编辑离职原因」静默失效
   * （GLM 谱系第 12 轮 P2-1）。这条显式列出全部 18 个键逐一断言。
   */
  it('白名单放行全部 18 个合法字段（含离职三字段 + skills）', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30',
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const payload = {
      ...FULL_FORM,
      isResigned: true, resignedAt: '2025-06-30', resignationReason: '个人原因',
      skills: ['美容'],
    }
    const result = await updateEmployee('FY-001', payload)

    expect(result.success).toBe(true)
    const written = Object.keys(set.mock.calls.at(-1)![0])
    for (const k of Object.keys(payload)) {
      expect(written, `${k} 是合法字段，不该被白名单误丢`).toContain(k)
    }
    expect(written.length, '写库键数应与传入的合法键数一致').toBe(Object.keys(payload).length)
  })

  /** `skills` 传非数组会让 PG 解析数组字面量失败（22P02）→ 两处 catch 都不翻译 → 500 */
  it('skills 传非数组 → 打库前拒，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { skills: '美容' as any })

    expect(result.success).toBe(false)
    expect(result.message).toBe('技能标签格式不正确')
    expect(db.select, '纯类型校验必须排在任何打库之前').not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 锁序必须与 `deleteEmployee` 一致（advisory → 行锁），否则同一员工并发
   * 「标记离职 + 物理删除」会形成 lock ordering inversion → PG `40P01` → 500
   * （codex / GLM 第 11 轮各自独立指出）。
   */
  it('离职路径的 advisory lock 早于员工行锁', async () => {
    const order: string[] = []
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === staffWechatUsers) {
          const rows = [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }]
          const limit = vi.fn().mockResolvedValue(rows)
          const whereResult: any = Promise.resolve(rows)
          whereResult.limit = limit
          whereResult.for = vi.fn().mockImplementation(() => {
            order.push('row-lock')
            return { limit }
          })
          return { where: vi.fn().mockReturnValue(whereResult), limit }
        }
        return selectChain(table === stores ? [{ orgNodeId: null }] : [])
      }),
    }))
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockImplementation(() => {
        order.push('advisory')
        return Promise.resolve([])
      }),
      update: (db as any).update,
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
      insert: (db as any).insert,
    }))
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    await updateEmployee('FY-001', { isResigned: true })

    expect(order.slice(0, 2), 'advisory 必须先于行锁，与 deleteEmployee 同序').toEqual(['advisory', 'row-lock'])
  })

  /**
   * 目标已离职时他本就不在 `countActiveAdmins`（join 了 `is_resigned = false`）里 ——
   * 再标记他离职不会让活跃数变化，不该拦（GLM 第 11 轮 P2-2）。
   */
  it('对已离职的残留 admin 再标离职 → 不被「最后一个活跃 admin」误拒', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30',
    }))
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(1)   // 系统只剩 1 个在职 admin（是别人）
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(isAdminEmployee, '目标已离职 → 守卫整段跳过，连查都不必').not.toHaveBeenCalled()
  })

  /**
   * `applyResignationInvariant` 只能在锁内算**一次**：事务外先算一遍会把
   * `updateData.resignedAt` 填成今天，锁内的 `if (!updateData.resignedAt)` 就被短路
   * → 对已离职员工直调 `{ isResigned: true }` 会把历史离职日期重置为今天（GLM 第 11 轮 P3-1）。
   */
  it('已离职员工直调 { isResigned: true } → 历史离职日期不被重置为今天', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee({
      storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30',
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ resignedAt: '2025-06-30' }))
  })

  /**
   * `applyResignationInvariant` 只能在锁内算**一次**。
   *
   * ⚠️ 上一版红检（在事务外也调一次）**没变红** —— 我那条「日期不被重置」用例里事务外与锁内
   * 读到的是同一行，两次计算结果相同，区分不出来。这条用双快照构造出差异：
   * 事务外看到「在职 + 无离职日期」→ 算出 `resignedAt = 今天`；锁内其实是
   * 「已离职于 2025-06-30」→ 若事务外已填过，锁内的 `if (!updateData.resignedAt)` 就被短路，
   * 历史离职日期被改成今天（GLM 第 11 轮 P3-1 描述的正是这条链）。
   */
  it('事务外与锁内旧值不同时，双写只按锁内那次算（不被事务外的结果短路）', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table !== staffWechatUsers) return selectChain(table === stores ? [{ orgNodeId: null }] : [])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }
          : { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30' }])
      }),
    }))
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { isResigned: true })

    expect(result.success).toBe(true)
    expect(set.mock.calls.at(-1)![0].resignedAt,
      '必须是锁内读到的历史日期，而不是事务外算出的今天').toBe('2025-06-30')
  })

  /**
   * 复职判定也要用**锁内**旧值：事务外读到「在职」→ `isReinstating` 为 false → 锁内其实完成了
   * 复职，却不实查角色、不写复职审计、不回传提示（codex 第 11 轮 P2-2）。
   */
  it('复职判定用锁内旧值（事务外读到在职也不影响）', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table !== staffWechatUsers) return selectChain(table === stores ? [{ orgNodeId: null }] : [])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          // 事务外这一眼看到的是「在职」（被并发离职插队前的旧状态）
          ? { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }
          : { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true, resignedAt: '2025-06-30' }])
      }),
    }))
    ;(findAllRoleBindings as any).mockResolvedValue([{ role: 'manager', scopeId: 'org-store-A' }])
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { isResigned: false })

    expect(result.success).toBe(true)
    expect(result.message, '锁内旧值是已离职 → 这是复职，必须给提示').toContain('仍保留以下角色绑定')
  })

  /** 三个 notNull boolean 列：直调传 null 会撞 23502 未翻译 → 500（GLM 第 12 轮 P3-1） */
  it.each(['isResigned', 'isOnBusinessTrip', 'socialInsurance'])(
    '%s 传 null → 打库前拒，不进事务',
    async (key) => {
      ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
      ;(db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      })

      const result = await updateEmployee('FY-001', { [key]: null } as any)

      expect(result.success).toBe(false)
      expect(result.message).toBe('参数格式不正确')
      // 「打库前拒」要断到底：`db.select` / `db.transaction` 都不该被调（codex 第 13 轮 P3）
      expect(db.select, '纯类型校验必须排在任何打库之前').not.toHaveBeenCalled()
      expect(db.transaction).not.toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    },
  )

  /**
   * 归属 post-image 必须按**锁内**旧值重算并复查（codex 第 12 轮 P1）。
   *
   * 两笔不带 `expectedUpdatedAt` 的并发请求分别改 store 与 org，各自按自己看到的旧状态都合法，
   * 合成后却是「store=B + org=A店的部门」—— 正是 #259 要禁的跨门店双重可见。
   * 这里模拟第二笔：事务外看到 `{store: A, org: 市场部门}`（改 org 合法），
   * 锁内已被第一笔改成 `{store: B, org: 市场部门}` → 复算出的组合违反自洽 → 必须拒。
   */
  it('并发插队后锁内重算发现组合违反自洽 → 拒绝（不制造跨门店双重可见）', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === stores) return selectChain([{ orgNodeId: 'org-store-B' }])
        if (table !== staffWechatUsers) return selectChain([])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: 'store-A', orgNodeId: 'market-1', isResigned: false, resignedAt: null }
          // 第一笔已把门店改成 store-B
          : { storeId: 'store-B', orgNodeId: 'market-1', isResigned: false, resignedAt: null }])
      }),
    }))
    // 新 orgNodeId 的门店祖先是 store-A 的节点，与锁内的 store-B 不符
    ;(findNearestStoreAncestor as any).mockResolvedValue({ exists: true, storeAncestorId: 'org-store-A' })
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { orgNodeId: 'dept-A' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选组织节点属于另一个门店，请改选本门店或其所属部门')
    expect(db.update).not.toHaveBeenCalled()
  })

  /** 乐观锁未命中时不该删角色 —— CAS 没改到行，角色也不该动 */
  it('离职时乐观锁未命中 → 返回冲突文案，且角色一条都不删', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const { txDelete } = mockResignTransaction([{ id: 1, role: 'manager', scopeId: 'store-A' }], 0)

    const result = await updateEmployee('FY-001', { isResigned: true }, '2026-01-01T00:00:00.000Z')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
    expect(txDelete).not.toHaveBeenCalled()
    expect(logOperation).not.toHaveBeenCalledWith(
      mockSession, 'permission.revoke', 'permission_role', expect.anything(),
      expect.anything(), expect.anything(),
    )
  })
})

// ── #228 员工归属变更的 scope 校验 ───────────────────────────────────────────

/**
 * 唯一的生产调用方 `employee-detail-page.tsx:181-196` **永远**整表回传 15 个字段
 * 并携带 `expectedUpdatedAt`。早先这组用例全是 `updateEmployee('FY-001', { storeId })`
 * 两参极简调用 —— 于是给守卫套一层 `if (expectedUpdatedAt === undefined)` 或
 * `if (data.positionName === undefined)` 就能让它在 100% 真实请求上失效而测试全绿。
 * 现在负例一律走 FULL_FORM + 乐观锁，正例保留极简形态覆盖别的调用形状。
 */
const FULL_FORM = {
  // idCard 必须给真值：`data.idCard !== undefined && !trim()` 会先一步拒「请输入身份证号」。
  // phone 保持 null，与前端「手机号留空时传 null」一致；带 phone 的形态另有一条用例。
  name: '张三', gender: '男', phone: null, idCard: '110101199003078888',
  storeId: 'store-A', orgNodeId: 'org-store-A', positionName: '美容师',
  avatarUrl: null, birthday: null, hiredAt: null,
  leaveStart: null, leaveEnd: null, isOnBusinessTrip: false,
  skills: null, socialInsurance: true,
} as const
const EXPECTED_AT = '2026-01-01T00:00:00.000Z'

/**
 * 判据按 id 区分，而不是整体 true / false。
 *
 * #228 的校验现在既看**新值**（能不能调过去）也看**旧值**（这行本来是否可见）——
 * 整体 mock 成 false 会把旧行一起判成不可见，用例就只能测到「员工不存在或无权修改」
 * 那条统一兜底，表达不出「旧值可见 + 新值越界」这个真正要锁的组合。
 */
const IN_SCOPE_STORES = new Set(['store-A', 'store-B'])
const IN_SCOPE_NODES = new Set(['org-store-A', 'org-store-B', 'dept-A', 'market-1'])
/**
 * 按**查询的表**分派 `db.select()`，而不是数「第几次 select」。
 *
 * 序号式 mock 极其脆弱：#259 在归属校验里新增了一次 orgNodes 查询，就把 §AFF-03 那几条
 * 用例的 1/2/3/4 序列全打乱了（bindings 从第 4 次变成第 5 次）。按表分派后，
 * 往中间插入任何新查询都不会再打乱既有断言 —— 这和「按特征而不是按位置识别」是同一个道理。
 *
 * @param plan 每张表返回什么；`rows` 用于 `.limit()` 结尾的查询，`await`ed 用于直接 await where 的
 */
function mockSelectByTable(plan: {
  employee?: Record<string, unknown>[]
  /**
   * #259「向上最近的门店型祖先」的返回值。走 `@/lib/org-ancestry` 的
   * `findNearestStoreAncestor`，本文件把它整个 mock 掉：
   *   - 给 id → `{ exists: true, storeAncestorId: id }`（有门店祖先）
   *   - `null` → `{ exists: true, storeAncestorId: null }`（挂市场下 → 放行）
   *   - `'__missing__'` → `{ exists: false }`（节点不存在 / 并发被删）
   *
   * ⚠️ 这里 mock 的是**函数**而不是 SQL。上一版把 `db.execute` 换成按
   * `text.includes('permission_roles')` 分派的替身，SQL 本身从不被检验 —— 把递归退化成
   * 单表 `WHERE id=$1 AND type='门店'`、或把子树匹配退化成 `scope_id = $1`、或删掉环防护，
   * 全套照样绿（第 4 轮两个评审谱系各自独立指出）。现在分工是：
   *   - 本文件锁 **action 的分支逻辑**（哪个输入走哪条分支、记什么 reason、回传什么文案）
   *   - `tests/e2e-actions/smoke-org-ancestry.mjs` 拿真 PG 锁 **两条 CTE 的语义**
   *     （上溯方向、环防护、depth 取最近、子树覆盖任意深度）
   * 一个替身同时假装两件事，就一件都锁不住。
   */
  storeAncestor?: string | null
  orgNode?: Record<string, unknown>[]
  /**
   * stores 被两处查询共用，按**该表的调用次序**依次返回，固定是：
   *   1. #259 归属自洽 —— 查**新**门店（`nextStoreId`）。只要 `nextStoreId` 非空就查，
   *      返回 `[]` 表示门店不存在 → 拒绝（`findNearestStoreAncestor` 都不会被调到）
   *   2. §AFF-03 —— 查**旧**门店（`oldStoreId`）拿它的组织节点，再据此找子树上的绑定
   *
   * 所以「调店」类用例两项都要给，且第 1 项是新店的节点、第 2 项是旧店的节点。
   * 只有归属字段无变更（no-op）时第 1 次查询才不发生。
   */
  store?: Array<Record<string, unknown>[]>
  /** 旧店子树上的角色绑定（`findRolesBoundWithinSubtree` 的返回值） */
  bindings?: Array<{ role: string } & Record<string, unknown>>
  /**
   * 该员工**当前实际**持有的角色（`findAllRoleBindings`）。复职提示据此分岔：
   * 空 → 「角色已全部撤销」；非空 → 「离职期间仍保留…」。
   * 默认空 —— 与生产实测一致（27 个离职员工 0 条残留绑定）。
   */
  retainedRoles?: string[]
}) {
  let storeCall = 0
  ;(findNearestStoreAncestor as any).mockImplementation((id: string) =>
    Promise.resolve(
      plan.storeAncestor === '__missing__'
        ? { exists: false }
        : { exists: true, storeAncestorId: plan.storeAncestor ?? null, askedFor: id },
    ),
  )
  ;(findRolesBoundWithinSubtree as any).mockResolvedValue((plan.bindings ?? []).map((b) => b.role))
  /** 复职分支的实查；只有专测复职残留的用例才覆盖它 */
  ;(findAllRoleBindings as any).mockResolvedValue(
    (plan.retainedRoles ?? []).map((role) => ({ role, scopeId: 'org-store-A' })),
  )
  ;(db.select as any).mockImplementation(() => ({
    from: vi.fn().mockImplementation((table: unknown) => {
      if (table === permissionRoles) {
        /**
         * **刻意返回空**。#249 的绑定检测必须走 `findRolesBoundWithinSubtree`
         * （旧店节点及其子树），不能用 `db.select(permissionRoles)` 精确匹配单个节点 ——
         * 那会漏掉挂在旧店下属部门上的绑定。
         * 让这条路返回空，退回精确匹配的实现就会假报 `no_binding_at_old_store` 而变红。
         */
        const where: any = vi.fn().mockImplementation(() => {
          const p: any = Promise.resolve([])
          p.limit = vi.fn().mockResolvedValue([])
          p.for = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
          return p
        })
        return { where }
      }
      const rows = table === orgNodes ? (plan.orgNode ?? [])
        : table === stores ? (plan.store?.[storeCall++] ?? [])
        : table === staffWechatUsers ? (plan.employee ?? [])
        : []
      return selectChain(rows)
    }),
  }))
}

/**
 * `updateEmployee` 的整个写入段现在在一个事务里（codex 谱系第 8/9 轮）：
 * 员工行 UPDATE、离职清角色、§AFF-03 审计、`logUpdate` 全部走 `tx`。
 *
 * 这个默认实现把 `tx` 的各方法**直接指向同名的 `db.*` mock** —— 于是既有用例照旧
 * 摆布 `db.update` / `db.select` 并断言它们，不必每条都重写一遍事务替身。
 * 真正要区分「事务内 vs 事务外」的用例（例如「delete 失败时员工行是否一起回滚」）
 * 自己覆盖 `db.transaction`。
 */
/**
 * ⚠️ `vi.clearAllMocks()` 只清调用记录，**不清 mockImplementation** ——
 * 某条用例把 `logOperation` 设成 reject、或把 `countActiveAdmins` 设成 1 之后，
 * 会一路泄漏到后面所有用例（这个坑本 PR 里踩了两次：第一次是审计 mock，
 * 第二次是 admin 守卫的计数）。每个 beforeEach 显式恢复默认。
 */
function resetSharedMocks() {
  ;(logOperation as any).mockResolvedValue(undefined)
  ;(logUpdate as any).mockResolvedValue(undefined)
  // 与 vi.mock 工厂里的默认保持一致：不是 admin、系统有 5 个活跃 admin
  ;(isAdminEmployee as any).mockResolvedValue(false)
  ;(countActiveAdmins as any).mockResolvedValue(5)
  // 离职路径会在事务内 `tx.delete(permissionRoles)`（tx 透传到 db.delete）—— 给个默认可用链
  ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({}) })
}

function mockTxPassthrough() {
  ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
    update: (db as any).update,
    select: (db as any).select,
    delete: (db as any).delete,
    insert: (db as any).insert,
    execute: (db as any).execute,   // advisory lock 也走这条
  }))
}

/** 取某个判据被问过的 id 列表（用于断言「除旧值外没问过别的」） */
function askedIds(fn: unknown): string[] {
  return ((fn as { mock: { calls: unknown[][] } }).mock.calls).map((c) => c[1] as string)
}
function applyScopeFixture() {
  ;(isInScope as any).mockImplementation((_s: unknown, id: string) => IN_SCOPE_STORES.has(id))
  ;(isOrgNodeInScope as any).mockImplementation((_s: unknown, id: string) => IN_SCOPE_NODES.has(id))
  // 与真实实现同构：admin 短路 + store/org 的 OR
  ;(isEmployeeRowVisible as any).mockImplementation(
    (_s: unknown, storeId: string | null, orgNodeId: string | null) =>
      (!!storeId && IN_SCOPE_STORES.has(storeId)) || (!!orgNodeId && IN_SCOPE_NODES.has(orgNodeId)),
  )
}

describe('updateEmployee — #228 归属变更必须落在 scope 内', () => {
  /**
   * `db.select` 第 1 次调用 = 读旧值（currentEmployee）。
   * 传了 `phone` 的用例会多一次「手机号唯一性」select 抢在前面，故 FULL_FORM 的 phone 恒为 null。
   */
  /**
   * 按**表**分派（不数「第几次 select」）。`stores` 必须返回一行 —— 归属自洽的存在性校验
   * 只要 `nextStoreId` 非空就查它。链走 `selectChain`，因此支持事务内的
   * `.where(...).for('update').limit(1)` 锁行重读。
   */
  function mockCurrentEmployee(row: Record<string, unknown>) {
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => selectChain(
        table === stores ? [{ orgNodeId: null }]
          : table === staffWechatUsers ? [row]
          : [],
      )),
    }))
  }

  function mockUpdateOk() {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  /**
   * 核心回归：断言**精确到本条修复的文案**，不写成「包含『无权』」的宽松匹配。
   *
   * ⚠️ #200 的教训：`updateEmployee` 里另有 `employeeScopeCondition` 拼进 UPDATE 的 WHERE，
   * 越权调店在真库里也可能因旧记录不在 scope 而命中 0 行、退化成「员工不存在或无权修改」。
   * 断言若放宽到「无权」二字，回退掉本条校验后测试会被那条兜底文案蒙混过关而依然全绿。
   * 同时断言 `db.update` 完全没被调用 —— 锁住「校验早于任何写入」。
   */
  /**
   * codex 第 13 轮 P1-1：锁内不仅要重算自洽，**scope 与最终可见性也要重判**。
   *
   * 非 admin 事务外看到 `{store: A, org: A店节点}` 并提交 `{ storeId: null }`；
   * 并发 admin 先把 org 改成 scope 外的市场节点 → 锁内 post-image 是 `{null, 外部节点}`，
   * 两个维度都不在 scope 内 → 该员工从此对操作者**永久消失**（改回去 UPDATE 命中 0 行）。
   * 事务外那次判断看的是 `{null, A店节点}`（可见），所以放过了。
   */
  it('并发插队后锁内 post-image 已不可见 → 拒绝（不让员工永久消失）', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === stores) return selectChain([{ orgNodeId: null }])
        if (table !== staffWechatUsers) return selectChain([])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }
          // 并发把组织节点改到了 scope 外
          : { storeId: 'store-A', orgNodeId: 'org-OUTSIDE', isResigned: false, resignedAt: null }])
      }),
    }))
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { storeId: null })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不在你的管理范围内')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 两谱系第 13 轮共识：§AFF-03 的入口与载荷必须用**锁内** transition。
   *
   * 表单回传 `storeId = A`（用户没动这个字段），而并发已把员工调到 B ——
   * 本次实际是 **B→A 调店**，B 店的角色会滞留。闭包捕获事务外 `oldStoreId(A)` 时
   * 判据 `A === A` 认为「没调店」→ 零审计零披露。
   */
  it('事务外旧店=A、锁内已是 B，表单回传 A → 按 B→A 披露（不是判成没调店）', async () => {
    let selectCall = 0
    let storeCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === stores) {
          // 归属自洽查新店 A；§AFF-03 查旧店（锁内的 B）
          return selectChain([[{ orgNodeId: 'org-store-A' }], [{ orgNodeId: 'org-store-B' }]][storeCall++] ?? [])
        }
        if (table === permissionRoles) return selectChain([])
        if (table !== staffWechatUsers) return selectChain([])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }
          : { storeId: 'store-B', orgNodeId: 'org-store-A', isResigned: false, resignedAt: null }])
      }),
    }))
    ;(findRolesBoundWithinSubtree as any).mockResolvedValue(['manager'])
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    // 旧店必须是锁内的 store-B，而不是事务外的 store-A
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', oldStoreId: 'store-B', newStoreId: 'store-A' }),
      expect.anything(),
    )
    expect(findRolesBoundWithinSubtree).toHaveBeenCalledWith('FY-001', 'org-store-B', expect.anything())
    expect(result.message).toContain('manager')
  })

  /** 反向：事务外无门店、锁内已被挂上 A 店 → 实际是 A→null 调离，同样要披露 */
  it('事务外无门店、锁内已是 A，表单回传 null → 按 A→null 调离披露', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === stores) return selectChain([{ orgNodeId: 'org-store-A' }])
        if (table === permissionRoles) return selectChain([])
        if (table !== staffWechatUsers) return selectChain([])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          ? { storeId: null, orgNodeId: 'market-1', isResigned: false, resignedAt: null }
          : { storeId: 'store-A', orgNodeId: 'market-1', isResigned: false, resignedAt: null }])
      }),
    }))
    ;(findRolesBoundWithinSubtree as any).mockResolvedValue(['finance'])
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { storeId: null })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', oldStoreId: 'store-A', newStoreId: null }),
      expect.anything(),
    )
    expect(result.message).toContain('finance')
  })

  /**
   * codex 第 14 轮 P1：锁内只重判「最终可见性」不够，**逐字段 scope 也要按 before→after 重判**。
   *
   * 员工初始 `{store: B(越界), org: M(scope 内)}`；操作者先发一个回传旧值 `B` 的请求、
   * 再用另一个请求把 store 合法改成 `A`。旧请求锁行后实际执行 `A→B` ——
   * 而 `M` 仍可见，只做「最终可见性」就会放过，门店被写回越界的 B。
   */
  it('锁内发生越界变化但另一维仍可见 → 仍拒绝（不能只看最终可见性）', async () => {
    let selectCall = 0
    ;(db.select as any).mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === stores) return selectChain([{ orgNodeId: null }])
        if (table !== staffWechatUsers) return selectChain([])
        const outsideTx = selectCall++ === 0
        return selectChain([outsideTx
          // 事务外：旧店已经是越界的 store-OUT → 回传同值，事务外判据认为「没变」
          ? { storeId: 'store-OUT', orgNodeId: 'market-1', isResigned: false, resignedAt: null }
          // 锁内：并发已把门店合法改成 store-A → 本次实际是 A → OUT 的越界迁移
          : { storeId: 'store-A', orgNodeId: 'market-1', isResigned: false, resignedAt: null }])
      }),
    }))
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-OUT' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('storeId 改到 scope 外门店 → 拒绝（完整表单 + 乐观锁的真实调用形态），且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(isInScope).toHaveBeenCalledWith(mockSession, 'store-OTHER')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('orgNodeId 改到 scope 外组织节点 → 拒绝（完整表单 + 乐观锁），且零写入', async () => {
    mockCurrentEmployee({ storeId: null, orgNodeId: 'dept-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001',
      { ...FULL_FORM, storeId: null, orgNodeId: 'market-OTHER' },
      EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-OTHER')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 职能岗员工（store_id 为 NULL、靠 org_node_id 命中 scope）—— issue 点名的人群。
   * 早先零覆盖：给守卫加 `oldStoreId !== null` 前置条件即可让它对这批人整体失效而测试全绿。
   */
  it('职能岗员工（storeId 为 null）被调到 scope 外门店 → 仍拒绝', async () => {
    mockCurrentEmployee({ storeId: null, orgNodeId: 'dept-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER', orgNodeId: 'dept-A' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('storeId 合法但 orgNodeId 越界 → 仍被拒（两条校验都在，不是二选一）', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-B', orgNodeId: 'dept-OTHER' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该组织节点')
    expect(db.update).not.toHaveBeenCalled()
  })

  /** 越权调店常与「顺手标离职」等组合提交同批出现，守卫不得被其它字段的存在与否开关掉 */
  it('越权调店 + 同批标离职 → 仍拒绝，且离职清角色的事务也不执行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: 'store-OTHER', isResigned: true }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  /**
   * 同批改手机号把函数推进另一条分支序列（手机号要过格式校验、要进 updateData）。
   * 守卫不得因此被跳过（给它套 `if (data.phone === undefined)` 这类前置条件时本例变红）。
   *
   * 事务外的手机号查重已整体删除（它查全表，是零写入探测信道），唯一性交给 DB 约束 +
   * 23505 转译 —— 所以这里不再有「第 2 次唯一性 select」。
   */
  it('越权调店 + 同批改手机号 → 仍拒绝', async () => {
    ;(db.select as any).mockImplementation(
      mockSelectExistingEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' }),
    )
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001',
      { ...FULL_FORM, phone: '13900000001', storeId: 'store-OTHER' },
      EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权将员工调至该门店')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * GLM 谱系第 2 轮：手机号查重查的是**全表**，排在可见性拦截之前就是又一个同构 oracle ——
   * 拿任意不可见/不存在的 employeeId 提交 `{ phone: X }`，X 被占用 → 「该手机号已被其他员工使用」，
   * 未被占用 → 「员工不存在或无权修改」，据此可枚举任意手机号是否注册为员工。
   */
  it('对不可见员工提交已被占用的手机号 → 仍返回统一文案，不泄露手机号是否已注册', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      const current = call
      const limit = vi.fn().mockImplementation(() =>
        current === 1
          ? Promise.resolve([{ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' }])  // 不可见的旧行
          : Promise.resolve([{ employeeId: 'FY-SOMEONE' }]),                          // 手机号确实被占用
      )
      const where = vi.fn().mockReturnValue({ limit })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-OTHER', { ...FULL_FORM, phone: '13900000002' }, EXPECTED_AT,
    )

    expect(result.message).toBe('员工不存在或无权修改')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * #249 拍板后语义变了：调店**不再**搬迁角色绑定，只留审计 + 回传提示。
   * 这条现在钉的是「归属改成功 + permission_roles 一条都没动」。
   */
  it('storeId 改到 scope 内门店 → 放行，且 permission_roles 一条都不动', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ id: 1, role: 'manager', scopeId: 'org-store-A' }],
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)   // 仅员工行
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', roles: ['manager'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * boundary-critic P1-2：§AFF-03 会越权改写 permission_roles。
   *
   * `employeeScopeCondition` 是 `store_id ∈ scope` **OR** `org_node_id ∈ scope` ——
   * 员工靠 org_node_id 命中即可被更新，此时它的 store_id 可以指向操作者看不见的门店。
   * 于是「把外店员工调进自己店」会执行
   * `UPDATE permission_roles SET scope_id=<我的店> WHERE scope_id=<外店>`：
   * 既剥夺了他对外店的角色、又授予了他对我店的角色，而操作者不持 permission:assign/revoke。
   */
  it('旧门店在 scope 外 → 员工归属照改，但 permission_roles 同步被跳过并留痕', async () => {
    mockSelectByTable({
      // 旧 store 是 scope 外的 store-OUT，但 org_node 在 scope 内 → 行可见
      employee: [{ storeId: 'store-OUT', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-A' }]],   // 归属自洽查新门店 store-A
      bindings: [],
    })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    // 只有员工行那一次 UPDATE；permission_roles 不许被动
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'old_store_out_of_scope', oldStoreId: 'store-OUT' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * 边界①：编辑表单会把未改动的归属字段一并回传。对 no-op 提交报「无权」是纯误伤，
   * 所以新值校验只在 `next !== old` 时触发。
   *
   * 判据仍会被调用一次 —— 那是「旧行是否可见」那道（见下方信息 oracle 用例），
   * 所以这里断言的是**没有以任何新值去问过判据**，而不是「完全没调用」。
   */
  it('归属字段回传旧值（no-op 整表提交）→ 不对新值做 scope 校验，放行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { ...FULL_FORM }, EXPECTED_AT)

    expect(result.success).toBe(true)
    // 只可能以**旧值**被问过（可见性判定，且它是短路 OR —— store 命中后就不再问 org）。
    // 断言「除旧值外没问过别的」，不依赖短路顺序。
    expect(askedIds(isInScope).filter((id) => id !== 'store-A')).toEqual([])
    expect(askedIds(isOrgNodeInScope).filter((id) => id !== 'org-store-A')).toEqual([])
  })

  /**
   * 边界②：单端清空放行。市场级 manager 把门店员工转市场直属岗正是
   * 「storeId 清空 + orgNodeId 设为市场节点」—— 清空后仍靠 orgNodeId 可见。
   */
  it('storeId 置 null 且 orgNodeId 给 scope 内市场节点（转市场直属岗）→ 放行', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: 'market-1' }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-1')
  })

  /**
   * 边界③：变更后必须仍可见。两端同时清空是最直白的一种 ——
   * 双空的行对所有非 admin 都不命中（含操作者自己 → 不可逆），而 permission_roles 一字不动，
   * 等于把一个仍持有效角色、仍能登录的账号从所有非 admin 名册里永久抹掉。
   */
  it('两端同时清空 → 拒绝，且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: null }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('员工必须归属门店或组织节点之一')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 边界③的另一半（GLM 谱系发现）：写成「两端不能都空」会漏掉这一整类 ——
   * 员工 `(storeId=本店, orgNodeId=外市场节点)` 靠 store 维度可见，单清 storeId 后
   * 另一端虽**非空**却在 scope 外，员工同样永久消失且不可逆。
   */
  it('单端清空后另一端在 scope 外 → 拒绝（非空也不行），且零写入', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-MX' })
    mockUpdateOk()

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: 'org-MX' }, EXPECTED_AT,
    )

    expect(result.success).toBe(false)
    expect(result.message).toBe('变更后该员工将不在你的管理范围内，请先转交给有权管理该归属的同事')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('admin 两端同时清空 → 放行（不受限）', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()
    ;(isAdminScope as any).mockReturnValue(true)

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: null, orgNodeId: null }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
  })

  /**
   * codex 谱系 P2：「新旧值相同则跳过校验」会把响应差异变成**归属信息 oracle**。
   *
   * 拿 scope 外的员工编号反复提交不同的 storeId —— 猜错时返回「无权将员工调至该门店」，
   * 猜中其真实旧门店时因 `next === old` 跳过校验、最终由 UPDATE 命中 0 行返回
   * 「员工不存在或无权修改」。两句话的差异就能枚举出任意员工的真实归属。
   *
   * 修复是：旧行存在但不可见时立刻返回与「员工不存在」**完全相同**的一句话。
   * 下面两条断言的正是「猜中」与「猜错」不可区分。
   */
  /**
   * codex 谱系两轮追出来的信息泄露，最终形态是**三方等价**。
   *
   * 第 1 轮：「新旧值相同则跳过校验」把响应差异变成归属 oracle —— 拿 scope 外的员工编号
   * 反复提交不同 storeId，猜错返回「无权将员工调至该门店」、猜中其真实旧门店时跳过校验
   * 并最终由 UPDATE 命中 0 行返回「员工不存在或无权修改」，据此可枚举任意员工的真实归属。
   *
   * 第 2 轮：只拦「存在但不可见」还不够 —— 那只是把 oracle 换成「employeeId 是否存在」：
   * 不存在的记录会一路走到 UPDATE，带乐观锁时返回「数据已被其他人修改」、不带时返回
   * 「无权将员工调至该门店」，而且它多跑了一次 db.update（调用次数/耗时差异）。
   *
   * 所以这里断言三种输入的响应**逐字相同且都零写入**：
   * ① 员工不存在 ② 存在但不可见 + 猜错旧门店 ③ 存在但不可见 + 猜中旧门店。
   */
  it('不存在 / 不可见猜错 / 不可见猜中 → 三者响应逐字相同且均零写入（无信息泄露）', async () => {
    const probe = async (opts: { exists: boolean; guess: string | null }) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (opts.exists) {
        mockCurrentEmployee({ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      mockUpdateOk()
      const result = await updateEmployee(
        'FY-PROBE',
        { ...FULL_FORM, storeId: opts.guess, orgNodeId: 'org-SECRET' },
        EXPECTED_AT,
      )
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    const notFound = await probe({ exists: false, guess: 'store-GUESS' })
    const wrongGuess = await probe({ exists: true, guess: 'store-GUESS' })
    const rightGuess = await probe({ exists: true, guess: 'store-SECRET' })

    expect(wrongGuess.result).toEqual(notFound.result)
    expect(rightGuess.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    // 三条路径都不许触碰 db.update —— 否则调用次数/耗时本身就是信道
    expect([notFound.wrote, wrongGuess.wrote, rightGuess.wrote]).toEqual([0, 0, 0])
  })

  /** 不带乐观锁时同样三方等价（第 2 轮指出这是另一条可区分路径） */
  it('不带 expectedUpdatedAt 时，不存在与不可见仍然响应相同且零写入', async () => {
    const probe = async (exists: boolean) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (exists) {
        mockCurrentEmployee({ storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      mockUpdateOk()
      const result = await updateEmployee('FY-PROBE', { storeId: 'store-OTHER' })
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    const notFound = await probe(false)
    const invisible = await probe(true)

    expect(invisible.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    expect([notFound.wrote, invisible.wrote]).toEqual([0, 0])
  })

  /**
   * codex 谱系第 3 轮给的更精确攻击：泄露的不只是「手机号是否注册」，而是
   * **手机号与员工编号的对应关系**。手机号查重带 `employee_id != $target`：
   *   - 拿一个**不存在**的 employeeId 提交手机号 P → 查重命中 P 的主人 → 「该手机号已被其他员工使用」
   *   - 拿 P 的**真正主人**（scope 外）的 employeeId 提交同一个 P → `!= 自己` 把该行排除 → 另一句话
   * 两句话的差异即可确认「P 属于哪个 employeeId」。事务外查重删除后，两者同句。
   */
  it('同一手机号 × 不存在的编号 / 其真正主人的编号 → 响应逐字相同', async () => {
    const probe = async (targetId: string, oldRow: Record<string, unknown> | null) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      let call = 0
      ;(db.select as any).mockImplementation(() => {
        call++
        const current = call
        const limit = vi.fn().mockImplementation(() =>
          current === 1
            ? Promise.resolve(oldRow ? [oldRow] : [])
            // 存量遗留形态：若还有任何全表手机号预查，就会命中 scope 外的这个占用者
            : Promise.resolve([{ employeeId: 'FY-OWNER' }]),
        )
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      })
      mockUpdateOk()
      const result = await updateEmployee(targetId, { ...FULL_FORM, phone: '13900000003' }, EXPECTED_AT)
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    // 不存在的编号
    const notFound = await probe('FY-NOPE', null)
    // 该手机号真正主人的编号（scope 外 → 不可见）
    const realOwner = await probe('FY-OWNER', { storeId: 'store-SECRET', orgNodeId: 'org-SECRET' })

    expect(realOwner.result).toEqual(notFound.result)
    expect(notFound.result.message).toBe('员工不存在或无权修改')
    expect([notFound.wrote, realOwner.wrote]).toEqual([0, 0])
  })

  /**
   * 连追五轮的终局：**手机号查重整体删除**，改由 DB 唯一约束 + 23505 转译承担。
   *
   * 每一轮的修复都"看起来完整"，下一轮都能找到同构变体：
   *   轮 3：查重在可见性前 → 任意 employeeId 可探测，且能确认「P 属于哪个 employeeId」
   *   轮 4：移到可见性后 → 可见员工 + 越界门店，两条路径都零写入
   *   轮 5：再移到归属校验后 → **仍有** 乐观锁命中 0 行、离职前 admin 守卫这些零写入失败路径可配对
   * 只要那次全表预查排在任何可能失败的步骤之前，就总能配出一对「零写入但响应不同」。
   *
   * 下面三组对照分别覆盖轮 3/4/5 的攻击形态，全部要求响应逐字相同且零写入。
   */
  it('手机号探测的三种配对（不可见 / 越界门店 / 乐观锁未命中）均无零写入信道', async () => {
    const probe = async (opts: {
      oldRow: Record<string, unknown> | null
      storeId: string | null
      updateCount: number
    }) => {
      vi.clearAllMocks()
      ;(getSession as any).mockResolvedValue(mockSession)
      applyScopeFixture()
      ;(isAdminScope as any).mockReturnValue(false)
      if (opts.oldRow) {
        ;(db.select as any).mockImplementation(mockSelectExistingEmployee(opts.oldRow))
      } else {
        ;(db.select as any).mockImplementation(mockSelectEmpty())
      }
      const where = vi.fn().mockResolvedValue({ count: opts.updateCount })
      ;(db.update as any).mockReturnValue({ set: vi.fn().mockReturnValue({ where }) })
      const result = await updateEmployee(
        'FY-PROBE',
        { ...FULL_FORM, phone: '13900000006', storeId: opts.storeId ?? undefined },
        EXPECTED_AT,
      )
      return { result, wrote: (db.update as any).mock.calls.length }
    }

    // 轮 3 形态：目标不可见 —— 不管手机号占没占用都同一句话、零写入
    const invisible = await probe({
      oldRow: { storeId: 'store-SECRET', orgNodeId: 'org-SECRET' }, storeId: null, updateCount: 1,
    })
    expect(invisible.result.message).toBe('员工不存在或无权修改')
    expect(invisible.wrote).toBe(0)

    // 轮 4 形态：目标可见但门店越界 —— 拒绝发生在任何手机号相关查询之前
    const outOfScope = await probe({
      oldRow: { storeId: 'store-A', orgNodeId: 'org-store-A' }, storeId: 'store-OTHER', updateCount: 1,
    })
    expect(outOfScope.result.message).toBe('无权将员工调至该门店')
    expect(outOfScope.wrote).toBe(0)

    // 轮 5 形态：一路合法但乐观锁未命中 —— 这条**必须**真的发起 UPDATE
    // （手机号冲突与否现在都只能由这次 UPDATE 的结果体现，探测不再免费）
    const staleLock = await probe({
      oldRow: { storeId: 'store-A', orgNodeId: 'org-store-A' }, storeId: 'store-B', updateCount: 0,
    })
    expect(staleLock.result.message).toBe('数据已被其他人修改，请刷新后重试')
    expect(staleLock.wrote).toBe(1)
  })

  /** 源码里不得再出现事务外的全表手机号预查（防复发） */
  it('updateEmployee / createEmployee 都不再做事务外手机号预查重', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/actions/employees.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    // 特征是「以 phone 做**等值**条件」；`searchEmployees` 的列选择与 ilike 模糊搜索不算
    expect(src, '事务外的全表手机号等值预查又回来了 —— 它是零写入探测信道')
      .not.toMatch(/eq\(staffWechatUsers\.phone/)
  })

  /** 空串是「不填」而非「一个叫 '' 的门店」，与 createEmployee 的 truthiness 口径对齐 */
  it('storeId 传空串 → 按清空处理（不报无权），且写库值归一为 null', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee(
      'FY-001', { ...FULL_FORM, storeId: '', orgNodeId: 'org-store-A' }, EXPECTED_AT,
    )

    expect(result.success).toBe(true)
    expect(isInScope).not.toHaveBeenCalledWith(mockSession, '')
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ storeId: null }))
  })

  it('不涉及归属字段的编辑（改姓名）→ 不以任何新值询问判据', async () => {
    mockCurrentEmployee({ storeId: 'store-A', orgNodeId: 'org-store-A' })
    mockUpdateOk()

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(askedIds(isInScope).filter((id) => id !== 'store-A')).toEqual([])
    expect(askedIds(isOrgNodeInScope).filter((id) => id !== 'org-store-A')).toEqual([])
  })

  // admin 不受限（isInScope / isOrgNodeInScope 内部的 isAdminScope 短路）与真实 session 塑形
  // 由 employees.scope-integration.test.ts 覆盖 —— 本文件把这些判据整体 mock 掉了。
})

describe('createEmployee — #228 归属同样受 scope 约束', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  const BASE = { name: '张三', phone: '13812345678', idCard: '110101199003078888' }

  /**
   * `employeeScopeCondition` 是 store_id ∪ org_node_id 的 OR，只挡 storeId 等于没挡：
   * `{ storeId: null, orgNodeId: <别的市场节点> }` 能在他人 scope 里凭空造一条员工记录，
   * 目标市场的 manager 看得见也编辑得了，创建者自己反而看不见。
   */
  it('orgNodeId 不在 scope 内 → 拒绝，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: 'market-OTHER' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权在该组织节点下创建员工')
    expect(isOrgNodeInScope).toHaveBeenCalledWith(mockSession, 'market-OTHER')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内但 orgNodeId 越界 → 仍拒绝（两条校验都在）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: 'dept-OTHER' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('无权在该组织节点下创建员工')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('两端都在 scope 内 → 正常创建', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: 'dept-A' })

    expect(result.success).toBe(true)
  })

  it('orgNodeId 为 null 但 storeId 在 scope 内 → 跳过组织节点校验，正常创建', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')

    const result = await createEmployee({ ...BASE, storeId: 'store-A', orgNodeId: null })

    expect(result.success).toBe(true)
    expect(isOrgNodeInScope).not.toHaveBeenCalled()
  })

  /**
   * 两个谱系独立命中的 P1：两条校验都以字段 truthy 为前提，双空时一条都不触发。
   * 普通 manager 提交空表单即可建出一条对**所有非 admin** 永不命中的员工记录 ——
   * 创建成功却立刻从自己名册消失，且此后任何非 admin 都无法修复（scopeCond 命中 0 行），
   * 而该手机号仍可被员工端 bindPhone 绑定。这是 updateEmployee 侧同一条不变量的 create 面。
   */
  it('两端都不填 → 非 admin 拒绝，不进事务', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: null })

    expect(result.success).toBe(false)
    expect(result.message).toBe('员工必须归属门店或组织节点之一')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('两端都不填 + admin → 放行', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess('FY-260315001')
    ;(isAdminScope as any).mockReturnValue(true)

    const result = await createEmployee({ ...BASE, storeId: null, orgNodeId: null })

    expect(result.success).toBe(true)
  })
})

// ── #249 调店不搬角色 / #259 归属自洽 ─────────────────────────────────────

describe('#249 调店不自动搬迁角色绑定 —— 只留审计 + 回传提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
    ;(isInScope as any).mockImplementation((_s: unknown, id: string) => IN_SCOPE_STORES.has(id))
    mockTxPassthrough()
    resetSharedMocks()
  })

  function mockUpdateOnce() {
    const calls: Array<{ set: unknown }> = []
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockImplementation((payload: unknown) => {
        calls.push({ set: payload })
        return { where: vi.fn().mockResolvedValue({ count: 1 }) }
      }),
    }))
    return calls
  }

  /**
   * 核心不变量：`updateEmployee` **永不**改 permission_roles。
   * 生产上 31 个「员工 × 角色」对持多条绑定、最多一人绑 5-6 个门店，
   * 而数据模型没有「该绑定随主门店移动」的标记 —— 自动搬迁等于猜（口径已拍板）。
   */
  it('旧店有角色绑定 → permission_roles 一条都不动，写 manual_review_required 并回传清单', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ id: 1, role: 'manager', scopeId: 'org-store-A' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 只有员工行那一次 UPDATE
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', roles: ['manager'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    // 操作者必须当场看到需要跟进的角色，不能只躺在审计里
    expect(result.message).toContain('仍绑定在原门店')
    expect(result.message).toContain('manager')
  })

  it('旧店有多个角色 → 全部列入提示，去重', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [
        { id: 1, role: 'manager', scopeId: 'org-store-A' },
        { id: 2, role: 'finance', scopeId: 'org-store-A' },
      ],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(result.message).toContain('manager')
    expect(result.message).toContain('finance')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  it('旧店没有绑定 → 记 no_binding_at_old_store，不加提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(result.message).toBe('员工信息已更新')   // 无需跟进就不打扰
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'no_binding_at_old_store' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * #228 的旧店 scope 守卫保留 —— 两种情形对管理员的含义不同：
   * 「你无权管那条绑定」vs「需要有权者复核」。
   */
  it('旧门店不在操作者 scope 内 → 记 old_store_out_of_scope（与需复核区分开）', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-OUT', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-OUT' }]],
      bindings: [{ id: 1, role: 'manager', scopeId: 'org-store-OUT' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'old_store_out_of_scope' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  it('旧门店未配置组织节点 → 记 store_missing_org_node', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      store: [[{ orgNodeId: null }]],
      bindings: [],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'store_missing_org_node' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * codex 谱系第 2 轮：入口条件原本是 `nextStoreId && oldStoreId && 两者不同`，
   * 于是「A → 无门店」（转市场直属岗）**一条审计都不记、也不回传** ——
   * 而旧店角色照样留在原地，成了权限跟进盲区。
   */
  it('storeId 从有到无（转市场直属岗）→ 仍检查旧店绑定并回传提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [{ role: 'manager' }],
    })
    mockUpdateOnce()

    // 清空门店 + 挂 scope 内的市场节点（合法的转直属岗路径）
    const result = await updateEmployee('FY-001', { storeId: null, orgNodeId: 'market-1' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', roles: ['manager'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(result.message).toContain('仍绑定在原门店')
  })

  /**
   * 绑定检测的根是 `stores.org_node_id`，查的是**它及其子树**。
   *
   * ⚠️ 这条用例原先叫「绑定挂在旧店的下属部门节点上 → 仍被检测到」，断言的是一个
   * **DB 层造不出来的状态**：trigger `permission_validate_role_assignment_scope()` 不允许
   * 角色绑到部门型节点，且生产上门店节点零子节点（第 4 轮真库冒烟证实，证据见
   * `@/lib/org-ancestry`）。守护一个不可达的场景是虚假保障 —— 它让人以为覆盖了真实风险。
   * 改成只断言这一层真正该负责的事：拿到什么绑定清单，就记什么 reason、回传什么文案。
   * 子树语义本身（下探方向、去重、employee 过滤）由真库冒烟负责。
   */
  /**
   * codex 谱系第 9 轮 P1：**所有**审计都必须与 UPDATE 同生共死。
   * 留在事务外时，`logUpdate` / `reinstated.*` / `scopeSync.skipped` 任一失败都会留下
   * 「状态已改、前端显示失败」；复职那条更糟 —— 重试不再进入 `isReinstating`，提示永久丢失。
   */
  it.each([
    ['employee.update 审计失败 → 整体回滚（不留下「已改但报失败」）', 'employee.update'],
    ['复职审计失败 → 整体回滚（否则重试不再进复职分支，提示永久丢失）', 'permission.reinstated'],
    ['§AFF-03 审计失败 → 整体回滚', 'permission.scopeSync.skipped'],
  ])('%s', async (_label, failingAction) => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()
    ;(logOperation as any).mockImplementation((_s: unknown, action: string) =>
      action.startsWith(failingAction) ? Promise.reject(new Error('audit down')) : Promise.resolve())
    ;(logUpdate as any).mockImplementation(() =>
      failingAction === 'employee.update' ? Promise.reject(new Error('audit down')) : Promise.resolve())

    // 审计在事务内 → 失败即抛出，整笔回滚；不会出现「成功返回但审计缺失」
    await expect(updateEmployee('FY-001', { storeId: 'store-B', isResigned: false })).rejects.toThrow('audit down')
  })

  /**
   * 「审计失败会抛出」不等于「审计在事务里」—— 上一版红检（把 `logUpdate` 的 `tx` 去掉）
   * **没有变红**，因为那组用例只断言抛出。判据必须是「审计收到的 executor 就是那个 tx」。
   */
  /**
   * codex 谱系第 10 轮 P2：其余断言多用 `expect.anything()`，辅助函数若「保留参数但内部
   * 仍用全局 db」会全绿。这条用**同一性**（`toBe`）把所有辅助调用都钉到那个 tx 上。
   */
  it('事务内所有辅助调用都收到同一个 tx（不是全局 db）', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ role: 'manager' }],
      retainedRoles: ['manager'],
    })
    mockUpdateOnce()
    let handedTx: unknown
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        update: (db as any).update,
        select: (db as any).select,
        delete: (db as any).delete,
        insert: (db as any).insert,
      }
      handedTx = tx
      return fn(tx)
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-B', isResigned: false })

    expect(result.success).toBe(true)
    expect((findAllRoleBindings as any).mock.calls[0][1], '复职快照').toBe(handedTx)
    expect((findRolesBoundWithinSubtree as any).mock.calls[0][2], '§AFF-03 绑定查询').toBe(handedTx)
    expect((logOperation as any).mock.calls[0][5], '§AFF-03 审计').toBe(handedTx)
    expect((logUpdate as any).mock.calls[0][6], 'employee.update 审计').toBe(handedTx)
    /**
     * 复职审计同样要同一性 —— 原来用 `expect.anything()`，传 db 也能过（GLM 第 10 轮 P2-3）。
     * 它若跑在事务外，失败会让员工已复职而重试不再进 `isReinstating`，提示永久丢失。
     */
    const reinstated = (logOperation as any).mock.calls
      .find((c: unknown[]) => String(c[1]).startsWith('permission.reinstated'))
    expect(reinstated, '本用例是复职 + 调店，应有复职审计').toBeDefined()
    expect(reinstated[5], '复职审计').toBe(handedTx)
  })

  /** 离职路径的两个 admin 守卫查询同样必须走 tx（否则守卫读的是另一个快照） */
  it('离职守卫的两次查询都收到同一个 tx', async () => {
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    ;(isAdminEmployee as any).mockResolvedValue(true)
    ;(countActiveAdmins as any).mockResolvedValue(5)
    let handedTx: unknown
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        update: (db as any).update,
        select: (db as any).select,
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        insert: (db as any).insert,
      }
      handedTx = tx
      return fn(tx)
    })
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })

    await updateEmployee('FY-001', { isResigned: true })

    expect((isAdminEmployee as any).mock.calls[0][1]).toBe(handedTx)
    expect((countActiveAdmins as any).mock.calls[0][0]).toBe(handedTx)
  })

  it('employee.update 审计与 UPDATE 共用同一个事务句柄', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    let handedTx: unknown
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
        select: (db as any).select,
        delete: vi.fn(),
        insert: vi.fn(),
        execute: (db as any).execute,
      }
      handedTx = tx
      return fn(tx)
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // logUpdate(session, action, targetType, targetId, before, after, executor) —— 第 7 参
    expect((logUpdate as any).mock.calls[0][6]).toBe(handedTx)
    // §AFF-03 的审计（第 6 参）同理
    expect((logOperation as any).mock.calls[0][5]).toBe(handedTx)
  })

  /**
   * 事务扩大后，**审计日志自身**的 FK（operator / org_node）并发失效也会抛 `23503`，
   * 那跟用户选的门店毫无关系 —— 给「所选门店或组织节点已被删除」是误导（codex 第 9 轮 P2）。
   */
  it('审计自身的 FK 冲突（非员工表约束）→ 通用并发文案，不谎称门店被删', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()
    ;(logUpdate as any).mockRejectedValue(Object.assign(new Error('fk'), {
      code: '23503', // 真名（已用 pg_constraint 核对）—— 它**也包含** `staff_wechat_users`，
      // 所以 `includes()` 式判据会误判成「门店已删除」，必须精确白名单
      constraint: 'operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk',
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('数据冲突，请稍后重试')
    expect(result.message).not.toContain('所选门店')
  })

  it('拿到非空绑定清单 → 记 manual_review_required 并回传该清单', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ role: 'finance' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 根必须是旧门店的组织节点，不是新门店的、也不是员工的 orgNodeId
    expect(findRolesBoundWithinSubtree).toHaveBeenCalledWith('FY-001', 'org-store-A', expect.anything())
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', roles: ['finance'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(result.message).toContain('finance')
  })

  /**
   * codex 谱系第 2 轮：「调店 + 同批离职」时离职分支已把角色全删，
   * 再查旧店绑定必为空 → 记 `no_binding_at_old_store` 是语义失真
   * （实际是「因离职撤销」）。单独给一个 reason，且不回传提示（角色确实已撤销）。
   */
  it('调店 + 同批离职 → 记 roles_revoked_by_resignation，不回传提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()
    // 离职路径整体在一个事务里：tx.update（员工行 CAS）+ tx.select/delete（角色）
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }),
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B', isResigned: true })

    expect(result.success).toBe(true)
    expect(result.message).toBe('员工信息已更新')   // 无跟进事项
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'roles_revoked_by_resignation' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * GLM 谱系第 2 轮：`old_store_out_of_scope` 是四条路径里唯一**零回传**的 ——
   * 而 PR 自己的注释写着「提示不是可选项」。跨 scope 调店恰恰最容易滞留。
   * 这条路径刻意不读角色名（不向无权者披露），但要给不含角色名的降级提示。
   */
  it('旧门店不在 scope 内 → 回传不含角色名的降级提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-OUT', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-OUT' }]],
      bindings: [{ role: 'manager' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    expect(result.message).toContain('原门店不在你的管理范围内')
    expect(result.message).toContain('请联系有权限的管理员复核')
    // 不得泄露角色名
    expect(result.message).not.toContain('manager')
  })

  /** codex 第 3 轮：跨 scope + 同批离职 —— 离职判定必须先于 scope 判定 */
  it('跨 scope 调店 + 同批离职 → 记 roles_revoked_by_resignation（不是 old_store_out_of_scope）', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-OUT', orgNodeId: 'org-store-A' }],  // 靠 org 维可见
      store: [[{ orgNodeId: 'org-store-OUT' }]],
      bindings: [{ role: 'manager' }],
    })
    mockUpdateOnce()
    // 离职路径整体在一个事务里：tx.update（员工行 CAS）+ tx.select/delete（角色）
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }),
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-A', isResigned: true })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'roles_revoked_by_resignation' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    // 不得再返回「可能仍有角色绑定」——角色已被离职分支删光
    expect(result.message).toBe('员工信息已更新')
  })

  /**
   * 此前已离职、本次只改归属（payload 不带 isResigned）→ **查事实**，不按 `is_resigned` 推断。
   *
   * 第 5 轮这里记的是 `roles_revoked_by_resignation`（把「曾经离职」等同于「角色已清空」）。
   * 第 6 轮两谱系各自指出那个不变量会破：写 `is_resigned` 的 UPDATE 与删角色的事务是两次
   * 独立提交，`sync-workfine.js` 更是直接改 `is_resigned` 而完全不碰角色。
   * 真没绑定时两种写法语义等价（见本条）；有残留时只有查事实才会披露（见下一条）。
   */
  it('已离职员工再改归属 + 旧店确实无绑定 → 记 no_binding_at_old_store', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'no_binding_at_old_store' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * 残留态：离职行 + 有效角色。押注不变量时这一支被 `roles_revoked_by_resignation` 吞掉，
   * 操作者以为角色早已撤销，实际员工仍持有旧店权限（`login` 也不校验在职，见
   * `@/lib/employee-roles` 的注释，那是本 PR 范围外的独立缺口）。
   */
  it('已离职员工再改归属 + 旧店有残留绑定 → 如实披露，不被「已离职」吞掉', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ role: 'manager' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required', roles: ['manager'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(result.message).toContain('manager')
  })

  /**
   * **复职 = 角色真空**，必须提示重新授权（codex 谱系第 5 轮 P1）。
   *
   * ⚠️ 这条用例上一版给已离职员工**伪造**了一条 `manager` 绑定，于是它验的是
   * 「复职时旧店还有绑定」—— 而标记离职的事务把该员工全部角色删光了，这个状态根本不存在。
   * 伪造夹具正好避开了真实的角色真空，那次修复（把判据从 `||` 改成 `??`）也就没闭合任何东西：
   * 旧店查出来必然是空 → 落进 `no_binding_at_old_store` → 返回干净的「员工信息已更新」。
   * 与「守护 DB 造不出来的状态」同类的测试设计错误。
   *
   * 现在夹具用真实状态（`bindings: []`），断言复职提示确实出现。
   */
  it('复职 + 同批调店（真实角色真空）→ 回传「需重新授权」提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],           // 离职时已全部删除 —— 这才是真实状态
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B', isResigned: false })

    expect(result.success).toBe(true)
    expect(result.message).toContain('离职时角色已全部撤销')
    expect(result.message).toContain('重新授权')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.reinstated.rolesEmpty', 'permission_role', 'FY-001',
      expect.objectContaining({ oldStoreId: 'store-A', newStoreId: 'store-B' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * 复职 + **残留绑定**：提示必须与事实相符。
   * 写死「角色已全部撤销」在这个状态下正好说反 —— 员工复职即恢复这些权限，
   * 操作者必须当场知道（第 6 轮两谱系共识）。
   */
  it('复职 + 离职期间残留绑定 → 提示「仍保留」并列出角色，不说「已全部撤销」', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
      retainedRoles: ['manager', 'finance'],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { isResigned: false })

    expect(result.success).toBe(true)
    expect(result.message).toContain('仍保留以下角色绑定')
    expect(result.message).toContain('manager')
    expect(result.message).toContain('finance')
    expect(result.message).not.toContain('已全部撤销')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.reinstated.rolesRetained', 'permission_role', 'FY-001',
      expect.objectContaining({ roles: ['manager', 'finance'] }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
  })

  /**
   * 复职角色快照与整笔操作**同生共死**。
   *
   * 演化两轮：第 7 轮要求它在 UPDATE **之前**（当时写入没进事务，查询失败会留下
   * 「已复职但报错」，重试又不再进复职分支 → 提示永久丢失）；第 10 轮整个写入段进了事务，
   * 「零写入」由回滚承担，于是挪到 CAS **成功之后** —— 快照与「员工已在职」这个事实
   * 更接近同一时点（codex 谱系第 10 轮 P2）。
   * 判据因此从「快照早于 UPDATE」变成「快照失败则整笔回滚」。
   */
  it('复职时角色快照查询失败 → 整笔回滚（不能留下「已复职但报错」）', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    ;(findAllRoleBindings as any).mockRejectedValue(new Error('connection terminated'))
    mockUpdateOnce()
    let rolledBack = false
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      try {
        return await fn({
          execute: vi.fn().mockResolvedValue([]),
          update: (db as any).update,
          select: (db as any).select,
          delete: (db as any).delete,
          insert: (db as any).insert,
        })
      } catch (err) {
        rolledBack = true      // 真库里这一步就是 ROLLBACK
        throw err
      }
    })

    await expect(updateEmployee('FY-001', { isResigned: false })).rejects.toThrow()
    expect(rolledBack, '快照失败必须让整笔事务回滚，否则员工已复职而提示丢失').toBe(true)
  })

  /** 快照在 CAS 之后、审计之前 —— 顺序错了会拿到与「已在职」不同时点的角色集合 */
  it('复职的角色快照在 CAS 成功之后拍', async () => {
    const order: string[] = []
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    ;(findAllRoleBindings as any).mockImplementation(() => {
      order.push('snapshot')
      return Promise.resolve([])
    })
    ;(db.update as any).mockImplementation(() => {
      order.push('update')
      return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }
    })

    const result = await updateEmployee('FY-001', { isResigned: false })

    expect(result.success).toBe(true)
    expect(order).toEqual(['update', 'snapshot'])
  })

  /**
   * 两谱系第 14 轮共识：§AFF-03 的判据必须是「**本次请求**撤销了角色」
   * （`rolesRevokedByRequest`），不是状态迁移 `isResigning`。
   *
   * 已离职 + 残留绑定的员工（`sync-workfine.js` 可造出的真实态）直调
   * `{ isResigned: true, storeId: B }`：角色删除分支照跑（判据是 `data.isResigned === true`），
   * 残留被本事务删光；若用 `isResigning`（多带 `!lockedRow.isResigned`）就会落进查询分支、
   * 查到刚被删空的集合、记成 `no_binding_at_old_store`（「旧店本来就没绑定」），语义相反。
   */
  it('已离职 + 再传 isResigned:true + 调店 → 记 roles_revoked_by_resignation（不是「本来没绑定」）', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValue([]),
      update: (db as any).update,
      select: (db as any).select,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
      insert: (db as any).insert,
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B', isResigned: true })

    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'roles_revoked_by_resignation' }),
      expect.anything(),
    )
    expect(logOperation).not.toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'no_binding_at_old_store' }),
      expect.anything(),
    )
  })

  /** 复职**不调店**同样需要提示 —— 判据挂在调店分支里就漏了一半 */
  it('复职但不调店 → 仍回传「需重新授权」提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A', isResigned: true }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { isResigned: false })

    expect(result.success).toBe(true)
    expect(result.message).toContain('离职时角色已全部撤销')
    // 没有调店 → §AFF-03 整块不进
    expect(findRolesBoundWithinSubtree).not.toHaveBeenCalled()
  })

  /** 在职员工的普通编辑不该被这条提示打扰 */
  it('在职员工普通调店 → 不出现复职提示', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept', isResigned: false }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: 'store-B', isResigned: false })

    expect(result.success).toBe(true)
    expect(result.message).not.toContain('离职时角色已全部撤销')
  })

  /**
   * 文案必须**中性**（codex 谱系第 5 轮 P2）：
   * 「旧店仍有绑定」≠「新店缺授权」—— 允许多绑定的口径下，员工在 A、B 都持 manager、
   * 主门店 A→B 时 B 店本来就有授权，照「按新门店重新授权」去补会撞唯一约束；
   * 旧店那条也完全可能是该保留的兼任。第 3 轮的 `A → null` 文案问题一并被这句涵盖
   * （中性文案里根本不提「新门店」）。
   */
  it('提示文案中性：不预设「必须按新门店重新授权」', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [{ role: 'manager' }],
    })
    mockUpdateOnce()

    const result = await updateEmployee('FY-001', { storeId: null, orgNodeId: 'market-1' })

    expect(result.success).toBe(true)
    expect(result.message).toContain('复核是保留兼任还是改绑')
    expect(result.message).toContain('manager')
    expect(result.message).not.toContain('重新授权')
    expect(result.message).not.toContain('按新门店')
  })

  /**
   * 结构守护：钉住「不再搬迁」这个决定本身。
   *
   * 行为用例只断言「db.update 被调 1 次」—— 那锁不住「有人把搬迁加回来但顺手改了 mock」。
   * 这条直接禁掉源码里对 permissionRoles 的 update。
   * ⚠️ 离职清角色走的是 `tx.delete(permissionRoles)`（两处，事务内），是另一条合法路径，不受影响。
   */
  it('employees.ts 中不存在对 permissionRoles 的 update（调店不得改角色范围）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/actions/employees.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
    expect(src, '调店不应再改写 permission_roles —— 口径见 #249')
      .not.toMatch(/\.update\(\s*permissionRoles\s*\)/)
    // 离职清角色仍在（确认守护没把合法路径一起禁掉）
    expect(src).toMatch(/\.delete\(permissionRoles\)/)
  })
})

describe('#259 归属自洽 —— 只禁 orgNodeId 指向「另一个门店」', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    applyScopeFixture()
    ;(isAdminScope as any).mockReturnValue(false)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  function mockUpdateOk2() {
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    })
  }

  /**
   * 生产上 2 条脏数据正是这个形态（王芳：门店=自贡富豪店 却挂「自贡双美店」节点）。
   * 它也是 issue 描述的危害「同一员工同时出现在两个门店名册」的**唯一真实成因** ——
   * `employeeScopeCondition` 是 store ∪ org 的 OR，挂另一个门店节点时那个门店就能看见他。
   */
  it('orgNodeId 指向另一个门店的节点 → 拒绝', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      storeAncestor: 'org-store-B',                 // 新 orgNodeId 归属于 store-B
      store: [[{ orgNodeId: 'org-store-OTHER' }]],  // 而 store-A 的 org_node 是另一个
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { orgNodeId: 'org-store-B' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选组织节点属于另一个门店，请改选本门店或其所属部门')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('orgNodeId 就是本门店的节点 → 放行', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      storeAncestor: 'org-store-B',
      store: [[{ orgNodeId: 'org-store-B' }]],      // 与该 orgNodeId 的门店祖先一致
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { orgNodeId: 'org-store-B' })

    expect(result.success).toBe(true)
  })

  /**
   * 13 个矩阵式归属（养生师挂养生部、数据主管挂财智部）必须放行 ——
   * 这是有意的组织安排：门店是工作地点、部门是专业归属。
   */
  it('orgNodeId 指向部门节点（养生部/财智部那类矩阵归属）→ 放行', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      // 不给 storeAncestor = 无门店祖先（挂市场下的部门）→ 与门店维度无关，放行
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOk2()

    // dept-A 在 fixture 的 scope 内 —— 本例要验的是「部门类型放行」，不是 scope 校验
    const result = await updateEmployee('FY-001', { orgNodeId: 'dept-A' })

    expect(result.success).toBe(true)
  })

  it('orgNodeId 指向市场节点 → 放行', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { orgNodeId: 'market-1' })

    expect(result.success).toBe(true)
  })

  /**
   * codex 谱系第 4 轮：早期版本先找门店祖先、找不到就放行，于是 `orgNodeId` 是合法市场节点时
   * `storeId` 的存在性**从来没被验过** —— 一路走到写库撞 FK `23503`，而 catch 只翻译 `23505`，
   * 用户看到 500。存在性校验现在与门店祖先无关，两端各自先验。
   */
  it('storeId 指向不存在的门店（orgNodeId 是市场节点，够不到门店祖先）→ 拒绝而非 500', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      store: [[]],          // 新门店查不到
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { storeId: 'store-B', orgNodeId: 'market-1' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选门店不存在')
    expect(db.update).not.toHaveBeenCalled()
    // 门店都不存在，不必再去问组织树
    expect(findNearestStoreAncestor).not.toHaveBeenCalled()
  })

  it('orgNodeId 指向不存在 / 已被删的节点 → 拒绝而非 500', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      storeAncestor: '__missing__',                 // findNearestStoreAncestor → { exists: false }
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { orgNodeId: 'dept-A' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选组织节点不存在，请刷新后重新选择')
    expect(db.update).not.toHaveBeenCalled()
  })

  /** storeId 为空、只改 orgNodeId 时，节点存在性同样要验（否则同样 500） */
  it('storeId 为空 + orgNodeId 不存在 → 仍拒绝', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      storeAncestor: '__missing__',
      store: [],
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { storeId: null, orgNodeId: 'dept-A' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选组织节点不存在，请刷新后重新选择')
    expect(db.update).not.toHaveBeenCalled()
  })

  /**
   * 校验与写库之间仍有并发删除窗口（另一个管理员此刻删了那个门店/节点）。
   * FK `23503` 必须翻译成人话，而不是抛出去变 500。
   */
  it('校验通过后并发删除 → UPDATE 撞 23503 → 友好文案', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    ;(db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(Object.assign(new Error('fk'), {
          code: '23503', constraint: 'staff_wechat_users_store_id_stores_store_id_fk',
        })),
      }),
    })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选门店或组织节点已被删除，请刷新后重试')
  })

  /**
   * storeId 为空时无从比对「另一个门店」，跳过。
   *
   * ⚠️ 原注释写「96 个仅组织节点的在职员工走这条」——**夸大了**：那 96 人里 95 人挂
   * 总部/部门（本来就无门店祖先，走的是下面那条），只有 1 人（王志军 FY-260731005，
   * `org_node_id` 直接指向门店节点）真正依赖这条放行，而那 1 条恰是脏数据。
   * 这个口径缺口已在 `assertOwnershipConsistent` 的注释里记录并提交 issue #259 待拍板。
   */
  it('storeId 为空 → 跳过归属自洽校验', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-A' }],
      // 刻意给「有门店祖先且不匹配」的配置 —— 只有 `!storeId` 早退能让本例通过
      storeAncestor: 'org-store-B',
      store: [[{ orgNodeId: 'org-store-OTHER' }]],
      bindings: [],
    })
    mockUpdateOk2()

    // 同时清空 storeId —— 没有 storeId 就没有「另一个门店」之说
    const result = await updateEmployee('FY-001', { storeId: null, orgNodeId: 'org-store-B' })

    expect(result.success).toBe(true)
  })

  /**
   * 存量的 15 条不匹配记录（13 合法 + 2 脏）不该因新校验变成「不可编辑」——
   * 校验只在归属**发生变更**时触发。
   */
  it('归属 no-op 回传（含存量不匹配记录）→ 不触发归属自洽校验', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-store-OTHER' }],  // 存量脏数据形态
      storeAncestor: 'org-store-OTHER',
      store: [[{ orgNodeId: 'org-store-A' }]],
      bindings: [],
    })
    mockUpdateOk2()

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalled()
  })

  it('createEmployee 侧同样拦住跨门店挂载（#228 教训：只修一侧等于没修）', async () => {
    mockSelectByTable({
      employee: [],
      storeAncestor: 'org-store-B',
      store: [[{ orgNodeId: 'org-store-OTHER' }]],
      bindings: [],
    })
    mockTransactionSuccess()

    const result = await createEmployee({
      name: '张三', phone: '13812345678', idCard: '110101199003078888',
      storeId: 'store-A', orgNodeId: 'org-store-B',
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('所选组织节点属于另一个门店，请改选本门店或其所属部门')
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('updateEmployee — §AFF-03 门店变更 scope 同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    // mockSession 是 admin 角色；显式短路 #228 的归属可见性校验，让这些用例专注各自目标
    ;(isAdminScope as any).mockReturnValue(true)
    ;(isInScope as any).mockReturnValue(true)
    ;(isOrgNodeInScope as any).mockReturnValue(true)
    ;(isEmployeeRowVisible as any).mockReturnValue(true)
    defaultAncestryMocks()
    mockTxPassthrough()
    resetSharedMocks()
  })

  it('storeId 变更 → 只写 skipped 审计，permission_roles 不动', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ id: 1, role: 'manager', scopeId: 'org-store-A' }],
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)   // #249：只改员工行，不动角色绑定
    expect(logOperation).toHaveBeenCalledTimes(1)   // 只有 skipped 那一条
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(logUpdate).toHaveBeenCalledTimes(1)
  })

  it('storeId 未变更（编辑其他字段）→ 不触发 scope 同步', async () => {
    // data 中不含 storeId → 不查旧值，不做 scope sync
    ;(db.select as any).mockImplementation(mockSelectExistingEmployee())
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { name: '李四' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1) // 仅员工更新
    expect(logOperation).not.toHaveBeenCalledWith(
      expect.anything(), 'permission.scopeSync', expect.anything(), expect.anything(), expect.anything(),
    )
  })

  it('storeId 设为相同值 → 不触发 scope 同步', async () => {
    // 旧 storeId 与新值相同 → 归属字段 no-op，既不触发自洽校验也不触发 §AFF-03
    mockSelectByTable({ employee: [{ storeId: 'store-A', orgNodeId: null }], store: [], bindings: [] })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { storeId: 'store-A' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1) // 仅员工更新
  })

  it('原无门店（oldStoreId=null）→ 不触发 scope 同步', async () => {
    mockSelectByTable({
      // 新入职未分配门店的员工
      employee: [{ storeId: null, orgNodeId: null }],
      store: [[{ orgNodeId: 'org-store-B' }]],   // 只有归属自洽那一次查询（没有旧门店可查）
      bindings: [],
    })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 旧门店为 null，不做 scope 同步
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(findRolesBoundWithinSubtree).not.toHaveBeenCalled()
  })

  /**
   * codex 谱系第 4 轮 P3：既有 §AFF-03 用例都不传手机号。这条把「改手机号 + 调店」这条
   * 合法路径整体锁住（含审计与回传提示）。
   */
  it('改手机号 + scope 内调店 → 员工更新与审计都发生，角色绑定不动', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [{ id: 1, role: 'manager', scopeId: 'org-store-A' }],
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { phone: '13900000005', storeId: 'store-B' })

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledTimes(1)   // #249：只改员工行，不动角色绑定
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'manual_review_required' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(logUpdate).toHaveBeenCalledTimes(1)
  })

  /**
   * #249 问题 3：原先只在 `count > 0` 时写日志，「旧店本来就没有绑定」与「被并发改掉了」
   * 都是静默的。现在无绑定可搬也留一条 `no_binding_at_old_store` 痕迹。
   */
  it('旧门店没有任何角色绑定 → 不动 permission_roles，但写一条 skipped 审计', async () => {
    mockSelectByTable({
      employee: [{ storeId: 'store-A', orgNodeId: 'org-dept' }],
      // [新店 store-B 的节点（归属自洽）, 旧店 store-A 的节点（§AFF-03 找绑定）]
      store: [[{ orgNodeId: 'org-store-B' }], [{ orgNodeId: 'org-store-A' }]],
      bindings: [],   // 旧店没有绑定
    })
    ;(db.update as any).mockImplementation(() => ({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
    }))

    const result = await updateEmployee('FY-001', { storeId: 'store-B' })

    expect(result.success).toBe(true)
    // 只有员工行那一次 UPDATE，permission_roles 不许被动
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'permission.scopeSync.skipped', 'permission_role', 'FY-001',
      expect.objectContaining({ reason: 'no_binding_at_old_store' }),
      expect.anything(),   // 第 6 参 = executor（事务句柄）
    )
    expect(logUpdate).toHaveBeenCalledTimes(1)
  })
})

// ── getEmployeesPaginated 服务端分页 ──────────────────────────────────────────

describe('getEmployeesPaginated — 服务端分页', () => {
  const mockEmployeeRow = {
    staff_wechat_users: {
      employeeId: 'FY-260315001',
      openid: null,
      phone: '13812345678',
      name: '张三',
      gender: '男',
      idCard: null,
      storeId: 'store-1',
      orgNodeId: 'dept-1',
      positionName: '美容师',
      birthday: null,
      skills: ['美容师'],
      isResigned: false,
      lastLoginAt: null,
      createdAt: new Date('2026-01-15T08:00:00Z'),
      updatedAt: new Date('2026-03-15T10:00:00Z'),
    },
    stores: { storeId: 'store-1', storeName: '南昌旗舰店' },
    org_nodes: { id: 'dept-1', name: '美容部' },
    store_node: { id: 'org-store-1', name: '南昌旗舰店节点' },
    market_node: { id: 'market-1', name: '南昌市场' },
  }

  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list', 'employee:create', 'employee:update'], scopeStoreIds: [] },
  }

  /** mock 2 个并行 select：COUNT + DATA */
  function mockPaginatedChain(total: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        const where = vi.fn().mockResolvedValue([{ count: total }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA: select → from → leftJoin × 4 → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
  })

  it('无筛选 → 返回 data + total', async () => {
    mockPaginatedChain(1, [mockEmployeeRow])

    const result = await getEmployeesPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].employeeId).toBe('FY-260315001')
    expect(result.data[0].name).toBe('张三')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].departmentName).toBe('美容部')
  })

  // admin.sys.spec.md §5 默认排序：最近编辑过的员工浮顶，employeeId 作分页 tiebreaker
  it('默认 orderBy 首键为 desc(updatedAt)，带 createdAt DESC + employeeId ASC', async () => {
    // 专门 mock 以捕获 DATA 查询的 orderBy 参数
    let dataOrderBy: any = null
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        const where = vi.fn().mockResolvedValue([{ count: 0 }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      const offset = vi.fn().mockResolvedValue([])
      const limit = vi.fn().mockReturnValue({ offset })
      dataOrderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy: dataOrderBy })
      const leftJoin4 = vi.fn().mockReturnValue({ where })
      const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    await getEmployeesPaginated()

    expect(dataOrderBy).toHaveBeenCalledTimes(1)
    const args = dataOrderBy.mock.calls[0]
    expect(args[0]).toMatchObject({ type: 'desc', col: 'updated_at' })
    expect(args[1]).toMatchObject({ type: 'desc', col: 'created_at' })
    expect(args[2]).toMatchObject({ type: 'asc', col: 'employee_id' })
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getEmployeesPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-2')
  })

  it('status=active → eq(isResigned, false)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ status: 'active' })

    expect(eq).toHaveBeenCalledWith('is_resigned', false)
  })

  it('status=resigned → eq(isResigned, true)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ status: 'resigned' })

    expect(eq).toHaveBeenCalledWith('is_resigned', true)
  })

  it('search 筛选 → ilike(name, employeeId, phone)', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ search: '张' })

    expect(ilike).toHaveBeenCalledWith('name', '%张%')
    expect(ilike).toHaveBeenCalledWith('employee_id', '%张%')
    expect(ilike).toHaveBeenCalledWith('phone', '%张%')
  })

  it('page/pageSize → 2 次 select', async () => {
    mockPaginatedChain(100, [])

    const result = await getEmployeesPaginated({ page: 5, pageSize: 10 })

    expect(result.total).toBe(100)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('stores/org_nodes JOIN 为 null → undefined', async () => {
    const noJoins = {
      ...mockEmployeeRow,
      stores: null,
      org_nodes: null,
      store_node: null,
      market_node: null,
    }
    mockPaginatedChain(1, [noJoins])

    const result = await getEmployeesPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].departmentName).toBeUndefined()
  })

  it('marketName 从 market_node JOIN 映射', async () => {
    mockPaginatedChain(1, [mockEmployeeRow])

    const result = await getEmployeesPaginated()

    expect(result.data[0].marketName).toBe('南昌市场')
  })

  it('market_node null → marketName undefined', async () => {
    const noMarket = {
      ...mockEmployeeRow,
      market_node: null,
    }
    mockPaginatedChain(1, [noMarket])

    const result = await getEmployeesPaginated()

    expect(result.data[0].marketName).toBeUndefined()
  })

  it('组织筛选覆盖节点自身及任意层级下属员工和门店', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ marketId: 'market-1' })

    expect(db.select).toHaveBeenCalledTimes(2)
    const recursiveSql = (sql as any).mock.calls
      .map((call: any[]) => Array.from(call[0] as TemplateStringsArray).join(''))
      .find((text: string) => text.includes('WITH RECURSIVE descendants'))
    expect(recursiveSql).toContain('child.parent_id = descendants.id')
    expect(recursiveSql).toContain('NOT child.id = ANY(descendants.path)')
  })

  it('skills 筛选（单标签） → sql.join + && ARRAY 模板被调用，标签作为参数化占位传入', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: ['美容师'] })

    // sql.join([sql`美容师`], sql.raw(', ')) 把单标签包成 1 元素数组
    expect((sql as any).join).toHaveBeenCalledWith(
      [{ type: 'sql', args: [expect.anything(), '美容师'] }],
      { type: 'sql.raw', value: ', ' },
    )
    // 外层模板: skills && ARRAY[...]::text[] 被 sql 模板函数调用
    const overlapCalls = (sql as any).mock.results.filter(
      (r: any) => Array.isArray(r.value?.args) && r.value.args.some(
        (a: any) => typeof a === 'object' && a?.type === 'sql.join',
      ),
    )
    expect(overlapCalls.length).toBeGreaterThan(0)
  })

  it('skills 筛选（多标签 OR） → 每个标签作为独立参数化占位传入 sql.join', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: ['美容师', '养生师'] })

    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '美容师'] },
        { type: 'sql', args: [expect.anything(), '养生师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills: [] 空数组 → 不调用 sql.join（短路）', async () => {
    mockPaginatedChain(0, [])

    await getEmployeesPaginated({ skills: [] })

    expect((sql as any).join).not.toHaveBeenCalled()
  })
})

// ── getOrgLevel2ForFilter ──────────────────────────────────────────────────────

describe('getOrgLevel2ForFilter', () => {
  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
  })

  it('返回 headquarters 子节点（市场 + 总部部门）', async () => {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 查询 headquarters: select → from → where → limit
        const limit = vi.fn().mockResolvedValue([{ id: 'hq-1' }])
        const where = vi.fn().mockReturnValue({ limit })
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // 查询子节点: select → from → where → orderBy
      const orderBy = vi.fn().mockResolvedValue([
        { id: 'market-1', name: '南昌市场', type: '市场' },
        { id: 'market-2', name: '九江市场', type: '市场' },
        { id: 'dept-1', name: '人事部', type: '部门' },
      ])
      const where = vi.fn().mockReturnValue({ orderBy })
      const from = vi.fn().mockReturnValue({ where })
      return { from }
    })

    const result = await getOrgLevel2ForFilter()

    expect(result).toEqual([
      { id: 'market-1', name: '南昌市场', type: '市场' },
      { id: 'market-2', name: '九江市场', type: '市场' },
      { id: 'dept-1', name: '人事部', type: '部门' },
    ])
  })

  it('无 headquarters 节点 → 返回空数组', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getOrgLevel2ForFilter()

    expect(result).toEqual([])
  })
})

// 2026-05-18 picker LIMIT 截断回归：getEmployees() 是开单/服务单/客户分配 picker
// 共用数据源；曾经写死 .limit(500)，全库 2000+ 员工时按 name 排序后某店员工被截断，
// 导致 admin /orders/create 选南昌万科店时下拉只显示 2 人（其余 14 人因 name 落在 500
// 行之后被截）。这里断言链路不再调 limit，且 select 链路顺序为 from → leftJoin × 4 →
// where → orderBy。
describe('getEmployees — picker 数据源不得有 LIMIT', () => {
  const pickerSession = {
    employeeId: 'ADMIN-001',
    name: 'admin',
    phone: '',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(pickerSession)
  })

  it('链路止于 orderBy（不再链式 .limit），并返回全量行', async () => {
    const allRows = Array.from({ length: 1234 }, (_, i) => ({
      staff_wechat_users: {
        employeeId: `FY-${String(i).padStart(6, '0')}`,
        openid: null,
        phone: null,
        name: `员工${i}`,
        gender: null,
        idCard: null,
        storeId: i % 2 === 0 ? 'store-A' : 'store-B',
        orgNodeId: null,
        positionName: '美容师',
        avatarUrl: null,
        birthday: null,
        skills: ['美容师'],
        isResigned: false,
        hiredAt: null,
        resignedAt: null,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      stores: { storeName: i % 2 === 0 ? '南昌万科店' : '南昌天虹店' },
      org_nodes: null,
    }))

    // orderBy 直接 resolve 全量数据；如果代码意外再调 .limit 会得到 undefined.limit
    // → TypeError，测试失败。
    const orderBy = vi.fn().mockResolvedValue(allRows)
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin4 = vi.fn().mockReturnValue({ where })
    const leftJoin3 = vi.fn().mockReturnValue({ leftJoin: leftJoin4 })
    const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getEmployees()

    expect(result).toHaveLength(1234)
    expect(orderBy).toHaveBeenCalledTimes(1)
    // 防止有人未来再加回 .limit() —— orderBy 返回的 promise 上不应有 .limit 被调
    expect((orderBy.mock.results[0]?.value as any).limit).toBeUndefined()
  })
})

describe('getAllocationEmployeeCandidates — 分配专用最小候选', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isInScope as any).mockReturnValue(true)
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['allocation:list'], scopeStoreIds: ['store-A'] },
    })
  })

  it('返回三级范围字段且不暴露手机号、身份证等档案字段', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        employee_id: 'EMP-CROSS',
        name: '跨市场老师',
        store_id: null,
        position_name: '品项老师',
        skills: ['品项老师'],
        is_on_business_trip: true,
        store_name: null,
        department_name: '品项部',
        market_name: null,
        assignment_scope: 'cross_market_trip',
      },
    ])

    const result = await getAllocationEmployeeCandidates('store-A')

    expect(result).toEqual([expect.objectContaining({
      employeeId: 'EMP-CROSS',
      assignmentScope: 'cross_market_trip',
      skills: ['品项老师'],
    })])
    expect(result[0]).not.toHaveProperty('phone')
    expect(result[0]).not.toHaveProperty('idCard')
    expect(isInScope).toHaveBeenCalledWith(expect.anything(), 'store-A')
  })
})

describe('getServiceStaffCandidates — 服务单专用候选（issue #210）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isInScope as any).mockReturnValue(true)
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['service:create'], scopeStoreIds: ['store-A'] },
    })
  })

  it('返回本店与同市场出差人员，且不暴露手机号、身份证等档案字段', async () => {
    ;(db.execute as any).mockResolvedValue([
      {
        employee_id: 'EMP-LOCAL',
        name: '本店美容师',
        store_id: 'store-A',
        position_name: '美容师',
        skills: ['美容师'],
        is_on_business_trip: false,
        store_name: 'A 店',
        department_name: '美容部',
        market_name: '南昌凤御',
        assignment_scope: 'local',
      },
      {
        employee_id: 'EMP-TRIP',
        name: '市场养生师',
        store_id: null,
        position_name: '养生师',
        skills: ['养生师'],
        is_on_business_trip: true,
        store_name: null,
        department_name: '养生部',
        market_name: '南昌凤御',
        assignment_scope: 'same_market_trip',
      },
    ])

    const result = await getServiceStaffCandidates('store-A')

    expect(result.map((r) => [r.employeeId, r.assignmentScope])).toEqual([
      ['EMP-LOCAL', 'local'],
      ['EMP-TRIP', 'same_market_trip'],
    ])
    // store_id 为空的直挂节点员工照样带出锚定市场（旧的客户端过滤做不到）
    expect(result[1]).toMatchObject({ storeId: null, marketName: '南昌凤御' })
    expect(result[0]).not.toHaveProperty('phone')
    expect(result[0]).not.toHaveProperty('idCard')
    expect(isInScope).toHaveBeenCalledWith(expect.anything(), 'store-A')
  })

  it('门店不在 scope 内直接拒绝，不查库', async () => {
    ;(isInScope as any).mockReturnValue(false)

    await expect(getServiceStaffCandidates('store-X')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('缺少 targetStoreId 直接拒绝', async () => {
    await expect(getServiceStaffCandidates('')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('技能白名单四项按固定顺序传入查询（顺序即排序优先级）', async () => {
    ;(db.execute as any).mockResolvedValue([])

    await getServiceStaffCandidates('store-A')

    expect(sql.param).toHaveBeenCalledWith(['店经理', '美容师', '养生师', '品项老师'])
  })
})

// ── exportEmployees — 导出 + 技能标签服务端兜底 ──────────────────────────────────

describe('exportEmployees — 导出 + 技能标签服务端兜底（对称列表 page.tsx）', () => {
  const listSession = {
    ...mockSession,
    permissions: { actions: ['employee:list'], scopeStoreIds: [] },
  }

  /**
   * mock 单次 db.select → exportEmployees 员工数据查询链路：
   * select → from → leftJoin → where → orderBy
   */
  function mockExportChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {})
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
    ;(getSkillTags as any).mockResolvedValue([
      { id: 'tag-1', name: '护理' },
      { id: 'tag-2', name: '美容师' },
    ])
  })

  it('无 skills 筛选 → 返回 rows + truncated=false，getSkillTags 被调一次（防御层始终启用）', async () => {
    mockExportChain([])

    const result = await exportEmployees({})

    expect(result.rows).toEqual([])
    expect(result.truncated).toBe(false)
    // 不传 skill 也会跑服务端兜底（与列表对称），保证逻辑不漂移
    expect(getSkillTags).toHaveBeenCalledTimes(1)
    expect((sql as any).join).not.toHaveBeenCalled()
  })

  it('skills 全字典内 → 原样传入 buildEmployeeConditions（sql.join 含全部标签）', async () => {
    mockExportChain([])

    await exportEmployees({ skill: '护理,美容师' })

    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '护理'] },
        { type: 'sql', args: [expect.anything(), '美容师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills 含字典外标签 → 服务端兜底剔除（防幽灵筛选，对称列表 page.tsx）', async () => {
    mockExportChain([])

    // URL 残留字典外的"旧标签"（已删除，前端 handleExport 漏清洗场景）
    await exportEmployees({ skill: '护理,旧标签,美容师' })

    // sql.join 仅含字典内标签（护理、美容师），字典外"旧标签"被剔除
    expect((sql as any).join).toHaveBeenCalledWith(
      [
        { type: 'sql', args: [expect.anything(), '护理'] },
        { type: 'sql', args: [expect.anything(), '美容师'] },
      ],
      { type: 'sql.raw', value: ', ' },
    )
  })

  it('skills 全字典外 → sql.join 不被调用（清洗后为 undefined → no-op，列表不被静默收窄）', async () => {
    mockExportChain([])

    await exportEmployees({ skill: '旧标签' })

    // 全字典外 → filterValidSkillValues 返回 undefined → buildEmployeeConditions 跳过 skills 条件
    expect((sql as any).join).not.toHaveBeenCalled()
  })

  it('字段映射：hiredAt 原样透传（date 列，格式化在 registry 列 map），未填入职日期为 null', async () => {
    // prod 实测 338 名员工里 248 个不同入职日、仅 3 个为空、28 个等于建档日兜底值 —— 即
    // hired_at 是真实维护过的数据。空值是少数情形但必须留空，不能补今天或建档日充数。
    mockExportChain([
      {
        staff_wechat_users: {
          employeeId: 'FY-00001', name: '张美容', gender: '女', phone: '13800000001',
          idCard: '360102199001011234', orgNodeId: 'node-1', positionName: '美容师',
          hiredAt: '2024-03-01', birthday: '1990-01-01', skills: ['护理'],
          socialInsurance: true, isResigned: false, resignationReason: null,
        },
        stores: { storeName: '南昌店' },
      },
      {
        staff_wechat_users: {
          employeeId: 'FY-00002', name: '李未填', gender: null, phone: null,
          idCard: null, orgNodeId: null, positionName: null,
          hiredAt: null, birthday: null, skills: null,
          socialInsurance: false, isResigned: false, resignationReason: null,
        },
        stores: null,
      },
    ])

    const { rows } = await exportEmployees({})

    expect(rows[0]).toMatchObject({
      employeeId: 'FY-00001', name: '张美容', storeName: '南昌店',
      positionName: '美容师', hiredAt: '2024-03-01', birthday: '1990-01-01',
    })
    expect(rows[1].hiredAt).toBeNull()
  })

  it('keyset 分页：按 employee_id 升序 + 游标 gt，不再用可变的 updated_at 排序（否则漏行/重行）', async () => {
    const mkRow = (id: string) => ({
      staff_wechat_users: {
        employeeId: id, name: `员工${id}`, gender: null, phone: null, idCard: null,
        orgNodeId: null, positionName: null, hiredAt: null, birthday: null, skills: null,
        socialInsurance: false, isResigned: false, resignationReason: null,
      },
      stores: null,
    })
    const fetched = [mkRow('FY-00001'), mkRow('FY-00002'), mkRow('FY-00003')]
    const chain: any = Object.assign(Promise.resolve(fetched), {})
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(fetched)
    ;(db.select as any).mockReturnValue(chain)

    const result = await exportEmployees({}, { limit: 2, cursor: 'FY-00000' })

    expect(chain.limit).toHaveBeenCalledWith(3) // limit + 1 探测行
    expect(result.rows).toHaveLength(2)
    expect(result.hasMore).toBe(true)
    // 游标是本页最后一行的员工编号，不是被切掉的探测行
    expect(result.nextCursor).toBe('FY-00002')
    // 不能只断言 gt 被调用过：算了条件却忘了拼进 whereClause 时，固定返回数据的 mock 照样会绿
    expect(gt).toHaveBeenCalledWith('employee_id', 'FY-00000')
    expect(chain.where).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'and',
        args: expect.arrayContaining([{ type: 'gt', col: 'employee_id', val: 'FY-00000' }]),
      }),
    )
    // 排序键只能是 employee_id：updated_at 会被员工每次小程序登录写新值，
    // 行在页间移位就会造成一行重复 + 一行永久漏掉
    expect(chain.orderBy).toHaveBeenCalledWith({ type: 'asc', col: 'employee_id' })
    expect(chain.orderBy).toHaveBeenCalledTimes(1)
  })

  it('keyset 游标是空串/非字符串 → 抛 INVALID_STATE，且在打库之前就拦住', async () => {
    mockExportChain([])

    await expect(exportEmployees({}, { limit: 2, cursor: '' as any })).rejects.toThrow('导出分页游标无效')
    await expect(exportEmployees({}, { limit: 2, cursor: 123 as any })).rejects.toThrow('导出分页游标无效')
    // 畸形游标不该先白打一次 getSkillTags 的库
    expect(getSkillTags).not.toHaveBeenCalled()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('超过旧上限也返回全量且不标记截断', async () => {
    const overflow = Array.from({ length: 10001 }, (_, i) => ({
      staff_wechat_users: {
        employeeId: `FY-${String(i).padStart(5, '0')}`,
        name: `员工${i}`,
        gender: null,
        phone: null,
        idCard: null,
        orgNodeId: null,
        skills: null,
        positionName: null,
        birthday: null,
        socialInsurance: false,
        isResigned: false,
        resignationReason: null,
      },
      stores: null,
    }))
    mockExportChain(overflow)

    const result = await exportEmployees({})

    expect(result.truncated).toBe(false)
    expect(result.rows).toHaveLength(10001)
  })
})
