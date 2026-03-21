'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { eq, and, or, sql, ilike, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import type { Employee } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isInScope } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

const storeNode = alias(orgNodes, 'store_node')
const marketNode = alias(orgNodes, 'market_node')

function rowToEmployee(row: {
  staff_wechat_users: typeof staffWechatUsers.$inferSelect
  stores: typeof stores.$inferSelect | null
  org_nodes: typeof orgNodes.$inferSelect | null
}): Employee {
  const e = row.staff_wechat_users
  return {
    employeeId: e.employeeId,
    openid: e.openid,
    phone: e.phone,
    name: e.name,
    gender: e.gender,
    idCard: e.idCard,
    storeId: e.storeId,
    orgNodeId: e.orgNodeId,
    positionName: e.positionName,
    birthday: e.birthday,
    skills: e.skills,
    isResigned: e.isResigned,
    lastLoginAt: e.lastLoginAt?.toISOString() ?? null,
    createdAt: e.createdAt?.toISOString() ?? '',
    updatedAt: e.updatedAt?.toISOString() ?? '',
    storeName: row.stores?.storeName ?? undefined,
    departmentName: row.org_nodes?.name ?? undefined,
  }
}

export async function getEmployees(): Promise<Employee[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(scopeCondition(session, staffWechatUsers.storeId))
    .orderBy(staffWechatUsers.name)
    .limit(500)

  return rows.map(rowToEmployee)
}

/** 员工列表筛选参数 */
export interface EmployeeFilters {
  marketId?: string
  storeId?: string
  status?: 'active' | 'resigned'
  search?: string
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedEmployees {
  data: Employee[]
  total: number
}

/**
 * 服务端分页员工列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * status 映射：active → is_resigned = false, resigned → is_resigned = true
 * 搜索支持：姓名、员工编号、手机号（ILIKE）
 */
export async function getEmployeesPaginated(filters: EmployeeFilters = {}): Promise<PaginatedEmployees> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, staffWechatUsers.storeId),
  ]

  if (filters.marketId) {
    // 查询节点类型以决定过滤策略
    const [node] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, filters.marketId))
      .limit(1)
    if (node?.type === 'market') {
      // 市场：筛选该市场下所有门店的员工
      const sub = db.select({ storeId: stores.storeId }).from(stores)
        .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
        .where(eq(storeNode.parentId, filters.marketId))
      conditions.push(inArray(staffWechatUsers.storeId, sub))
    } else if (node?.type === 'department') {
      // 总部部门：筛选 orgNodeId 为该部门的员工
      conditions.push(eq(staffWechatUsers.orgNodeId, filters.marketId))
    } else if (node?.type === 'store') {
      // 门店：按 orgNodeId 查对应 storeId 过滤
      const [storeRow] = await db.select({ storeId: stores.storeId }).from(stores)
        .where(eq(stores.orgNodeId, filters.marketId)).limit(1)
      if (storeRow) {
        conditions.push(eq(staffWechatUsers.storeId, storeRow.storeId))
      }
    }
    // headquarters：不添加条件，显示全部
  }
  if (filters.storeId) {
    conditions.push(eq(staffWechatUsers.storeId, filters.storeId))
  }
  if (filters.status === 'active') {
    conditions.push(eq(staffWechatUsers.isResigned, false))
  } else if (filters.status === 'resigned') {
    conditions.push(eq(staffWechatUsers.isResigned, true))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(staffWechatUsers.name, pattern),
        ilike(staffWechatUsers.employeeId, pattern),
        ilike(staffWechatUsers.phone, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  const [[countRow], rows] = await Promise.all([
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(staffWechatUsers)
      .where(whereClause),
    db.select()
      .from(staffWechatUsers)
      .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
      .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
      .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
      .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
      .where(whereClause)
      .orderBy(staffWechatUsers.name)
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map(row => ({
      ...rowToEmployee(row),
      marketName: (row as any).market_node?.name ?? undefined,
    })),
    total: countRow?.count ?? 0,
  }
}

export async function getEmployeeById(employeeId: string): Promise<Employee | null> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(and(eq(staffWechatUsers.employeeId, employeeId), scopeCondition(session, staffWechatUsers.storeId)))

  if (rows.length === 0) return null
  return rowToEmployee(rows[0])
}

/** 获取组织架构第 2 级节点（市场 + 总部部门，用于筛选下拉） */
export async function getOrgLevel2ForFilter(): Promise<{ id: string; name: string; type: string }[]> {
  const session = await getSession()
  requirePermission(session, 'employee:list')

  const [hq] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.type, 'headquarters'))
    .limit(1)
  if (!hq) return []

  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, hq.id))
    .orderBy(orgNodes.sortOrder)

  return rows.map(r => ({ id: r.id, name: r.name ?? '', type: r.type }))
}


