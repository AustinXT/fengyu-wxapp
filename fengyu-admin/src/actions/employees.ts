'use server'

import { db } from '@/db'
import { staffWechatUsers } from '@db/user'
import { stores, orgNodes } from '@db/org'
import { permissionRoles } from '@db/permission'
import { adminPasswords } from '@db/admin-auth'
import { eq, and, or, gt, sql, ilike, desc, asc, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import type { AllocationEmployeeCandidate, Employee } from '@/lib/types'
import { scopeCondition, isInScope, isOrgNodeInScope, isAdminScope, isEmployeeRowVisible, requireAdmin, employeeScopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { pgErrorCode, pgErrorConstraint, pgErrorDetail } from '@/lib/pg-error'
import { countActiveAdmins, isAdminEmployee } from '@/lib/admin-guard'
import { shanghaiToday } from '@/lib/datetime'
import {
  resolveExportBatchLimit,
  resolveExportKeysetPage,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { parseEmployeeFilters, filterValidSkillValues } from '@/lib/list-filters'
import { getSkillTags } from '@/actions/skill-tags'
import { orgNodeInScopeCondition, storeInOrgNodeCondition } from '@/lib/market-store-sql'
import { maskPhone } from '@/lib/pii'
import {
  EMPLOYEE_ANCHOR_MARKET_JOIN,
  SERVICE_ORDER_ASSIGNABLE_SKILLS,
  marketSupportCondition,
  targetMarketJoin,
} from '@/lib/employee-anchor-market-sql'

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
    marketName: row.market_node?.name ?? undefined,
  }
}

/**
 * scope 内员工选择器数据源 — 用于顾客分配、开单、服务单等仅限本店的 picker 场景。
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
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId))
    // 例外：picker 字母序（人眼扫视更友好）
    .orderBy(asc(staffWechatUsers.name))

  return rows.map(rowToEmployee)
  },
)

/**
 * 候选查询的原始行（分配候选与服务单候选共用同一组列）。
 * 故意不含 phone / id_card 等档案字段——候选接口只暴露选人所需的最小信息。
 */
type CandidateRow = {
  employee_id: string
  name: string | null
  store_id: string | null
  position_name: string | null
  skills: string[] | null
  is_on_business_trip: boolean
  store_name: string | null
  department_name: string | null
  market_name: string | null
  assignment_scope: AllocationEmployeeCandidate['assignmentScope']
}

function toCandidate(row: CandidateRow): AllocationEmployeeCandidate {
  return {
    employeeId: row.employee_id,
    name: row.name,
    storeId: row.store_id,
    positionName: row.position_name,
    skills: row.skills,
    isResigned: false,
    isOnBusinessTrip: row.is_on_business_trip,
    storeName: row.store_name ?? undefined,
    departmentName: row.department_name ?? undefined,
    marketName: row.market_name ?? undefined,
    assignmentScope: row.assignment_scope,
  }
}

/**
 * 营业额/服务提成分配候选：本门店员工 + 全公司已开启出差支援的员工。
 * 这是目标门店级、最小字段接口；跨市场候选不复用员工档案列表，避免泄露 PII。
 */
export const getAllocationEmployeeCandidates = withPermission(
  'allocation:list',
  async (session, targetStoreId: string): Promise<AllocationEmployeeCandidate[]> => {
    if (!targetStoreId || !isInScope(session, targetStoreId)) {
      throw new Error('PERMISSION_DENIED: 无权查看该门店的分配候选员工')
    }

    const rows = (await db.execute(sql`
      SELECT
        u.employee_id,
        u.name,
        u.store_id,
        u.position_name,
        u.skills,
        u.is_on_business_trip,
        s.store_name,
        d.name AS department_name,
        employee_market.name AS market_name,
        CASE
          WHEN u.store_id = ${targetStoreId} THEN 'local'
          WHEN employee_market.id = target_market.id THEN 'same_market_trip'
          ELSE 'cross_market_trip'
        END AS assignment_scope
      FROM staff_wechat_users u
      LEFT JOIN stores s ON s.store_id = u.store_id
      LEFT JOIN org_nodes store_node ON store_node.id = s.org_node_id
      LEFT JOIN org_nodes d ON d.id = u.org_node_id
      LEFT JOIN org_nodes employee_org_parent ON employee_org_parent.id = d.parent_id
      LEFT JOIN org_nodes employee_market ON employee_market.id = COALESCE(
        store_node.parent_id,
        CASE
          WHEN d.type = '市场' THEN d.id
          WHEN d.type = '门店' THEN d.parent_id
          WHEN d.type = '部门' AND employee_org_parent.type = '市场' THEN employee_org_parent.id
          WHEN d.type = '部门' AND employee_org_parent.type = '门店' THEN employee_org_parent.parent_id
          ELSE NULL
        END
      ) AND employee_market.type = '市场'
      JOIN stores target_store ON target_store.store_id = ${targetStoreId}
      JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
      LEFT JOIN org_nodes target_market ON target_market.id = target_store_node.parent_id
      WHERE u.is_resigned = false
        AND u.employee_id IS NOT NULL
        AND (u.store_id = ${targetStoreId} OR u.is_on_business_trip = true)
      ORDER BY
        CASE
          WHEN u.store_id = ${targetStoreId} THEN 0
          WHEN employee_market.id = target_market.id THEN 1
          ELSE 2
        END,
        employee_market.name NULLS LAST,
        s.store_name NULLS LAST,
        d.name NULLS LAST,
        u.name NULLS LAST,
        u.employee_id
    `)) as unknown as CandidateRow[]

    return rows.map(toCandidate)
  },
)

/**
 * 服务单创建的服务人员候选（issue #210）：本门店员工 ∪ 本门店所属市场内已开启出差支援的员工，
 * 技能须命中 SERVICE_ORDER_ASSIGNABLE_SKILLS 四项之一。
 *
 * 不复用 `getEmployees()` 客户端过滤的老写法，原因有二：
 *   1. 员工档案列表的 marketName 来自「门店 → 市场」，store_id 为空的直挂节点员工恒为 null，锚不到市场；
 *   2. `getEmployees()` 走 employeeScopeCondition，门店级账号看不到市场内别店员工，候选恒空。
 * 与 getAllocationEmployeeCandidates 同范式：目标门店级、最小字段，不外泄员工档案 PII。
 *
 * 排序：本店整体置顶 → 块内按技能白名单数组顺序（店经理→美容师→养生师→品项老师）→ 姓名。
 * 返回的 assignmentScope 只会是 'local' / 'same_market_trip'（跨市场出差不进服务单候选）。
 */
export const getServiceStaffCandidates = withPermission(
  'service:create',
  async (session, targetStoreId: string): Promise<AllocationEmployeeCandidate[]> => {
    if (!targetStoreId || !isInScope(session, targetStoreId)) {
      throw new Error('PERMISSION_DENIED: 无权查看该门店的服务人员候选')
    }

    const skills = SERVICE_ORDER_ASSIGNABLE_SKILLS
    const rows = (await db.execute(sql`
      SELECT
        u.employee_id,
        u.name,
        u.store_id,
        u.position_name,
        u.skills,
        u.is_on_business_trip,
        s.store_name,
        d.name AS department_name,
        employee_market.name AS market_name,
        CASE WHEN u.store_id = ${targetStoreId} THEN 'local' ELSE 'same_market_trip' END AS assignment_scope
      FROM staff_wechat_users u${EMPLOYEE_ANCHOR_MARKET_JOIN}${targetMarketJoin(targetStoreId)}
      WHERE u.is_resigned = false
        AND u.employee_id IS NOT NULL
        AND u.skills && ${sql.param(skills)}::text[]
        AND ${marketSupportCondition(targetStoreId)}
      ORDER BY
        CASE WHEN u.store_id = ${targetStoreId} THEN 0 ELSE 1 END,
        (SELECT MIN(array_position(${sql.param(skills)}::text[], sk))
           FROM unnest(u.skills) sk
          WHERE sk = ANY(${sql.param(skills)}::text[])) NULLS LAST,
        u.name NULLS LAST,
        u.employee_id
    `)) as unknown as CandidateRow[]

    return rows.map(toCandidate)
  },
)

/**
 * 搜索全部在职员工，用于推荐人选择等场景（推荐人可跨店，不受账号 scope 限制）。
 * 手机号仅返回脱敏值，避免选择器接口泄露完整 PII。
 */
export const searchEmployees = withPermission(
  'employee:list',
  async (
    session,
    keyword: string,
  ): Promise<{
    employeeId: string
    name: string | null
    phoneMasked: string
    storeName: string | null
    isResigned: false
  }[]> => {
  const trimmed = keyword.trim()
  if (trimmed.length < 3) return []

  const pattern = `%${trimmed}%`
  const rows = await db
    .select({
      employeeId: staffWechatUsers.employeeId,
      name: staffWechatUsers.name,
      phone: staffWechatUsers.phone,
      storeName: stores.storeName,
      isResigned: staffWechatUsers.isResigned,
    })
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
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

  return rows.map((row) => ({
    employeeId: row.employeeId,
    name: row.name,
    phoneMasked: maskPhone(row.phone),
    storeName: row.storeName,
    isResigned: false as const,
  }))
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
 * 组织筛选统一按节点自身及任意层级后代展开。
 */
async function buildEmployeeConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: EmployeeFilters,
): Promise<(SQL | undefined)[]> {
  const conditions: (SQL | undefined)[] = [
    employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId),
  ]

  if (filters.marketId) {
    conditions.push(or(
      storeInOrgNodeCondition(staffWechatUsers.storeId, filters.marketId),
      orgNodeInScopeCondition(staffWechatUsers.orgNodeId, filters.marketId),
    ))
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
    data: rows.map(rowToEmployee),
    total: countRow?.count ?? 0,
  }
  },
  // employee:list 是多个业务页的引用读依赖，不代表拥有“员工管理”。
  // 主列表的菜单门槛是 employee:create，故数据范围也必须只取该能力角色。
  { scopeActions: ['employee:create'] },
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
  /** 「入职日期」列：hired_at（date 列，原样透传，格式化在 registry 的列 map 里做，与 birthday 同源） */
  hiredAt: string | null
  birthday: string | null
  skills: string | null
  socialInsurance: boolean
  isResigned: boolean
  resignationReason: string | null
}

