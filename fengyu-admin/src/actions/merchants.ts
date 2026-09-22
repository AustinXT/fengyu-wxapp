'use server'

import { db } from '@/db'
import { lakalaMerchants } from '@db/lakala'
import { stores, orgNodes } from '@db/org'
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { withPermission } from '@/lib/with-permission'
import { isAdminScope, expandVisibleMarketIds, requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import type { AuthSession } from '@/lib/types'

/**
 * 商户管理（拉卡拉收款商户档案，独立模块 /merchants）server actions。
 *
 * 商户（lakala_merchants）是无 store_id 的集中收款配置实体，门店通过
 * stores.lakala_merchant_id（N:1）反向关联。为保证非 admin 的数据隔离，本模块按
 * market_org_node_id 做市场范围过滤：市场范围外及未分配市场的商户均不可见、不可修改；
 * 总部 scope 和 admin 保持全开。
 *
 * 收款字段权威仍是本表：clientApi resolveLakalaMerchant 运行时 JOIN 实时读，本页改动
 * （enabled / term_no / merchant_no）立即对收款生效；删除经外键 ON DELETE SET NULL 会
 * 使关联门店收款失效，故 deleteMerchant 仅允许删「无门店引用」的商户。
 */

/** 生成 lm_ 前缀 KSUID（与 stores.ts 建档同格式：{prefix}{8 位时间戳}{12 位随机}） */
function ksuid(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000).toString(36).padStart(8, '0')
  const rand = randomBytes(6).toString('hex')
  return `${prefix}${ts}${rand}`
}

// ============================================================================
// 列表（/merchants 页面）
// ============================================================================

export type MerchantEnabledFilter = 'all' | 'enabled' | 'disabled'

export interface MerchantFilters {
  search?: string
  enabled?: MerchantEnabledFilter
  /** 市场筛选：org_nodes type='市场' 节点 id */
  marketId?: string
  /** 门店筛选：stores.store_id（通过 lakala_merchant_id 反向过滤商户）*/
  storeId?: string
  page?: number
  pageSize?: number
}

export interface AdminMerchant {
  id: string
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
  /** 所属市场名（market_org_node_id → org_nodes.name），未分配为 null */
  marketName: string | null
  /** 关联门店数（stores.lakala_merchant_id 反查） */
  storeCount: number
  /** 关联门店简称，多个门店以「、」分隔（stores.store_name 聚合） */
  storeNames: string | null
  createdAt: string
  updatedAt: string
}

export interface PaginatedMerchants {
  data: AdminMerchant[]
  total: number
}

interface MerchantMarketScope {
  condition: SQL | undefined
  /** null 表示 admin 或总部级非 admin，可访问全部市场。 */
  visibleMarketIds: string[] | null
}

/** 非 admin 仅可访问已分配到其可见市场的商户；总部 scope 保持全开。 */
async function resolveMerchantMarketScope(session: AuthSession): Promise<MerchantMarketScope> {
  const visibleMarketIds = isAdminScope(session) ? null : await expandVisibleMarketIds(session)
  if (visibleMarketIds === null) return { condition: undefined, visibleMarketIds }
  if (visibleMarketIds.length === 0) return { condition: sql`FALSE`, visibleMarketIds }
  return {
    condition: inArray(lakalaMerchants.marketOrgNodeId, visibleMarketIds),
    visibleMarketIds,
  }
}

function canAssignMerchantMarket(scope: MerchantMarketScope, marketOrgNodeId: string | null): boolean {
  return scope.visibleMarketIds === null
    || (marketOrgNodeId !== null && scope.visibleMarketIds.includes(marketOrgNodeId))
}

/**
 * 服务端分页商户列表 + 关联门店数。
 * 权限：merchant:list（admin + finance + manager）。
 *
 * scope 过滤：
 * - admin 全开
 * - 非 admin：仅看 scope 内市场的商户（通过 market_org_node_id）
 * - 市场为空或 scope 外的商户对非 admin 隐藏
 *
 * 门店筛选（前端传入，所有角色）：
 * - 通过 stores.lakala_merchant_id 反向过滤，只显示该门店关联的商户
 */
