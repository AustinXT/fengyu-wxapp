'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { adminPasswords } from '@db/admin-auth'
import { eq, and, or, sql, ilike, inArray, desc, asc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import type { Employee } from '@/lib/types'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode, pgErrorConstraint, pgErrorDetail } from '@/lib/pg-error'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { shanghaiToday } from '@/lib/datetime'
import { parseEmployeeFilters } from '@/lib/list-filters'


const storeNode = alias(orgNodes, 'store_node') as unknown as typeof orgNodes
const marketNode = alias(orgNodes, 'market_node') as unknown as typeof orgNodes



// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEmployee(row: any): Employee {
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
    avatarUrl: e.avatarUrl,
    birthday: e.birthday,
    skills: e.skills,
    socialInsurance: e.socialInsurance,
    isResigned: e.isResigned,
    hiredAt: e.hiredAt,
    
    leaveStart: e.leaveStart ?? null,
    leaveEnd: e.leaveEnd ?? null,
    isOnBusinessTrip: e.isOnBusinessTrip,
    resignedAt: e.resignedAt,
    resignationReason: e.resignationReason,
    lastLoginAt: e.lastLoginAt?.toISOString() ?? null,
    createdAt: e.createdAt?.toISOString() ?? '',
    updatedAt: e.updatedAt?.toISOString() ?? '',
    storeName: row.stores?.storeName ?? undefined,
    departmentName: row.org_nodes?.name ?? undefined,
  }
}


export const getEmployees = withPermission(
  'employee:list',
  async (session): Promise<Employee[]> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(scopeCondition(session, staffWechatUsers.storeId))
    
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)


export const getItemTeachers = withPermission(
  'employee:list',
  async (): Promise<Employee[]> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(and(
      eq(staffWechatUsers.isResigned, false),
      sql`'品项老师' = ANY(${staffWechatUsers.skills})`,
    ))
    
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)


export const getEmployeesOnBusinessTrip = withPermission(
  'employee:list',
  async (): Promise<Employee[]> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(and(
      eq(staffWechatUsers.isResigned, false),
      eq(staffWechatUsers.isOnBusinessTrip, true),
    ))
    
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)


export const searchEmployees = withPermission(
  'customer:update',
  async (
    _session,
    keyword: string,
  ): Promise<{ employeeId: string; name: string | null; phone: string | null }[]> => {
  const trimmed = keyword.trim()
  if (!trimmed) return []

  const pattern = `%${trimmed}%`
  const rows = await db
    .select({
      employeeId: staffWechatUsers.employeeId,
      name: staffWechatUsers.name,
      phone: staffWechatUsers.phone,
    })
    .from(staffWechatUsers)
    .where(
      and(
        eq(staffWechatUsers.isResigned, false),
        or(
          ilike(staffWechatUsers.name, pattern),
          ilike(staffWechatUsers.phone, pattern),
        ),
      ),
    )
    
    .orderBy(asc(staffWechatUsers.name))
    .limit(20)

  return rows
  },
)


export interface EmployeeFilters {
  marketId?: string
  storeId?: string
  status?: 'active' | 'resigned'
  search?: string
  page?: number
  pageSize?: number
}


export interface PaginatedEmployees {
  data: Employee[]
  total: number
}


async function buildEmployeeConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: EmployeeFilters,
): Promise<(SQL | undefined)[]> {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, staffWechatUsers.storeId),
  ]

  if (filters.marketId) {
    
    const [node] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, filters.marketId))
      .limit(1)
    if (node?.type === '市场') {
      
      const sub = db.select({ storeId: stores.storeId }).from(stores)
        .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
        .where(eq(storeNode.parentId, filters.marketId))
      conditions.push(inArray(staffWechatUsers.storeId, sub))
    } else if (node?.type === '部门') {
      
      conditions.push(eq(staffWechatUsers.orgNodeId, filters.marketId))
    } else if (node?.type === '门店') {
      
      const [storeRow] = await db.select({ storeId: stores.storeId }).from(stores)
        .where(eq(stores.orgNodeId, filters.marketId)).limit(1)
      if (storeRow) {
        conditions.push(eq(staffWechatUsers.storeId, storeRow.storeId))
      }
    }
    
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

  return conditions
}