/**
 * 导出员工（全部筛选命中）。身份证脱敏在导出列 maskIdCard 处做。
 *
 * **分页用 keyset 且排序键换成 employee_id，不能沿用列表页的 desc(updated_at)**（#183）：
 * updated_at 是可变列，而员工每次登录 staff 小程序都会被 `staffApi/routes/auth.js` 写一次
 * （还有 drizzle 的 $onUpdate、删技能标签的级联更新），导出期间行会不断被顶到最前。
 * 配 offset 翻页时，任何一行从「未导出区」被顶进「已导出区」都必然造成**一行重复 + 一行永久漏掉**，
 * 且漏掉的那行毫无痕迹。employee_id 是不可变主键，keyset 下天然免疫。
 * 代价是导出不再按「编辑即浮顶」排序，改为按员工编号升序——对逐行核对的导出场景反而更合用。
 */
export const exportEmployees = withPermission(
  'employee:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions<string>,
  ): Promise<ExportBatchResult<ExportEmployeeRow, string>> => {
    // 游标校验放在任何查询之前：畸形游标不该先白打一次 getSkillTags 的库
    const limit = resolveExportBatchLimit(options?.limit)
    const cursor = options?.cursor
    // 只有 undefined 代表「首批」；空串 / 非字符串一律视为畸形，不能静默从头重扫
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor)) {
      throw new ApiError('INVALID_STATE', '导出分页游标无效')
    }

    const parsed = parseEmployeeFilters(params)
    // 服务端兜底：剔除 URL ?skill= 中字典外（已删除）的标签名，防幽灵筛选。
    // 与列表路径 page.tsx 同源；前端 handleExport 已清洗，此处为防御层（即使漏清洗，
    // 导出也不被静默收窄；与员工列表 getEmployeesPaginated 对称处理）。
    const skillTags = await getSkillTags()
    const validSkillNames = new Set(skillTags.map((t) => t.name))
    const filters = {
      ...parsed,
      skills: filterValidSkillValues(parsed.skills, validSkillNames),
    }
    const whereClause = and(
      ...(await buildEmployeeConditions(session, filters)),
      ...(cursor ? [gt(staffWechatUsers.employeeId, cursor)] : []),
    )

    const query = db
      .select()
      .from(staffWechatUsers)
      // 「所属组织」导出列改用员工 orgNodeId（前端 buildOrgPath 构建完整路径），与列表页一致。
      // 无门店员工（养生部/财智部/总部职能岗）storeId 为 null，旧的门店→父市场链取不到组织值。
      .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
      .where(whereClause)
      // 例外：导出走 keyset 分页，排序键必须是不可变唯一键（见上方注释），故不用列表页的 updated_at 浮顶序。
      .orderBy(asc(staffWechatUsers.employeeId))
    const fetchedRows = limit == null
      ? await query
      : await query.limit(limit + 1)
    const { pageRows, hasMore, nextCursor } = resolveExportKeysetPage(
      fetchedRows,
      limit,
      (lastRow) => lastRow.staff_wechat_users.employeeId,
    )

    const rows: ExportEmployeeRow[] = pageRows.map((row) => {
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
        hiredAt: e.hiredAt,
        birthday: e.birthday,
        skills: e.skills?.filter((s) => validSkillNames.has(s)).join('、') ?? null,
        socialInsurance: e.socialInsurance,
        isResigned: e.isResigned,
        resignationReason: e.resignationReason,
      }
    })

    return {
      rows,
      truncated: false,
      hasMore,
      // 用 !== undefined 而不是真值判断：游标契约里空串是「畸形」，真值判断会在
      // hasMore 为真时悄悄不带游标，让 worker 抛 INVALID_STATE（fail-safe 但契约不对称）
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }
  },
  { scopeActions: ['employee:create'] },
)