export const getMerchantsPaginated = withPermission(
  'merchant:list',
  async (session, filters: MerchantFilters = {}): Promise<PaginatedMerchants> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = []
    // 商户名 / 商户号 ILIKE 搜索
    if (filters.search) {
      const escaped = filters.search.replace(/[%_]/g, '\\$&')
      const pattern = `%${escaped}%`
      conditions.push(
        or(
          ilike(lakalaMerchants.merchantName, pattern),
          ilike(lakalaMerchants.merchantNo, pattern),
        ),
      )
    }
    if (filters.enabled === 'enabled') conditions.push(eq(lakalaMerchants.enabled, true))
    else if (filters.enabled === 'disabled') conditions.push(eq(lakalaMerchants.enabled, false))

    // 严格市场 scope：非 admin 仅见 scope 内市场，未分配市场同样不可见。
    const { condition: marketScope } = await resolveMerchantMarketScope(session)
    if (marketScope !== undefined) conditions.push(marketScope)
    // 市场筛选（所有角色含 admin）
    if (filters.marketId) conditions.push(eq(lakalaMerchants.marketOrgNodeId, filters.marketId))

    // 门店筛选（所有角色含 admin）：通过 stores.lakala_merchant_id 反向过滤
    if (filters.storeId) {
      const [store] = await db
        .select({ lakalaMerchantId: stores.lakalaMerchantId })
        .from(stores)
        .where(eq(stores.storeId, filters.storeId))
        .limit(1)
      if (!store || !store.lakalaMerchantId) {
        // 门店不存在或未关联商户，返回空
        return { data: [], total: 0 }
      }
      conditions.push(eq(lakalaMerchants.id, store.lakalaMerchantId))
    }

    const whereClause = conditions.length ? and(...conditions) : undefined

    // COUNT 仅过滤 lakala_merchants 自身列，无需 JOIN
    const countQuery = db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(lakalaMerchants)
      .where(whereClause)

    // DATA：LEFT JOIN stores 统计关联门店数，同时聚合门店简称供列表直接展示（避免 N+1 查询）
    const dataQuery = db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        termNo: lakalaMerchants.termNo,
        enabled: lakalaMerchants.enabled,
        // 所属市场名（标量子查询，避开 groupBy 复杂度；id 为 PK，functional dependency 允许）
        marketName: sql<string | null>`(SELECT n.name FROM org_nodes n WHERE n.id = ${lakalaMerchants.marketOrgNodeId})`,
        createdAt: lakalaMerchants.createdAt,
        updatedAt: lakalaMerchants.updatedAt,
        storeCount: sql<number>`cast(count(${stores.storeId}) as int)`,
        storeNames: sql<string | null>`string_agg(${stores.storeName}, '、' ORDER BY ${stores.storeName})`,
      })
      .from(lakalaMerchants)
      .leftJoin(stores, eq(stores.lakalaMerchantId, lakalaMerchants.id))
      .where(whereClause)
      .groupBy(lakalaMerchants.id)
      // 配置型「编辑即浮顶」
      .orderBy(desc(lakalaMerchants.updatedAt), desc(lakalaMerchants.id))
      .limit(pageSize)
      .offset(offset)

    const [[countRow], rows] = await Promise.all([countQuery, dataQuery])

    return {
      data: rows.map((r) => ({
        id: r.id,
        merchantName: r.merchantName,
        merchantNo: r.merchantNo ?? null,
        termNo: r.termNo ?? null,
        enabled: r.enabled,
        marketName: r.marketName ?? null,
        storeCount: r.storeCount ?? 0,
        storeNames: r.storeNames ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total: countRow?.count ?? 0,
    }
  },
)

// ============================================================================
// 详情（/merchants/[id] 页面）
// ============================================================================

export interface MerchantLinkedStore {
  storeId: string
  storeName: string
  marketName: string | null
}

export interface MerchantDetail {
  id: string
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
  /** 所属市场（org_nodes type='市场' id），未分配为 null；编辑表单回显用 */
  marketOrgNodeId: string | null
  /** 所属市场名 */
  marketName: string | null
  createdAt: string
  updatedAt: string
  linkedStores: MerchantLinkedStore[]
}

export const getMerchantById = withPermission(
  'merchant:list',
  async (session, id: string): Promise<MerchantDetail | null> => {
    if (!id) return null
    const { condition: marketScope } = await resolveMerchantMarketScope(session)
    const [m] = await db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        termNo: lakalaMerchants.termNo,
        enabled: lakalaMerchants.enabled,
        marketOrgNodeId: lakalaMerchants.marketOrgNodeId,
        marketName: sql<string | null>`(SELECT n.name FROM org_nodes n WHERE n.id = ${lakalaMerchants.marketOrgNodeId})`,
        createdAt: lakalaMerchants.createdAt,
        updatedAt: lakalaMerchants.updatedAt,
      })
      .from(lakalaMerchants)
      .where(and(eq(lakalaMerchants.id, id), marketScope))
      .limit(1)
    if (!m) return null

    // 关联门店 + 市场名（标量子查询，跨两级 org_nodes 取上级 market）
    const marketNameExpr = sql<string | null>`(
      SELECT n.name FROM org_nodes sn
      JOIN org_nodes n ON n.id = sn.parent_id
      WHERE sn.id = ${stores.orgNodeId}
    )`.as('market_name')

    const linked = await db
      .select({
        storeId: stores.storeId,
        storeName: stores.storeName,
        marketName: marketNameExpr,
      })
      .from(stores)
      .where(eq(stores.lakalaMerchantId, id))
      .orderBy(asc(stores.storeName))

    return {
      id: m.id,
      merchantName: m.merchantName,
      merchantNo: m.merchantNo ?? null,
      termNo: m.termNo ?? null,
      enabled: m.enabled,
      marketOrgNodeId: m.marketOrgNodeId ?? null,
      marketName: m.marketName ?? null,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      linkedStores: linked.map((s) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        marketName: s.marketName ?? null,
      })),
    }
  },
)

