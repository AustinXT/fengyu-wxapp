'use server'

import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { alias } from 'drizzle-orm/pg-core'
import type { Store } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isAdminScope } from '@/lib/permissions'
import type { AuthSession } from '@/lib/types'
import { logOperation, logUpdate } from '@/lib/operation-log'

const storeNode = alias(orgNodes, 'store_node')
const marketNode = alias(orgNodes, 'market_node')

function rowToStore(row: {
  stores: typeof stores.$inferSelect
  store_node: typeof orgNodes.$inferSelect | null
  market_node: typeof orgNodes.$inferSelect | null
}): Store {
  const s = row.stores
  return {
    storeId: s.storeId,
    storeName: s.storeName,
    orgNodeId: s.orgNodeId,
    openingDate: s.openingDate,
    bedCount: s.bedCount,
    isClosed: s.isClosed,
    coverImage: s.coverImage,
    images: s.images,
    district: s.district,
    streetAddress: s.streetAddress,
    latitude: s.latitude,
    longitude: s.longitude,
    phone: s.phone,
    businessHours: s.businessHours,
    description: s.description,
    announcement: s.announcement,
    parkingInfo: s.parkingInfo,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    marketName: row.market_node?.name ?? undefined,
  }
}

export async function getStores(): Promise<Store[]> {
  const session = await getSession()
  requirePermission(session, 'store:list')

  const rows = await db
    .select()
    .from(stores)
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(scopeCondition(session, stores.storeId))
    // 例外：选择器场景占主导（本 action 同时用作 /stores 主列表与 15+ 处筛选下拉），门店是低变更频率实体，字母序对下拉选择更稳定
    .orderBy(asc(stores.storeName))
    .limit(200)

  return rows.map(rowToStore)
}

export async function getStoreById(storeId: string): Promise<Store | null> {
  const session = await getSession()
  requirePermission(session, 'store:list')

  const rows = await db
    .select()
    .from(stores)
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(and(eq(stores.storeId, storeId), scopeCondition(session, stores.storeId)))

  if (rows.length === 0) return null
  return rowToStore(rows[0])
}

export async function createStore(data: {
  storeId: string
  storeName: string
  marketId: string  // 所属市场的 org_node id（必填）
  openingDate?: string | null
  bedCount?: number | null
  isClosed?: boolean
  coverImage?: string | null
  images?: string[] | null
  district?: string | null
  streetAddress?: string | null
  latitude?: string | null
  longitude?: string | null
  phone?: string | null
  businessHours?: string | null
  description?: string | null
  announcement?: string | null
  parkingInfo?: string | null
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'store:create')

  // scope 隔离：非 admin 只能在自己 scope 的市场下创建门店
  if (!isAdminScope(session)) {
    const scopeIds = new Set(session.roles.map((r: AuthSession['roles'][number]) => r.scopeId))
    if (!scopeIds.has(data.marketId)) {
      return { success: false, message: '无权在该市场下创建门店' }
    }
  }

  // 事务：org_node + stores 原子创建，失败则全部回滚
  const orgNodeId = `store-${data.storeId}`
  try {
    await db.transaction(async (tx) => {
      await tx.insert(orgNodes).values({
        id: orgNodeId,
        name: data.storeName,
        type: '门店',
        parentId: data.marketId,
        sortOrder: 0,
        isActive: true,
      })

      await tx.insert(stores).values({
        storeId: data.storeId,
        storeName: data.storeName,
        orgNodeId,
        openingDate: data.openingDate ?? null,
        bedCount: data.bedCount ?? null,
        isClosed: data.isClosed ?? false,
        coverImage: data.coverImage ?? null,
        images: data.images ?? null,
        district: data.district ?? null,
        streetAddress: data.streetAddress ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        phone: data.phone ?? null,
        businessHours: data.businessHours ?? null,
        description: data.description ?? null,
        announcement: data.announcement ?? null,
        parkingInfo: data.parkingInfo ?? null,
      })
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '门店编号已存在' }
    if (err?.code === '23503') return { success: false, message: '所属市场不存在，请刷新后重试' }
    throw err
  }

  await logOperation(session, 'store.create', 'store', data.storeId, { storeName: data.storeName, orgNodeId })
  revalidatePath('/stores')
  return { success: true, message: '门店创建成功' }
}

export async function updateStore(
  storeId: string,
  data: Partial<{
    storeName: string
    orgNodeId: string | null
    openingDate: string | null
    bedCount: number | null
    isClosed: boolean
    coverImage: string | null
    images: string[] | null
    district: string | null
    streetAddress: string | null
    latitude: string | null
    longitude: string | null
    phone: string | null
    businessHours: string | null
    description: string | null
    announcement: string | null
    parkingInfo: string | null
  }>,
  /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'store:update')

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(stores).where(eq(stores.storeId, storeId)).limit(1)

  // 乐观锁 + scope 隔离：WHERE store_id = $1 [AND updated_at = $2] [AND scope]
  // 注意：PostgreSQL NOW() 有微秒精度，JS Date 仅毫秒精度，需 date_trunc 对齐
  const scopeCond = scopeCondition(session, stores.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(eq(stores.storeId, storeId), sql`date_trunc('milliseconds', ${stores.updatedAt}) = ${expectedUpdatedAt}`, scopeCond)
    : and(eq(stores.storeId, storeId), scopeCond)

  let result: any
  try {
    result = await db.update(stores).set(data).where(whereConditions)
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '门店不存在',
    }
  }

  await logUpdate(session, 'store.update', 'store', storeId, before as Record<string, unknown>, data)
  revalidatePath('/stores')
  return { success: true, message: '门店信息已更新' }
}

/** 根据门店 ID 获取同市场下所有门店 ID（含自身） */
export async function getMarketStoreIds(storeId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT s2.store_id
    FROM stores s1
    JOIN org_nodes sn1 ON s1.org_node_id = sn1.id
    JOIN org_nodes sn2 ON sn2.parent_id = sn1.parent_id AND sn2.type = '门店'
    JOIN stores s2 ON s2.org_node_id = sn2.id
    WHERE s1.store_id = ${storeId}
  `)
  const ids = (rows as any[]).map((r: any) => r.store_id as string)
  return ids.length > 0 ? ids : [storeId]
}