export const getEmployeeById = withPermission(
  'employee:list',
  async (session, employeeId: string): Promise<Employee | null> => {
  const rows = await db
    .select()
    .from(staffWechatUsers)
    .leftJoin(stores, eq(staffWechatUsers.storeId, stores.storeId))
    .leftJoin(orgNodes, eq(staffWechatUsers.orgNodeId, orgNodes.id))
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(and(eq(staffWechatUsers.employeeId, employeeId), employeeScopeCondition(session, staffWechatUsers.storeId, staffWechatUsers.orgNodeId)))

  if (rows.length === 0) return null
  return rowToEmployee(rows[0])
  },
  { scopeActions: ['employee:create'] },
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


/**
 * 归属自洽校验（#259）：`orgNodeId` 若**归属于某个门店**（自身是门店节点，或挂在门店节点下），
 * 那个门店必须正是 `storeId` 所指的门店。
 *
 * ## 为什么是「最近的门店型祖先」而不是「自身 type 是门店」
 *
 * 第一版只判 `node.type === '门店'`，被评审指出漏掉一整类 —— 而且正是它声称要堵的危害：
 * `org.ts` 的 `validateParentType` 有一条 `门店节点下只能创建部门`，即**部门挂在门店下是
 * 明确许可的形态**。于是市场级 manager 可以把员工的 `orgNodeId` 改成挂在 store-B 下的部门节点 D：
 *   - `isOrgNodeInScope(M, D)` 成立（`scopeOrgNodeIds` 是「节点自身 + 任意层级后代」）
 *   - `D.type === '部门'` → 第一版直接放行
 *   - 而 store-B 的 manager（scope = `org-store-B` + 后代 ⊇ D）在名册里看得见该员工
 * 「同一员工同时出现在两个门店名册」原样复现。
 *
 * ⚠️ 我最初的论证基于「生产 0 人的 org_node 是门店节点的后代」—— 那量的是**现存数据，
 * 不是可达性**。org 模块正在鼓励创建这类节点，这个推断是错的。
 *
 * ## 为什么不要求两端严格相等
 *
 * 生产在职员工里 `store_id` 与 `org_node_id` 都非空且不相等的共 15 人：
 *   - **13 人**是矩阵式归属：养生师挂「养生部」、数据主管/助理挂「财智部」「财智管理中心」，
 *     这些部门节点挂在**市场**下（无门店祖先）→ 本规则放行。门店是工作地点、部门是专业归属。
 *   - **2 人**（王芳、王小凤）的 org_node_id 直接指向**另一个门店**节点 → 本规则拦住。
 *
 * 口径已拍板，见 issue #259 的评论。
 */
async function assertOwnershipConsistent(
  storeId: string | null,
  orgNodeId: string | null,
): Promise<string | null> {
  if (!storeId || !orgNodeId) return null

  // 自身及全部祖先里最近的那个「门店」型节点（path 防环，与 org.ts 的递归 CTE 同策略）
  const chain = await db.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, type, 0 AS depth, ARRAY[id] AS path
        FROM org_nodes WHERE id = ${orgNodeId}
      UNION ALL
      SELECT o.id, o.parent_id, o.type, c.depth + 1, c.path || o.id
        FROM org_nodes o JOIN chain c ON o.id = c.parent_id
       WHERE NOT o.id = ANY(c.path)
    )
    SELECT id FROM chain WHERE type = '门店' ORDER BY depth LIMIT 1
  `)
  const storeAncestor = (chain as unknown as Array<{ id: string }>)[0]?.id
  // 无门店祖先（挂市场下的部门、或直接挂市场）→ 与门店维度无关，放行
  if (!storeAncestor) return null

  const [store] = await db
    .select({ orgNodeId: stores.orgNodeId })
    .from(stores)
    .where(eq(stores.storeId, storeId))
    .limit(1)
  if (!store) return '所选门店不存在'
  /**
   * `stores.org_node_id` 可空（schema 无 `.notNull()`）。为空时无从比对，但**不能放行** ——
   * 员工挂着属于 store-B 的节点时 store-B 仍看得见他。给准确文案而不是复用「属于另一个门店」。
   */
  if (!store.orgNodeId) {
    return '本门店未配置组织节点，无法校验归属，请先在组织管理中为该门店配置节点'
  }
  if (store.orgNodeId === storeAncestor) return null
  return '所选组织节点属于另一个门店，请改选本门店或其所属部门'
}

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
  /**
   * #228：`orgNodeId` 同样要校验 —— 它和 `storeId` 是 `employeeScopeCondition` 的**两个并列维度**
   * （`store_id ∈ scope` **OR** `org_node_id ∈ scope`），只挡一个等于没挡：
   * 门店 manager 传 `{ storeId: null, orgNodeId: <别的市场节点> }` 就能在他人 scope 里凭空造出
   * 一条员工记录 —— 目标市场的 manager 能看见并编辑它，创建者自己反而看不见。
   * 只补 updateEmployee 而漏掉这里，等于堵了「搬运」却留着「凭空创建」。
   */
  if (data.orgNodeId && !isOrgNodeInScope(session, data.orgNodeId)) {
    return { success: false, message: '无权在该组织节点下创建员工' }
  }
  /**
   * #228：两端都不填 → 非 admin 拒绝。上面两条都以字段 truthy 为前提，双空时一条都不触发，
   * 于是普通 manager 直接提交空表单就能建出一条 `employeeScopeCondition` 对**所有非 admin**
   * 永不命中的员工记录：创建成功、返回 employeeId，但它立刻从创建者自己的名册里消失，
   * 且此后任何非 admin 的 updateEmployee 都会因 scopeCond 命中 0 行而无法修复。
   * 该手机号仍可被员工端 bindPhone 绑定 —— 一个管理侧不可见的活跃账号。
   * 这与 updateEmployee 侧「变更后必须仍可见」是同一条不变量的 create 面。
   */
  if (!isAdminScope(session) && !data.storeId && !data.orgNodeId) {
    return { success: false, message: '员工必须归属门店或组织节点之一' }
  }
  // #259：归属自洽 —— orgNodeId 指向「另一个门店」时拒绝（挂部门/市场放行）
  {
    const conflict = await assertOwnershipConsistent(data.storeId ?? null, data.orgNodeId ?? null)
    if (conflict) return { success: false, message: conflict }
  }

  /**
   * 同 updateEmployee：手机号唯一性交给 DB 约束 + 下面的 23505 转译，不做事务外预查重。
   * 这里的预查同样是零写入信道 —— 提交一个 scope 内归属 + 合法必填字段 + **非法 birthday**，
   * 手机号已占用时直接返回占用文案、未占用时 INSERT 因日期转换失败整事务回滚，
   * 两者同样零持久化写入而响应可区分（codex 谱系第 5 轮）。
   */
  // 事务：ID 生成（advisory lock）+ 插入，原子提交防并发重复
  let employeeId: string
  try {
    employeeId = await db.transaction(async (tx) => {
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('employee_id_gen')::bigint)
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
        // #228：与上面 `data.storeId &&` 的 truthiness 校验口径一致，`''` 一律落 null
        storeId: data.storeId || null,
        orgNodeId: data.orgNodeId || null,
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
      /** 是否出差支援（仅营业额/服务提成分配跨店使用）；长期保留直至 admin 手动改回 false */
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

  // 获取旧值用于日志 diff + storeId 变更检测
  const [currentEmployee] = await db.select().from(staffWechatUsers).where(eq(staffWechatUsers.employeeId, employeeId)).limit(1)
  const oldStoreId = currentEmployee?.storeId ?? null
  const oldOrgNodeId = currentEmployee?.orgNodeId ?? null

  /**
   * #228：旧记录存在但**不在 scope 内** → 立刻返回与「员工不存在」完全相同的一句话。
   *
   * 不加这道，下面「新旧值相同则跳过校验」的设计会变成一个**归属信息 oracle**：
   * 拿 scope 外的员工编号反复提交不同的 storeId —— 猜错返回「无权将员工调至该门店」，
   * 猜中其真实旧门店时因 `next === old` 跳过校验、最终由 UPDATE 命中 0 行返回
   * 「员工不存在或无权修改」。两句话的差异就能枚举出任意员工的真实归属（orgNodeId 同理）。
   *
   * 「不存在」与「存在但不可见」必须**合并**成同一个立即返回分支。
   * 只拦后者、让前者继续往下走是不够的（codex 谱系第 2 轮）—— 那只是把 oracle 从
   * 「归属值」换成了「employeeId 是否存在」：带乐观锁时不存在的记录会一路走到
   * UPDATE 后返回「数据已被其他人修改」，不带乐观锁且提交 scope 外归属时会返回
   * 「无权将员工调至该门店」，而且它多跑了一次 `db.update`（调用次数/耗时差异）。
   * 现在两者逐字同一句话、且都零写入。
   *
   * 可见性判据用 `isEmployeeRowVisible` —— 它与 `employeeScopeCondition` 在
   * permissions.ts 里紧邻定义、由一条交叉验证用例钉住同源。原先是在这里手工复刻 OR 语义，
   * 无任何机制保证两边不漂移（GLM 谱系指出）。
   */
  if (!currentEmployee || !isEmployeeRowVisible(session, oldStoreId, oldOrgNodeId)) {
    return { success: false, message: '员工不存在或无权修改' }
  }


  /**
   * 归属变更的 scope 校验（#228）。
   *
   * 下面的 `scopeCond` 只约束**旧**记录在不在 scope 内，对 `data.storeId` / `data.orgNodeId`
   * 这两个**新**值零校验 —— 于是一个只被授予单门店 scope 的 manager 可以把本店员工「调」到
   * 系统内任意门店，而 §AFF-03 还会把该员工自身角色绑定的 `permission_roles.scope_id`
   * 一并搬到目标门店。前端下拉只列 scope 内门店，但 Server Action 是可直调的安全边界。
   *
   * 必须放在这里而非函数开头：判「是否真的发生变更」需要先读到旧值。此处仍早于任何写入。
   *
   * 空串归一为 null：前端 `employee-detail-page.tsx` 已做 `form.storeId || null`，但
   * `createEmployee` 用的是 truthiness 判断（`data.storeId &&`），两边口径必须一致，
   * 否则新调用方传 `''` 在 create 侧是「不填」、在 update 侧却撞出一句误导性的「无权…」。
   */
  const nextStoreId = data.storeId === undefined ? oldStoreId : (data.storeId || null)
  const nextOrgNodeId = data.orgNodeId === undefined ? oldOrgNodeId : (data.orgNodeId || null)

  /**
   * ① 只在新值 `!== 旧值` 时校验 —— 编辑表单会把未改动的归属字段一并回传，
   *    对 no-op 提交报「无权」是纯误伤。且旧值若不在 scope 内，`scopeCond` 会让 UPDATE 命中 0 行兜底。
   */
  if (nextStoreId !== oldStoreId && nextStoreId !== null && !isInScope(session, nextStoreId)) {
    return { success: false, message: '无权将员工调至该门店' }
  }
  if (nextOrgNodeId !== oldOrgNodeId && nextOrgNodeId !== null
      && !isOrgNodeInScope(session, nextOrgNodeId)) {
    return { success: false, message: '无权将员工调至该组织节点' }
  }
  /**
   * ② 变更后该员工必须**仍在操作者的可见范围内**（非 admin）。
   *
   *    `employeeScopeCondition` 是 `store_id ∈ scope` **OR** `org_node_id ∈ scope`，
   *    一旦变更后两个维度都不命中，这一步就**不可逆** —— 操作者自己也看不见了，想改回去
   *    UPDATE 会命中 0 行。更要命的是 `permission_roles` 一字不动：清角色只发生在
   *    `isResigned === true` 分支，§AFF-03 也只在 storeId 变更时跑。于是任何持
   *    `employee:update` 的人都能把一个**仍持有效角色、仍能登录**的账号从所有非 admin 的
   *    员工名册里永久抹掉 —— 这是审计盲区，不是显示问题。
   *
   *    写成「变更后仍可见」而非「两端不能都空」是因为后者漏掉了一整类（GLM 谱系发现）：
   *    员工 `(storeId=本店, orgNodeId=外市场节点)` 靠 store 维度可见，单清 storeId 后
   *    另一端虽非空却在 scope 外 —— 同样永久消失。两种情形现在由同一条不变量覆盖。
   *
   *    与合法场景完全兼容：市场级 manager 转市场直属岗时 orgNodeId 设的是自己 scope 内的
   *    市场节点，`stillVisible` 成立。校验①（逐字段拦越权新值）与本条（拦不可逆消失）
   *    互补且都必要：①防搬到别人那儿，②防搬到没人那儿。
   *
   *    只在归属**确实发生变更**时判；历史上就不可见的存量员工已被上面的 oldRowVisible 拦住。
   */
  const ownershipChanged = nextStoreId !== oldStoreId || nextOrgNodeId !== oldOrgNodeId
  const stillVisible = (!!nextStoreId && isInScope(session, nextStoreId))
    || (!!nextOrgNodeId && isOrgNodeInScope(session, nextOrgNodeId))
  if (!isAdminScope(session) && ownershipChanged && !stillVisible) {
    return {
      success: false,
      message: !nextStoreId && !nextOrgNodeId
        ? '员工必须归属门店或组织节点之一'
        : '变更后该员工将不在你的管理范围内，请先转交给有权管理该归属的同事',
    }
  }

  /**
   * #259：归属自洽。只在归属**确实变更**时查 —— 存量的 15 个不匹配记录里有 13 个是合法的
   * 矩阵式归属，no-op 回传不该被拦；那 2 个跨门店挂载的脏数据也因此不会变成「不可编辑」。
   */
  if (ownershipChanged) {
    const conflict = await assertOwnershipConsistent(nextStoreId, nextOrgNodeId)
    if (conflict) return { success: false, message: conflict }
  }

  /**
   * 手机号唯一性**不再做事务外预查重** —— 交给 DB 的 `uq_staff_users_phone`
   * （partial unique index，`WHERE phone IS NOT NULL`）+ 下面的 23505 转译。
   *
   * 原因是那次预查是**全表**查询，无论排在哪里都会留下零写入信道（codex 谱系连追五轮）：
   *   - 排在可见性拦截前 → 任意 employeeId 即可探测，且因带 `employee_id != $target`
   *     还能确认「手机号 P 属于哪个 employeeId」；
   *   - 移到可见性后 → 可见员工 + 越界门店，两条路径都零写入；
   *   - 再移到归属校验后 → **仍有**乐观锁命中 0 行、离职前 admin 守卫这些零写入失败路径可配对。
   * 只要它排在任何可能失败的步骤之前，就总能找到同构变体。删掉它，冲突必须由真实的 UPDATE
   * 触发，探测就得付出「真的改掉目标员工手机号」的代价 —— 那是唯一约束本身的固有语义。
   */

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
  // #228：归属字段写库值必须与上面校验用的归一值一致，否则 `''` 会按 null 过校验却按 `''` 入库
  if (data.storeId !== undefined) updateData.storeId = nextStoreId
  if (data.orgNodeId !== undefined) updateData.orgNodeId = nextOrgNodeId
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
  if (nextStoreId && oldStoreId && nextStoreId !== oldStoreId) {
    const [oldStore] = await db
      .select({ orgNodeId: stores.orgNodeId })
      .from(stores)
      .where(eq(stores.storeId, oldStoreId))
      .limit(1)
    const [newStore] = await db
      .select({ orgNodeId: stores.orgNodeId })
      .from(stores)
      .where(eq(stores.storeId, nextStoreId))
      .limit(1)

    /**
     * #228：旧门店也必须在操作者 scope 内，否则这段会**越权改写 permission_roles**。
     *
     * `scopeCond` 是 `store_id ∈ scope` **OR** `org_node_id ∈ scope` —— 员工靠 org_node_id
     * 命中即可通过，此时它的 `store_id` 完全可以指向操作者看不见的门店。于是：
     * 一个只有 S1 的门店 manager，对「store_id=S9（外店）、org_node_id=orgS1（本店节点）」
     * 的员工调用 `updateEmployee(E, { storeId: 'S1' })` —— 新门店校验通过、行也可见，
     * 接着这段会执行 `UPDATE permission_roles SET scope_id=orgS1 WHERE scope_id=orgS9`：
     * 既**剥夺**了该员工对 S9 的角色，又**授予**了他对 S1 的角色。而 manager
     * 根本不持有 `permission:assign` / `permission:revoke`。
     *
     * 不在 scope 内就跳过同步（员工归属照改，只是不动那条角色绑定），留给有权者显式处理。
     */
    if (!isInScope(session, oldStoreId)) {
      await logOperation(session, 'permission.scopeSync.skipped', 'permission_role', employeeId, {
        reason: 'old_store_out_of_scope', oldStoreId, newStoreId: nextStoreId,
      })
    } else if (oldStore?.orgNodeId && newStore?.orgNodeId) {
      /**
       * #249：**允许多绑定** —— 调店不得删除或合并任何角色绑定。口径已拍板（见 issue 评论）。
       *
       * 生产数据：31 个「员工 × 角色」对持有多条 scope 绑定，最多的一个 manager 绑 5 个门店、
       * 另有两人各绑 6 个。**多店兼任是常态，不是异常**。所以原先无条件
       * `UPDATE … SET scope_id = 新店 WHERE scope_id = 旧店` 有两个问题：
       *   ① 旧店有多条绑定时，无从判断该动哪条；
       *   ② 目标店已有同角色时直接撞 `uq_perm_roles_emp_role_scope`（23505）——
       *      而员工行 UPDATE 已经提交，于是「人调过去了、角色没同步、调用方收到失败」。
       *
       * 现在只在**唯一无歧义的搬迁场景**下动它：某角色在旧店有绑定、而目标店没有同角色。
       * （`uq_perm_roles_emp_role_scope` 保证 (employee, role, scope) 唯一，所以「旧店该角色的绑定」
       * 天然最多一条 —— 代码里没有、也不需要计数判断。）
       * 其余一律一条都不动 + 写审计，留给有权者（持 permission:assign/revoke）显式处理。
       * 这样不删除任何绑定、不扩大授权，31 个兼任员工的调店既不失败也不丢权。
       *
       * ⚠️ **不要**把这段读成「唯一键冲突已彻底消除」：SELECT 与 UPDATE 之间没有锁，
       * 并发授权仍可能撞 23505 —— 那条窗口由下面循环里的 per-row catch 降级处理。
       * 冲突窗口只是被收窄到「并发 assignRole」，不是没有了。
       *
       * ⚠️ 顺带接受一个结果：#249 问题 2 的「两步绕过」（先 storeId→null 再设新值，
       * 绑定永远停在旧门店）在这个口径下**不再是缺陷** —— 绑定停在旧门店本身就是允许的状态。
       */
      const bindings = await db
        .select({ id: permissionRoles.id, role: permissionRoles.role, scopeId: permissionRoles.scopeId })
        .from(permissionRoles)
        .where(and(
          eq(permissionRoles.employeeId, employeeId),
          inArray(permissionRoles.scopeId, [oldStore.orgNodeId, newStore.orgNodeId]),
        ))

      const atOld = bindings.filter((b) => b.scopeId === oldStore.orgNodeId)
      const rolesAtNew = new Set(bindings.filter((b) => b.scopeId === newStore.orgNodeId).map((b) => b.role))
      // 仅搬「旧店独此一条、且新店没有同角色」的那些
      const movable = atOld.filter((b) => !rolesAtNew.has(b.role))
      const blocked = atOld.filter((b) => rolesAtNew.has(b.role))

      const raced: string[] = []
      for (const b of movable) {
        /**
         * per-row catch 不可省。SELECT 与这些 UPDATE 之间没有锁 ——
         * 并发的 `assignRole(emp, role, 新店节点)` 落在这个窗口里，`rolesAtNew` 就是过期快照，
         * UPDATE 会撞 `uq_perm_roles_emp_role_scope`。不 catch 的后果比改动前更糟：
         * 员工行 UPDATE 早已提交，异常直接穿出 `updateEmployee` 变成 500，
         * 而改动前至少会走下面那个 23505 转译返回「数据冲突，请稍后重试」。
         * `movable.length > 1` 时还会出现「搬了一半、审计只记一半、请求抛异常」。
         *
         * 降级为与「目标店已有同角色」相同的处理（不动那条 + 记审计）——
         * 在「允许多绑定」口径下这两种情形的结果是一样的：该角色留在旧门店，属允许状态。
         */
        try {
          await db
            .update(permissionRoles)
            .set({ scopeId: newStore.orgNodeId, updatedBy: session.employeeId })
            .where(eq(permissionRoles.id, b.id))
        } catch (err: unknown) {
          if (pgErrorCode(err) === '23505') { raced.push(b.role); continue }
          throw err
        }
        await logOperation(session, 'permission.scopeSync', 'permission_role', employeeId, {
          oldStoreId, newStoreId: nextStoreId,
          oldScopeId: oldStore.orgNodeId, newScopeId: newStore.orgNodeId, role: b.role,
        })
      }
      if (raced.length > 0) {
        await logOperation(session, 'permission.scopeSync.skipped', 'permission_role', employeeId, {
          reason: 'role_already_bound_at_target', oldStoreId, newStoreId: nextStoreId,
          roles: raced, concurrent: true,
        })
      }
      if (blocked.length > 0) {
        await logOperation(session, 'permission.scopeSync.skipped', 'permission_role', employeeId, {
          reason: 'role_already_bound_at_target', oldStoreId, newStoreId: nextStoreId,
          roles: blocked.map((b) => b.role),
        })
      }
      /**
       * #249 问题 3：原先只在 `count > 0` 时写日志，「本来就没有绑定」与
       * 「被并发改掉了」都静默。现在无绑定可搬也留一条痕。
       */
      if (atOld.length === 0) {
        await logOperation(session, 'permission.scopeSync.skipped', 'permission_role', employeeId, {
          reason: 'no_binding_at_old_store', oldStoreId, newStoreId: nextStoreId,
        })
      }
    }
  }

  // #228：传 updateData 而非原始 data —— 归属空串已归一为 null、resignedAt/resignationReason
  // 由 action 自动推导，只有 updateData 才等于真正写进库的那一组值；传 data 会让审计 diff 失真
  await logUpdate(session, 'employee.update', 'employee', employeeId, currentEmployee as Record<string, unknown>, updateData)
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