// ============================================================================
// 门店页下拉数据源（关联收款商户）
//
// 权限用 store:lakala_config（非 merchant:list）：门店编辑/新增页访问者是 admin/hr，
// hr 无 merchant 权限；与门店「选择关联商户」的编辑权限（store:lakala_config）对齐。
// ============================================================================

export interface MerchantOption {
  id: string
  merchantName: string
  merchantNo: string | null
  enabled: boolean
}

export const getMerchantOptions = withPermission(
  'store:lakala_config',
  async (session): Promise<MerchantOption[]> => {
    const { condition: marketScope } = await resolveMerchantMarketScope(session)
    const rows = await db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        enabled: lakalaMerchants.enabled,
      })
      .from(lakalaMerchants)
      .where(marketScope)
      .orderBy(asc(lakalaMerchants.merchantName))
    return rows.map((r) => ({
      id: r.id,
      merchantName: r.merchantName,
      merchantNo: r.merchantNo ?? null,
      enabled: r.enabled,
    }))
  },
)

// ============================================================================
// 市场下拉数据源（商户管理列表筛选 + 新建/编辑表单「所属市场」）
//
// 权限用 merchant:list（admin + finance + manager 持有）。finance/manager 无 commission:list，
// 不能复用 commission.getMarkets，故本函数对齐其 scope 过滤范式（expandVisibleMarketIds）。
// ============================================================================

export interface MerchantMarketOption {
  id: string
  name: string
}

export const getMerchantMarketOptions = withPermission(
  'merchant:list',
  async (session): Promise<MerchantMarketOption[]> => {
    const visibleIds = await expandVisibleMarketIds(session)
    // 非总部且无可见市场 → 无市场可选
    if (visibleIds !== null && visibleIds.length === 0) return []
    const scopeCond = visibleIds === null ? undefined : inArray(orgNodes.id, visibleIds)
    const rows = await db
      .select({ id: orgNodes.id, name: orgNodes.name })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, '市场'), scopeCond))
      .orderBy(asc(orgNodes.sortOrder))
    return rows.map((r) => ({ id: r.id, name: r.name }))
  },
)

// ============================================================================
// 写入：新建 / 编辑 / 删除
// ============================================================================

export interface MerchantInput {
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
  /** 所属市场（org_nodes type='市场' id）；可选，未分配/未传为 null */
  marketOrgNodeId?: string | null
}

/**
 * 共用入参校验。返回错误文案（前端 toast）或 null。
 * 启用真实支付通道时商户号 + 终端号必填：缺商户号收款失效、缺 term_no 会在
 * clientApi 支付时抛 LAKALA_TERM_NO_MISSING，配置期强制拦截。
 */
function validateMerchantInput(data: MerchantInput): string | null {
  if (!data.merchantName?.trim()) return '商户名称必填'
  if (data.enabled) {
    if (!data.merchantNo?.trim()) return '启用真实支付通道时，拉卡拉商户号必填'
    if (!data.termNo?.trim()) return '启用真实支付通道时，终端号(term_no)必填'
  }
  return null
}