export const getEmployeesPaginated = withPermission(
  'employee:list',
  async (session, filters: EmployeeFilters = {}): Promise<PaginatedEmployees> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  const whereClause = and(...(await buildEmployeeConditions(session, filters)))

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
      
      .orderBy(desc(staffWechatUsers.updatedAt), desc(staffWechatUsers.createdAt), asc(staffWechatUsers.employeeId))
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
  },
)


export interface ExportEmployeeRow {
  employeeId: string
  name: string | null
  gender: string | null
  phone: string | null
  idCard: string | null
  orgNodeId: string | null
  storeName: string | null
  positionName: string | null
  birthday: string | null
  skills: string | null
  socialInsurance: boolean
  isResigned: boolean
  resignationReason: string | null
}


export const exportEmployees = withPermission(
  'employee:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportEmployeeRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const filters = parseEmployeeFilters(params)
    const whereClause = and(...(await buildEmployeeConditions(session, filters)))

    const dataRows = await db
      .select()
      .from(staffWechatUsers)
      
      
      .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
      .where(whereClause)
      .orderBy(desc(staffWechatUsers.updatedAt), desc(staffWechatUsers.createdAt), asc(staffWechatUsers.employeeId))
      .limit(LIMIT + 1)

    const truncated = dataRows.length > LIMIT
    const page = truncated ? dataRows.slice(0, LIMIT) : dataRows

    const rows: ExportEmployeeRow[] = page.map((row) => {
      const e = row.staff_wechat_users
      return {
        employeeId: e.employeeId,
        name: e.name,
        gender: e.gender,
        phone: e.phone,
        idCard: e.idCard,
        orgNodeId: e.orgNodeId,
        storeName: row.stores?.storeName ?? null,
        positionName: e.positionName,
        birthday: e.birthday,
        skills: e.skills?.join('、') ?? null,
        socialInsurance: e.socialInsurance,
        isResigned: e.isResigned,
        resignationReason: e.resignationReason,
      }
    })

    return { rows, truncated }
  },
)

export const getEmployeeById = withPermission(
  'employee:list',
  async (session, employeeId: string): Promise<Employee | null> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(and(eq(staffWechatUsers.employeeId, employeeId), scopeCondition(session, staffWechatUsers.storeId)))

  if (rows.length === 0) return null
  return rowToEmployee(rows[0])
  },
)


export const getOrgLevel2ForFilter = withPermission(
  'employee:list',
  async (): Promise<{ id: string; name: string; type: string }[]> => {
  const [hq] = await db
    .select({ id: orgNodes.id })
    .from(orgNodes)
    .where(eq(orgNodes.type, '总部'))
    .limit(1)
  if (!hq) return []

  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.parentId, hq.id))
    
    .orderBy(asc(orgNodes.sortOrder))

  return rows.map(r => ({ id: r.id, name: r.name ?? '', type: r.type }))
  },
)