export async function createEmployee(data: {
  phone: string
  name: string
  gender?: string | null
  idCard?: string | null
  storeId?: string | null
  orgNodeId?: string | null
  positionName?: string | null
  birthday?: string | null
  skills?: string[] | null
}): Promise<{ success: boolean; message: string; employeeId?: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:create')

  // 服务端输入校验（手机号格式 + 必填字段）
  if (!data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  if (!data.phone?.trim()) {
    return { success: false, message: '请输入手机号' }
  }
  if (!/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }
  if (data.idCard && !/^\d{17}[\dXx]$/.test(data.idCard)) {
    return { success: false, message: '身份证号格式不正确' }
  }

  // 校验 storeId 在 scope 内（HR 角色受 scope 限制）— 在 DB 查询前快速失败
  if (data.storeId && !isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建员工' }
  }

  // 校验手机号唯一性（事务外，快速短路）
  if (data.phone) {
    const [existing] = await db
      .select({ employeeId: staffWechatUsers.employeeId })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.phone, data.phone))
      .limit(1)
    if (existing) {
      return { success: false, message: '该手机号已被其他员工使用' }
    }
  }

  // 事务：ID 生成（advisory lock）+ 插入，原子提交防并发重复
  let employeeId: string
  try {
    employeeId = await db.transaction(async (tx) => {
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('employee_id_gen'))
        )
        SELECT 'FY-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(employee_id FROM '.{3}$'), '') AS INTEGER)
            ), 0) + 1
            FROM staff_wechat_users
            WHERE employee_id LIKE 'FY-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 3, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as any[])[0]?.id as string
      if (!id) throw new Error('员工编号生成失败')

      await tx.insert(staffWechatUsers).values({
        employeeId: id,
        phone: data.phone,
        name: data.name,
        gender: data.gender ?? null,
        idCard: data.idCard ?? null,
        storeId: data.storeId ?? null,
        orgNodeId: data.orgNodeId ?? null,
        positionName: data.positionName ?? null,
        birthday: data.birthday ?? null,
        skills: data.skills ?? null,
        isResigned: false,
      })

      return id
    })
  } catch (err: any) {
    // PG 唯一约束冲突（手机号或员工编号并发重复）
    if (err?.code === '23505') {
      if (err.detail?.includes('phone') || err.constraint?.includes('phone')) {
        return { success: false, message: '该手机号已被其他员工使用' }
      }
      return { success: false, message: '数据冲突，请稍后重试' }
    }
    throw err
  }

  await logOperation(session, 'employee.create', 'employee', employeeId, { name: data.name })
  revalidatePath('/employees')
  return { success: true, message: '员工创建成功', employeeId }
}

