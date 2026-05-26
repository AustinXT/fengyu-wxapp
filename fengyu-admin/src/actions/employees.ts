'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { eq, and, or, sql, ilike, inArray, desc, asc } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import type { Employee } from '@/lib/types'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { shanghaiToday } from '@/lib/datetime'

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
    avatarUrl: e.avatarUrl,
    birthday: e.birthday,
    skills: e.skills,
    isResigned: e.isResigned,
    hiredAt: e.hiredAt,
    resignedAt: e.resignedAt,
    lastLoginAt: e.lastLoginAt?.toISOString() ?? null,
    createdAt: e.createdAt?.toISOString() ?? '',
    updatedAt: e.updatedAt?.toISOString() ?? '',
    storeName: row.stores?.storeName ?? undefined,
    departmentName: row.org_nodes?.name ?? undefined,
  }
}

/**
 * 员工选择器数据源 — 用于顾客分配、分配营业额、开单选店员等 picker 场景。
 * 主管理列表（含筛选 + 分页 + 乐观锁编辑）请使用 getEmployeesPaginated。
 *
 * 不加 LIMIT：picker 必须返回 scope 内全部员工，否则前端按 storeId 二次过滤
 * 时会因排序截断丢失目标 store 的人（详见 2026-05-18 admin/orders/create
 * 南昌万科店 dropdown 只显示 2 人的根因复盘）。scoped 角色天然受 scopeCondition
 * 限制；admin 角色无 scope，会全量拉（当前 ~2000 行在职员工，prop 体量可接受）。
 */
export const getEmployees = withPermission(
  'employee:list',
  async (session): Promise<Employee[]> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .where(scopeCondition(session, staffWechatUsers.storeId))
    // 例外：picker 字母序（人眼扫视更友好）
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)

/**
 * 全公司在职「品项老师」员工 — 营业额/服务提成分配专用补充候选池。
 *
 * 品项老师可跨门店/跨市场被任意订单分配，故**不加 scopeCondition**，返回全部
 * 拥有「品项老师」技能的在职员工。调用方（分配详情页）需与 getEmployees 结果按
 * employeeId 去重合并，再交给前端按技能筛选。
 */
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
    // 例外：picker 字母序（与 getEmployees 一致）
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)

/**
 * 搜索在职员工（不限 scope），用于推荐人选择等场景。
 * 返回简要信息，最多 20 条。
 */
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
    // 例外：搜索选择器字母序
    .orderBy(asc(staffWechatUsers.name))
    .limit(20)

  return rows
  },
)

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
export const getEmployeesPaginated = withPermission(
  'employee:list',
  async (session, filters: EmployeeFilters = {}): Promise<PaginatedEmployees> => {
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
    if (node?.type === '市场') {
      // 市场：筛选该市场下所有门店的员工
      const sub = db.select({ storeId: stores.storeId }).from(stores)
        .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
        .where(eq(storeNode.parentId, filters.marketId))
      conditions.push(inArray(staffWechatUsers.storeId, sub))
    } else if (node?.type === '部门') {
      // 总部部门：筛选 orgNodeId 为该部门的员工
      conditions.push(eq(staffWechatUsers.orgNodeId, filters.marketId))
    } else if (node?.type === '门店') {
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
      // 默认排序：最近编辑过的员工浮顶（admin.sys.spec.md §5），employeeId 作为稳定分页 tiebreaker
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

/** 获取组织架构第 2 级节点（市场 + 总部部门，用于筛选下拉） */
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
    // 例外：sortOrder 手工排序权重
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
      /** 头像 URL（admin /api/upload 返回的 cloud:// fileID 或 https CDN URL） */
      avatarUrl?: string | null
      /** 入职日期（YYYY-MM-DD）；缺省由 DB 默认 NULL，由后续兜底 */
      hiredAt?: string | null
    },
  ): Promise<{ success: boolean; message: string; employeeId?: string }> => {
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
      // P0 audit-CC5 示范：用 ApiError 替代裸 throw，让错误前缀（INVALID_STATE）
      // 走 9 项白名单通道，前端可按 errorType 路由。
      // 其余 33 处 admin actions 裸 throw 由 ticket-10c 全量迁移。
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
        isResigned: false,
        // 默认按今天作为入职日（admin 表单可覆盖），mgmt-dashboard 员工数历史化所需
        hiredAt: data.hiredAt ?? shanghaiToday(),
        resignedAt: null,
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
      /** 头像 URL（cloud:// fileID 或 https CDN URL；null = 清空头像） */
      avatarUrl: string | null
      birthday: string | null
      skills: string[] | null
      isResigned: boolean
      /** 入职日期（YYYY-MM-DD） */
      hiredAt: string | null
      /** 离职日期（YYYY-MM-DD）；与 isResigned 双写一致，由 action 自动维护 */
      resignedAt: string | null
    }>,
    /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
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

  // 获取旧值用于日志 diff + storeId 变更检测
  const [currentEmployee] = await db.select().from(staffWechatUsers).where(eq(staffWechatUsers.employeeId, employeeId)).limit(1)
  const oldStoreId = currentEmployee?.storeId ?? null

  // 乐观锁 + scope 隔离：WHERE employee_id = $1 [AND updated_at = $2] [AND scope]
  const scopeCond = scopeCondition(session, staffWechatUsers.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(
        eq(staffWechatUsers.employeeId, employeeId),
        sql`date_trunc('milliseconds', ${staffWechatUsers.updatedAt}) = ${expectedUpdatedAt}`,
        scopeCond,
      )
    : and(eq(staffWechatUsers.employeeId, employeeId), scopeCond)

  // is_resigned ↔ resigned_at 双写一致：调用方仅传 isResigned 时由 action 自动推导 resignedAt
  // - isResigned=true 且未显式给 resignedAt：写 today
  // - isResigned=false：清空 resignedAt
  const updateData = { ...data }
  if (data.isResigned !== undefined && data.resignedAt === undefined) {
    updateData.resignedAt = data.isResigned ? shanghaiToday() : null
  }

  // 离职前最后 admin 守卫（D-Q12-2026-04-26 / audit-22 P0-22-03）
  // 必须在 UPDATE is_resigned=true 之前检查：countActiveAdmins 用 is_resigned=false JOIN 过滤
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

  // 标记离职时事务清理权限角色 + 逐条 logOperation（audit-22 P1-22-06 顺手关闭）
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