export const createEmployee = withPermission(
  'employee:create',
  async (
    session,
    data: {
      phone: string
      name: string
      gender?: string | null
      idCard?: string | null
      storeId?: string | null
      orgNodeId?: string | null
      positionName?: string | null
      birthday?: string | null
      skills?: string[] | null
      
      avatarUrl?: string | null
      
      hiredAt?: string | null
      
      socialInsurance?: boolean
    },
  ): Promise<{ success: boolean; message: string; employeeId?: string }> => {
  
  if (!data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  if (!data.phone?.trim()) {
    return { success: false, message: '请输入手机号' }
  }
  if (!/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }
  
  if (!data.idCard?.trim()) {
    return { success: false, message: '请输入身份证号' }
  }
  if (!/^\d{17}[\dXx]$/.test(data.idCard)) {
    return { success: false, message: '身份证号格式不正确' }
  }

  
  if (data.storeId && !isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建员工' }
  }

  
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
      
      
      
      if (!id) throw new ApiError('INVALID_STATE', '员工编号生成失败')

      await tx.insert(staffWechatUsers).values({
        employeeId: id,
        phone: data.phone,
        name: data.name,
        gender: data.gender ?? null,
        idCard: data.idCard ?? null,
        storeId: data.storeId ?? null,
        orgNodeId: data.orgNodeId ?? null,
        positionName: data.positionName ?? null,
        avatarUrl: data.avatarUrl ?? null,
        birthday: data.birthday ?? null,
        skills: data.skills ?? null,
        socialInsurance: data.socialInsurance ?? false,
        isResigned: false,
        
        hiredAt: data.hiredAt ?? shanghaiToday(),
        resignedAt: null,
      })

      return id
    })
  } catch (err: any) {
    
    if (pgErrorCode(err) === '23505') {
      if (pgErrorDetail(err)?.includes('phone') || pgErrorConstraint(err)?.includes('phone')) {
        return { success: false, message: '该手机号已被其他员工使用' }
      }
      return { success: false, message: '数据冲突，请稍后重试' }
    }
    throw err
  }

  await logOperation(session, 'employee.create', 'employee', employeeId, { name: data.name })
  revalidatePath('/employees')
  return { success: true, message: '员工创建成功', employeeId }
  },
)

export const updateEmployee = withPermission(
  'employee:update',
  async (
    session,
    employeeId: string,
    data: Partial<{
      phone: string | null
      name: string | null
      gender: string | null
      idCard: string | null
      storeId: string | null
      orgNodeId: string | null
      positionName: string | null
      
      avatarUrl: string | null
      birthday: string | null
      skills: string[] | null
      
      socialInsurance: boolean
      isResigned: boolean
      
      hiredAt: string | null
      
      leaveStart: string | null
      
      leaveEnd: string | null
      
      isOnBusinessTrip: boolean
      
      resignedAt: string | null
      
      resignationReason: string | null
    }>,
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  
  if (data.phone !== undefined && data.phone !== null && !/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }
  
  if (data.name !== undefined && !data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  
  if (data.idCard !== undefined) {
    if (!data.idCard?.trim()) {
      return { success: false, message: '请输入身份证号' }
    }
    if (!/^\d{17}[\dXx]$/.test(data.idCard)) {
      return { success: false, message: '身份证号格式不正确' }
    }
  }

  
  if (data.leaveStart !== undefined || data.leaveEnd !== undefined) {
    const ls = data.leaveStart || null
    const le = data.leaveEnd || null
    if ((ls && !le) || (!ls && le)) {
      return { success: false, message: '请假开始和结束时间需同时填写' }
    }
    
    if (ls && le && le <= ls) {
      return { success: false, message: '请假结束时间须晚于开始时间' }
    }
  }

  
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

  
  const [currentEmployee] = await db.select().from(staffWechatUsers).where(eq(staffWechatUsers.employeeId, employeeId)).limit(1)
  const oldStoreId = currentEmployee?.storeId ?? null

  
  const scopeCond = scopeCondition(session, staffWechatUsers.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(staffWechatUsers.employeeId, employeeId),
        sql`date_trunc('milliseconds', ${staffWechatUsers.updatedAt}) = ${expectedUpdatedAt}`,
        scopeCond,
      )
    : and(eq(staffWechatUsers.employeeId, employeeId), scopeCond)

  
  
  
  const updateData = { ...data }
  
  if (data.leaveStart !== undefined) updateData.leaveStart = data.leaveStart || null
  if (data.leaveEnd !== undefined) updateData.leaveEnd = data.leaveEnd || null
  if (data.isResigned !== undefined && data.resignedAt === undefined) {
    updateData.resignedAt = data.isResigned ? shanghaiToday() : null
  }
  
  if (data.isResigned === false) {
    updateData.resignationReason = null
  }

  
  
  if (data.isResigned === true) {
    if (await isAdminEmployee(employeeId)) {
      const adminCount = await countActiveAdmins()
      if (adminCount <= 1) {
        throw new Error('INVALID_STATE: 该员工是系统最后一个活跃 admin，请先转移角色')
      }
    }
  }

  let result: any
  try {
    result = await db.update(staffWechatUsers).set(updateData).where(whereConditions)
  } catch (err: any) {
    if (pgErrorCode(err) === '23505') {
      if (pgErrorDetail(err)?.includes('phone') || pgErrorConstraint(err)?.includes('phone')) {
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

  
  if (data.isResigned === true) {
    await db.transaction(async (tx) => {
      const roles = await tx
        .select({
          id: permissionRoles.id,
          role: permissionRoles.role,
          scopeId: permissionRoles.scopeId,
        })
        .from(permissionRoles)
        .where(eq(permissionRoles.employeeId, employeeId))
      await tx.delete(permissionRoles).where(eq(permissionRoles.employeeId, employeeId))
      for (const r of roles) {
        await logOperation(session, 'permission.revoke', 'permission_role', String(r.id), {
          role: r.role,
          scopeId: r.scopeId,
          employeeId,
          batch: 'resignation',
        })
      }
    })
  }

  
  
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
        ))

      if ((scopeResult as any).count > 0) {
        await logOperation(session, 'permission.scopeSync', 'permission_role', employeeId, {
          oldStoreId, newStoreId: data.storeId,
          oldScopeId: oldStore.orgNodeId, newScopeId: newStore.orgNodeId,
        })
      }
    }
  }

  await logUpdate(session, 'employee.update', 'employee', employeeId, currentEmployee as Record<string, unknown>, data)
  revalidatePath('/employees')
  revalidatePath('/permissions')
  return { success: true, message: '员工信息已更新' }
  },
)


