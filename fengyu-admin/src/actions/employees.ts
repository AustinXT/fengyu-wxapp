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
import { scopeCondition, isInScope, requireAdmin, employeeScopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode, pgErrorConstraint, pgErrorDetail } from '@/lib/pg-error'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { shanghaiToday } from '@/lib/datetime'
import { parseEmployeeFilters, filterValidSkillValues } from '@/lib/list-filters'
import { getSkillTags } from '@/actions/skill-tags'

// drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
const storeNode = alias(orgNodes, 'store_node') as unknown as typeof orgNodes
const marketNode = alias(orgNodes, 'market_node') as unknown as typeof orgNodes

// drizzle 0.45 alias 后的 join row 被推断为宽松 { [x: string]: any }，
// 严格类型签名跟实际不匹配 — 用 any 解锁 build；运行时行为不变
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
    // leave_start / leave_end 列为 mode:'string'，直接是墙钟字符串，无需 toISOString
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
    .where(employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId))
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
 * 全公司在职「出差支援」员工 — 跨门店开单 / 分配的候选补充池（2026-06-24）。
 *
 * is_on_business_trip=true 的员工可被任意门店的开单 / 营业额分配 / 服务提成分配选中，
 * 故**不加 scopeCondition**，返回全部在职出差员工。调用方需与 getEmployees 结果按
 * employeeId 去重合并，再交前端按「本门店 ∪ 出差」+ 技能筛选。出差标记长期保留直至 admin 手动改回（不再每日重置）。
 */
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
  /** 技能标签多选 OR 筛选（与 staff_wechat_users.skills text[] 数组 overlap `&&` 语义一致） */
  skills?: string[]
  page?: number
  pageSize?: number
}

/** 分页结果 */
export interface PaginatedEmployees {
  data: Employee[]
  total: number
}

/**
 * 构建员工列表 WHERE 条件（列表分页与导出共用）。
 * marketId 分支需查节点类型，故为 async。
 */