export async function updateEmployee(
  employeeId: string,
  data: Partial<{
    phone: string | null
    name: string | null
    gender: string | null
    idCard: string | null
    storeId: string | null
    orgNodeId: string | null
    positionName: string | null
    birthday: string | null
    skills: string[] | null
    isResigned: boolean
  }>,
  /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  // 服务端输入校验
  if (data.phone !== undefined && data.phone !== null && !/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }
  if (data.idCard !== undefined && data.idCard !== null && !/^\d{17}[\dXx]$/.test(data.idCard)) {
    return { success: false, message: '身份证号格式不正确' }
  }

  // 校验手机号唯一性（如果更新了手机号）
  if (data.phone) {
    const [existing] = await db
      .select({ employeeId: staffWechatUsers.employeeId })
      .from(staffWechatUsers)
      .where(and(eq(staffWechatUsers.phone, data.phone), sql`${staffWechatUsers.employeeId} != ${employeeId}`))
      .limit(1)
    if (existing) {
      return { success: false, message: '该手机号已被其他员工使用' }
    }
  }

  // 如果 storeId 变更，先获取旧值以便后续同步 permission_roles scope（§AFF-03）
  let oldStoreId: string | null = null
  if (data.storeId !== undefined) {
    const [current] = await db
      .select({ storeId: staffWechatUsers.storeId })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, employeeId))
      .limit(1)
    oldStoreId = current?.storeId ?? null
  }

  // 乐观锁 + scope 隔离：WHERE employee_id = $1 [AND updated_at = $2] [AND scope]
  const scopeCond = scopeCondition(session, staffWechatUsers.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(staffWechatUsers.employeeId, employeeId),
        sql`date_trunc('milliseconds', ${staffWechatUsers.updatedAt}) = ${expectedUpdatedAt}`,
        scopeCond,
      )
    : and(eq(staffWechatUsers.employeeId, employeeId), scopeCond)

  let result: any
  try {
    result = await db.update(staffWechatUsers).set(data).where(whereConditions)
  } catch (err: any) {
    if (err?.code === '23505') {
      if (err.detail?.includes('phone') || err.constraint?.includes('phone')) {
        return { success: false, message: '该手机号已被其他员工使用' }
      }
      return { success: false, message: '数据冲突，请稍后重试' }
    }
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '员工不存在或无权修改',
    }
  }

  // 标记离职时同步作废所有有效的 permission_roles
  if (data.isResigned === true) {
    await db
      .update(permissionRoles)
      .set({ isVoid: true, voidedAt: new Date(), updatedBy: session.employeeId })
      .where(and(
        eq(permissionRoles.employeeId, employeeId),
        eq(permissionRoles.isVoid, false),
      ))
  }

  // §AFF-03：门店变更时同步更新 permission_roles scope
  // 仅更新 store 级别的 scope（旧门店 org_node → 新门店 org_node），不影响 market/headquarters 级 scope
  if (data.storeId && oldStoreId && data.storeId !== oldStoreId) {
    const [oldStore] = await db
      .select({ orgNodeId: stores.orgNodeId })
      .from(stores)
      .where(eq(stores.storeId, oldStoreId))
      .limit(1)
    const [newStore] = await db
      .select({ orgNodeId: stores.orgNodeId })
      .from(stores)
      .where(eq(stores.storeId, data.storeId))
      .limit(1)

    if (oldStore?.orgNodeId && newStore?.orgNodeId) {
      const scopeResult = await db
        .update(permissionRoles)
        .set({ scopeId: newStore.orgNodeId, updatedBy: session.employeeId })
        .where(and(
          eq(permissionRoles.employeeId, employeeId),
          eq(permissionRoles.scopeId, oldStore.orgNodeId),
          eq(permissionRoles.isVoid, false),
        ))

      if ((scopeResult as any).count > 0) {
        await logOperation(session, 'permission.scopeSync', 'permission_role', employeeId, {
          oldStoreId, newStoreId: data.storeId,
          oldScopeId: oldStore.orgNodeId, newScopeId: newStore.orgNodeId,
        })
      }
    }
  }

  await logOperation(session, 'employee.update', 'employee', employeeId, data)
  revalidatePath('/employees')
  revalidatePath('/permissions')
  return { success: true, message: '员工信息已更新' }
}