export const deleteEmployee = withPermission(
  'employee:delete',
  async (session, employeeId: string): Promise<{ success: boolean; message: string }> => {
    if (employeeId === session.employeeId) {
      return { success: false, message: '不能删除当前登录的自己' }
    }

    const [emp] = await db
      .select({ name: staffWechatUsers.name, phone: staffWechatUsers.phone, storeId: staffWechatUsers.storeId, isResigned: staffWechatUsers.isResigned })
      .from(staffWechatUsers)
      .where(and(eq(staffWechatUsers.employeeId, employeeId), scopeCondition(session, staffWechatUsers.storeId)))
      .limit(1)

    if (!emp) {
      return { success: false, message: '员工不存在或无权操作' }
    }

    
    if (await isAdminEmployee(employeeId)) {
      const adminCount = await countActiveAdmins()
      if (adminCount <= 1) {
        return { success: false, message: '该员工是系统最后一个活跃管理员，请先转移角色' }
      }
    }

    try {
      const txResult = await db.transaction(async (tx) => {
        
        await tx.delete(adminPasswords).where(eq(adminPasswords.employeeId, employeeId))
        await tx.delete(permissionRoles).where(eq(permissionRoles.employeeId, employeeId))
        
        const result = await tx
          .delete(staffWechatUsers)
          .where(and(eq(staffWechatUsers.employeeId, employeeId), scopeCondition(session, staffWechatUsers.storeId)))
        if ((result as any).count === 0) {
          throw new Error('EMPLOYEE_ROW_GONE')
        }
        return true
      })
      if (!txResult) {
        return { success: false, message: '员工状态已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'EMPLOYEE_ROW_GONE') {
        return { success: false, message: '员工状态已变更，请刷新重试' }
      }
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '该员工已有业务关联（订单 / 服务 / 分配 / 预约 / 库存等），无法删除，建议改为离职' }
      }
      throw e
    }

    await logOperation(session, 'employee.delete', 'employee', employeeId, {
      snapshot: { name: emp.name, phone: emp.phone, storeId: emp.storeId, isResigned: emp.isResigned },
    })

    revalidatePath('/employees')
    revalidatePath('/permissions')
    return { success: true, message: '员工已删除' }
  },
)
