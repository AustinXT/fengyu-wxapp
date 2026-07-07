'use server'

import { db } from '@/db'
import { lakalaMerchants } from '@db/lakala'
import { stores, orgNodes } from '@db/org'
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { randomBytes } from 'crypto'
import { withPermission } from '@/lib/with-permission'
import { isAdminScope, expandVisibleMarketIds } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'




function ksuid(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000).toString(36).padStart(8, '0')
  const rand = randomBytes(6).toString('hex')
  return `${prefix}${ts}${rand}`
}





export type MerchantEnabledFilter = 'all' | 'enabled' | 'disabled'

export interface MerchantFilters {
  search?: string
  enabled?: MerchantEnabledFilter
  
  marketId?: string
  page?: number
  pageSize?: number
}

export interface AdminMerchant {
  id: string
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
  
  marketName: string | null
  
  storeCount: number
  createdAt: string
  updatedAt: string
}

export interface PaginatedMerchants {
  data: AdminMerchant[]
  total: number
}


export const getMerchantsPaginated = withPermission(
  'merchant:list',
  async (session, filters: MerchantFilters = {}): Promise<PaginatedMerchants> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = []
    
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

    
    
    if (!isAdminScope(session)) {
      const visibleMarketIds = await expandVisibleMarketIds(session)
      if (visibleMarketIds === null) {
        
      } else if (visibleMarketIds.length === 0) {
        conditions.push(sql`FALSE`)
      } else {
        conditions.push(inArray(lakalaMerchants.marketOrgNodeId, visibleMarketIds))
      }
    }
    
    if (filters.marketId) conditions.push(eq(lakalaMerchants.marketOrgNodeId, filters.marketId))

    const whereClause = conditions.length ? and(...conditions) : undefined

    
    const countQuery = db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(lakalaMerchants)
      .where(whereClause)

    
    const dataQuery = db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        termNo: lakalaMerchants.termNo,
        enabled: lakalaMerchants.enabled,
        
        marketName: sql<string | null>`(SELECT n.name FROM org_nodes n WHERE n.id = ${lakalaMerchants.marketOrgNodeId})`,
        createdAt: lakalaMerchants.createdAt,
        updatedAt: lakalaMerchants.updatedAt,
        storeCount: sql<number>`cast(count(${stores.storeId}) as int)`,
      })
      .from(lakalaMerchants)
      .leftJoin(stores, eq(stores.lakalaMerchantId, lakalaMerchants.id))
      .where(whereClause)
      .groupBy(lakalaMerchants.id)
      
      .orderBy(desc(lakalaMerchants.updatedAt))
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
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total: countRow?.count ?? 0,
    }
  },
)





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
  
  marketOrgNodeId: string | null
  
  marketName: string | null
  createdAt: string
  updatedAt: string
  linkedStores: MerchantLinkedStore[]
}

export const getMerchantById = withPermission(
  'merchant:list',
  async (_session, id: string): Promise<MerchantDetail | null> => {
    if (!id) return null
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
      .where(eq(lakalaMerchants.id, id))
      .limit(1)
    if (!m) return null

    
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








export interface MerchantOption {
  id: string
  merchantName: string
  merchantNo: string | null
  enabled: boolean
}

export const getMerchantOptions = withPermission(
  'store:lakala_config',
  async (_session): Promise<MerchantOption[]> => {
    const rows = await db
      .select({
        id: lakalaMerchants.id,
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        enabled: lakalaMerchants.enabled,
      })
      .from(lakalaMerchants)
      .orderBy(asc(lakalaMerchants.merchantName))
    return rows.map((r) => ({
      id: r.id,
      merchantName: r.merchantName,
      merchantNo: r.merchantNo ?? null,
      enabled: r.enabled,
    }))
  },
)








export interface MerchantMarketOption {
  id: string
  name: string
}

export const getMerchantMarketOptions = withPermission(
  'merchant:list',
  async (session): Promise<MerchantMarketOption[]> => {
    const visibleIds = await expandVisibleMarketIds(session)
    
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





export interface MerchantInput {
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
  
  marketOrgNodeId?: string | null
}


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
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    if (!id) return { success: false, message: '商户不存在' }
    const err = validateMerchantInput(data)
    if (err) return { success: false, message: err }

    const merchantName = data.merchantName.trim()
    const merchantNo = data.merchantNo?.trim() || null
    const termNo = data.termNo?.trim() || null
    const marketOrgNodeId = data.marketOrgNodeId || null

    const [before] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, id)).limit(1)
    if (!before) return { success: false, message: '商户不存在' }

    
    if (merchantNo) {
      const dup = await db
        .select({ id: lakalaMerchants.id })
        .from(lakalaMerchants)
        .where(and(eq(lakalaMerchants.merchantNo, merchantNo), ne(lakalaMerchants.id, id)))
        .limit(1)
      if (dup.length) return { success: false, message: `商户号 ${merchantNo} 已被其他商户占用` }
    }

    
    const whereConditions = expectedUpdatedAt
      ? and(
          eq(lakalaMerchants.id, id),
          sql`date_trunc('milliseconds', ${lakalaMerchants.updatedAt}) = ${expectedUpdatedAt}`,
        )
      : eq(lakalaMerchants.id, id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle update 返回类型宽松，与 stores.ts 一致
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
    if (!id) return { success: false, message: '商户不存在' }
    const [before] = await db.select().from(lakalaMerchants).where(eq(lakalaMerchants.id, id)).limit(1)
    if (!before) return { success: false, message: '商户不存在' }

    
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