export const createMerchant = withPermission(
  'merchant:create',
  async (session, data: MerchantInput): Promise<{ success: boolean; message: string; id?: string }> => {
    const err = validateMerchantInput(data)
    if (err) return { success: false, message: err }

    const merchantName = data.merchantName.trim()
    const merchantNo = data.merchantNo?.trim() || null
    const termNo = data.termNo?.trim() || null
    const marketOrgNodeId = data.marketOrgNodeId || null

    const marketScope = await resolveMerchantMarketScope(session)
    if (!canAssignMerchantMarket(marketScope, marketOrgNodeId)) {
      return { success: false, message: '无权将商户分配到该市场' }
    }

    // 商户号唯一校验（应用层；DB partial unique index 兜底）
    if (merchantNo) {
      const dup = await db
        .select({ id: lakalaMerchants.id })
        .from(lakalaMerchants)
        .where(eq(lakalaMerchants.merchantNo, merchantNo))
        .limit(1)
      if (dup.length) return { success: false, message: `商户号 ${merchantNo} 已被其他商户占用` }
    }

    const id = ksuid('lm_')
    try {
      await db.insert(lakalaMerchants).values({ id, merchantName, merchantNo, termNo, enabled: data.enabled, marketOrgNodeId })
    } catch (e) {
      if (pgErrorCode(e) === '23505') return { success: false, message: `商户号 ${merchantNo} 已被其他商户占用` }
      throw e
    }

    await logOperation(session, 'merchant.create', 'lakala_merchant', id, {
      merchantName,
      merchantNo,
      termNo,
      enabled: data.enabled,
      marketOrgNodeId,
    })
    revalidatePath('/merchants')
    return { success: true, message: '商户已创建', id }
  },
)

export const updateMerchant = withPermission(
  'merchant:update',
  async (
    session,
    id: string,
    data: MerchantInput,
    /** 乐观锁：提交时携带的 updated_at（ISO） */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    if (!id) return { success: false, message: '商户不存在' }
    const err = validateMerchantInput(data)
    if (err) return { success: false, message: err }

    const merchantName = data.merchantName.trim()
    const merchantNo = data.merchantNo?.trim() || null
    const termNo = data.termNo?.trim() || null
    const marketOrgNodeId = data.marketOrgNodeId || null
    const marketScope = await resolveMerchantMarketScope(session)

    const [before] = await db
      .select()
      .from(lakalaMerchants)
      .where(and(eq(lakalaMerchants.id, id), marketScope.condition))
      .limit(1)
    if (!before) return { success: false, message: '商户不存在' }
    if (!canAssignMerchantMarket(marketScope, marketOrgNodeId)) {
      return { success: false, message: '无权将商户分配到该市场' }
    }

    // 商户号唯一校验（排除自身）
    if (merchantNo) {
      const dup = await db
        .select({ id: lakalaMerchants.id })
        .from(lakalaMerchants)
        .where(and(eq(lakalaMerchants.merchantNo, merchantNo), ne(lakalaMerchants.id, id)))
        .limit(1)
      if (dup.length) return { success: false, message: `商户号 ${merchantNo} 已被其他商户占用` }
    }

    // 乐观锁：PostgreSQL NOW() 有微秒精度，JS Date 仅毫秒精度，需 date_trunc 对齐
    const whereConditions = expectedUpdatedAt
      ? and(
          eq(lakalaMerchants.id, id),
          sql`date_trunc('milliseconds', ${lakalaMerchants.updatedAt}) = ${expectedUpdatedAt}`,
          marketScope.condition,
        )
      : and(eq(lakalaMerchants.id, id), marketScope.condition)

    let result: any
    try {
      result = await db
        .update(lakalaMerchants)
        .set({ merchantName, merchantNo, termNo, enabled: data.enabled, marketOrgNodeId })
        .where(whereConditions)
    } catch (e) {
      if (pgErrorCode(e) === '23505') return { success: false, message: `商户号 ${merchantNo} 已被其他商户占用` }
      throw e
    }
    if (result.count === 0) {
      return { success: false, message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商户不存在' }
    }

    await logUpdate(
      session,
      'merchant.update',
      'lakala_merchant',
      id,
      before as Record<string, unknown>,
      { merchantName, merchantNo, termNo, enabled: data.enabled, marketOrgNodeId },
    )
    revalidatePath('/merchants')
    revalidatePath(`/merchants/${id}`)
    return { success: true, message: '商户信息已更新' }
  },
)

export const deleteMerchant = withPermission(
  'merchant:delete',
  async (session, id: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    if (!id) return { success: false, message: '商户不存在' }
    const [before] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, id)).limit(1)
    if (!before) return { success: false, message: '商户不存在' }

    // 引用校验：有门店关联则禁止删除（避免 ON DELETE SET NULL 使门店收款失效）
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`cast(count(*) as int)` })
      .from(stores)
      .where(eq(stores.lakalaMerchantId, id))
    if (cnt > 0) {
      return {
        success: false,
        message: `该商户仍被 ${cnt} 个门店关联，请先在门店编辑页解除关联后再删除`,
      }
    }

    await db.delete(lakalaMerchants).where(eq(lakalaMerchants.id, id))
    await logOperation(session, 'merchant.delete', 'lakala_merchant', id, {
      merchantName: before.merchantName,
      merchantNo: before.merchantNo,
    })
    revalidatePath('/merchants')
    return { success: true, message: '商户已删除' }
  },
)