async function buildEmployeeConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: EmployeeFilters,
): Promise<(SQL | undefined)[]> {
  const conditions: (SQL | undefined)[] = [
    employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId),
  ]

  if (filters.marketId) {
    // 查询节点类型以决定过滤策略
    const [node] = await db
      .select({ type: orgNodes.type })
      .from(orgNodes)
      .where(eq(orgNodes.id, filters.marketId))
      .limit(1)
    if (node?.type === '市场') {
      // 市场：该市场下门店的员工（store_id 路径）+ 挂该市场的部门员工（org_node_id，store_id IS NULL）
      const storeSub = db.select({ storeId: stores.storeId }).from(stores)
        .innerJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
        .where(eq(storeNode.parentId, filters.marketId))
      const deptSub = db.select({ id: orgNodes.id }).from(orgNodes)
        .where(and(eq(orgNodes.type, '部门'), eq(orgNodes.parentId, filters.marketId)))
      conditions.push(or(
        inArray(staffWechatUsers.storeId, storeSub),
        inArray(staffWechatUsers.orgNodeId, deptSub),
      ))
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
  if (filters.skills?.length) {
    // PG 数组 overlap `&&` 等价于 OR（任一命中即匹配）。
    // 用 sql.join + sql.raw 分隔符把每个标签作为参数化占位传入，避免拼接注入；
    // 与 admin data-center/sales.ts:194、fengyu-staff/cloudfunctions/staffApi/routes/staff.js:104 同口径。
    const values = sql.join(
      filters.skills.map(s => sql`${s}`),
      sql.raw(', '),
    )
    conditions.push(
      sql`${staffWechatUsers.skills} && ARRAY[${values}]::text[]`,
    )
  }

  return conditions
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

/** 员工导出行（一行一员工，含档案补全字段；身份证脱敏在前端做） */
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

/** 导出员工（全部筛选命中）。身份证脱敏由前端 maskIdCard 处理。LIMIT 10000 防 OOM。 */
export const exportEmployees = withPermission(
  'employee:list',
  async (
    session,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: ExportEmployeeRow[]; truncated: boolean }> => {
    const LIMIT = 10000
    const parsed = parseEmployeeFilters(params)
    // 服务端兜底：剔除 URL ?skill= 中已停用（isValid=false）的标签，防幽灵筛选。
    // 与列表路径 page.tsx 同源；前端 handleExport 已清洗，此处为防御层（即使漏清洗，
    // 导出也不被静默收窄；与员工列表 getEmployeesPaginated 对称处理）。
    const skillTags = await getSkillTags()
    const validSkillNames = new Set(skillTags.filter((t) => t.isValid).map((t) => t.name))
    const filters = {
      ...parsed,
      skills: filterValidSkillValues(parsed.skills, validSkillNames),
    }
    const whereClause = and(...(await buildEmployeeConditions(session, filters)))

    const dataRows = await db
      .select()
      .from(staffWechatUsers)
      // 「所属组织」导出列改用员工 orgNodeId（前端 buildOrgPath 构建完整路径），与列表页一致。
      // 无门店员工（养生部/财智部/总部职能岗）storeId 为 null，旧的门店→父市场链取不到组织值。
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
    .where(and(eq(staffWechatUsers.employeeId, employeeId), employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId)))

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
      /** 是否缴纳社保；默认否 */
      socialInsurance?: boolean
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
  // 身份证号必填（应用层强制）
  if (!data.idCard?.trim()) {
    return { success: false, message: '请输入身份证号' }
  }
  if (!/^\d{17}[\dXx]$/.test(data.idCard)) {
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
        socialInsurance: data.socialInsurance ?? false,
        isResigned: false,
        // 默认按今天作为入职日（admin 表单可覆盖），mgmt-dashboard 员工数历史化所需
        hiredAt: data.hiredAt ?? shanghaiToday(),
        resignedAt: null,
      })

      return id
    })
  } catch (err: any) {
    // PG 唯一约束冲突（手机号或员工编号并发重复）
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
      /** 头像 URL（cloud:// fileID 或 https CDN URL；null = 清空头像） */
      avatarUrl: string | null
      birthday: string | null
      skills: string[] | null
      /** 是否缴纳社保 */
      socialInsurance: boolean
      isResigned: boolean
      /** 入职日期（YYYY-MM-DD） */
      hiredAt: string | null
      /** 请假开始时间（datetime-local YYYY-MM-DDTHH:mm）；与 leaveEnd 成对，空串归一为 null */
      leaveStart: string | null
      /** 请假结束时间（datetime-local YYYY-MM-DDTHH:mm） */
      leaveEnd: string | null
      /** 是否出差支援（跨门店共享标记）；长期保留直至 admin 手动改回 false（不再每日重置） */
      isOnBusinessTrip: boolean
      /** 离职日期（YYYY-MM-DD）；与 isResigned 双写一致，由 action 自动维护 */
      resignedAt: string | null
      /** 离职原因（自由文本）；与 isResigned 联动：复职时由 action 自动清空 */
      resignationReason: string | null
    }>,
    /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 服务端输入校验
  if (data.phone !== undefined && data.phone !== null && !/^1\d{10}$/.test(data.phone)) {
    return { success: false, message: '手机号格式不正确（需为 11 位手机号）' }
  }
  // 姓名必填（仅当本次显式传入 name 时校验，避免拦截只改其它字段的更新）
  if (data.name !== undefined && !data.name?.trim()) {
    return { success: false, message: '姓名不能为空' }
  }
  // 身份证号必填（仅当本次显式传入 idCard 时校验）
  if (data.idCard !== undefined) {
    if (!data.idCard?.trim()) {
      return { success: false, message: '请输入身份证号' }
    }
    if (!/^\d{17}[\dXx]$/.test(data.idCard)) {
      return { success: false, message: '身份证号格式不正确' }
    }
  }

  // 请假区间成对 + 顺序校验（仅当本次涉及请假字段时；空串视为 null）
  if (data.leaveStart !== undefined || data.leaveEnd !== undefined) {
    const ls = data.leaveStart || null
    const le = data.leaveEnd || null
    if ((ls && !le) || (!ls && le)) {
      return { success: false, message: '请假开始和结束时间需同时填写' }
    }
    // datetime-local 同格式（YYYY-MM-DDTHH:mm）字典序即时间序，可直接比较；DB chk_swu_leave_range 兜底
    if (ls && le && le <= ls) {
      return { success: false, message: '请假结束时间须晚于开始时间' }
    }
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
  const scopeCond = employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId)
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
  // 请假字段空串归一为 null（清空请假区间）
  if (data.leaveStart !== undefined) updateData.leaveStart = data.leaveStart || null
  if (data.leaveEnd !== undefined) updateData.leaveEnd = data.leaveEnd || null
  if (data.isResigned !== undefined && data.resignedAt === undefined) {
    updateData.resignedAt = data.isResigned ? shanghaiToday() : null
  }
  // 复职 / 撤销离职：连带清空离职原因
  if (data.isResigned === false) {
    updateData.resignationReason = null
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

/**
 * 物理删除员工（仅系统管理员；数据治理用，清理测试员工账号）。
 *
 * 仅适用于"无任何业务关联"的测试号：员工被 25+ 张业务表（订单/服务/分配/预约/库存/解绑/操作日志…）
 * 引用即由 PG FK RESTRICT 拦截，pgErrorCode 23503 兜底回滚并提示「改为离职」。
 * 事务内先删可随删的从属行（admin_passwords 登录凭证 + 该员工 permission_roles），再删主表。
 * 守卫：不能删自己；不能删系统最后一个活跃 admin。
 */
export const deleteEmployee = withPermission(
  'employee:delete',
  async (session, employeeId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    if (employeeId === session.employeeId) {
      return { success: false, message: '不能删除当前登录的自己' }
    }

    const [emp] = await db
      .select({ name: staffWechatUsers.name, phone: staffWechatUsers.phone, storeId: staffWechatUsers.storeId, isResigned: staffWechatUsers.isResigned })
      .from(staffWechatUsers)
      .where(and(eq(staffWechatUsers.employeeId, employeeId), employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId)))
      .limit(1)

    if (!emp) {
      return { success: false, message: '员工不存在或无权操作' }
    }

    // 最后一个活跃 admin 守卫（删除会移除其 admin 角色 → 自锁）
    if (await isAdminEmployee(employeeId)) {
      const adminCount = await countActiveAdmins()
      if (adminCount <= 1) {
        return { success: false, message: '该员工是系统最后一个活跃管理员，请先转移角色' }
      }
    }

    try {
      const txResult = await db.transaction(async (tx) => {
        // 先删可随员工删除的从属行（登录凭证 + 权限角色）
        await tx.delete(adminPasswords).where(eq(adminPasswords.employeeId, employeeId))
        await tx.delete(permissionRoles).where(eq(permissionRoles.employeeId, employeeId))
        // 删主表（被任一业务表引用会在此抛 23503，回滚上面的删除）
        const result = await tx
          .delete(staffWechatUsers)
          .where(and(eq(staffWechatUsers.employeeId, employeeId), employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId)))
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
