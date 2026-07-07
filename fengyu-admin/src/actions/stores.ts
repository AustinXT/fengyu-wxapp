'use server'

import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { alias } from 'drizzle-orm/pg-core'
import type { Store } from '@/lib/types'
import { scopeCondition, hasPermission } from '@/lib/permissions'
import { isNodeInScope } from '@/lib/node-scope'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { shanghaiToday } from '@/lib/datetime'
import { lakalaMerchants } from '@db/lakala'


const storeNode = alias(orgNodes, 'store_node') as unknown as typeof orgNodes
const marketNode = alias(orgNodes, 'market_node') as unknown as typeof orgNodes



// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToStore(row: any): Store {
  const s = row.stores
  return {
    storeId: s.storeId,
    storeName: s.storeName,
    orgNodeId: s.orgNodeId,
    openingDate: s.openingDate,
    bedCount: s.bedCount,
    isClosed: s.isClosed,
    closedAt: s.closedAt,
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
    lakalaMerchantId: s.lakalaMerchantId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    marketName: row.market_node?.name ?? undefined,
  }
}

export const getStores = withPermission('store:list', async (session): Promise<Store[]> => {
  const rows = await db
    .select()
    .from(stores)
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(scopeCondition(session, stores.storeId))
    
    .orderBy(asc(stores.storeName))
    .limit(200)

  return rows.map(rowToStore)
})

export const getStoreById = withPermission(
  'store:list',
  async (session, storeId: string): Promise<Store | null> => {
    const rows = await db
      .select()
      .from(stores)
      .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
      .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
      .where(and(eq(stores.storeId, storeId), scopeCondition(session, stores.storeId)))

    if (rows.length === 0) return null
    return rowToStore(rows[0])
  },
)


export const getAvailableStoreNodes = withPermission(
  'store:create',
  async (session): Promise<Array<{ id: string; name: string; marketName: string }>> => {
    const rows = await db
      .select({
        id: storeNode.id,
        name: storeNode.name,
        marketName: marketNode.name,
        parentId: storeNode.parentId,
      })
      .from(storeNode)
      .leftJoin(stores, eq(stores.orgNodeId, storeNode.id))
      .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
      .where(and(eq(storeNode.type, '门店'), sql`${stores.storeId} IS NULL`))
      .orderBy(asc(marketNode.name), asc(storeNode.name))

    
    
    const visible: Array<{ id: string; name: string; marketName: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows as any[]) {
      if (await isNodeInScope(session, r.id)) {
        visible.push({ id: r.id, name: r.name, marketName: r.marketName ?? '' })
      }
    }
    return visible
  },
)

export const createStore = withPermission(
  'store:create',
  async (
    session,
    data: {
      storeId: string
      orgNodeId: string  
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
      
      lakalaMerchantId?: string | null
    },
  ): Promise<{ success: boolean; message: string }> => {
  
  const [node] = await db
    .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.id, data.orgNodeId))
    .limit(1)
  if (!node) return { success: false, message: '门店节点不存在，请刷新后重试' }
  if (node.type !== '门店') return { success: false, message: '只能为「门店」类型的组织节点创建门店信息' }

  
  if (!(await isNodeInScope(session, data.orgNodeId))) {
    return { success: false, message: '无权在该门店节点下创建门店信息' }
  }

  
  
  const lakalaMerchantTouched = data.lakalaMerchantId !== undefined
  if (lakalaMerchantTouched) {
    if (!hasPermission(session, 'store:lakala_config')) {
      return { success: false, message: '无权配置门店收款商户' }
    }
    if (data.lakalaMerchantId) {
      const [m] = await db
        .select({ id: lakalaMerchants.id })
        .from(lakalaMerchants)
        .where(eq(lakalaMerchants.id, data.lakalaMerchantId))
        .limit(1)
      if (!m) return { success: false, message: '所选收款商户不存在，请刷新后重试' }
    }
  }
  
  try {
    await db.transaction(async (tx) => {
      await tx.insert(stores).values({
        storeId: data.storeId,
        storeName: node.name,
        orgNodeId: data.orgNodeId,
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
        
        lakalaMerchantId: data.lakalaMerchantId ?? null,
      })
    })
  } catch (err: unknown) {
    const code = pgErrorCode(err)
    if (code === '23505') {
      
      if (pgErrorConstraint(err) === 'stores_org_node_id_unique') {
        return { success: false, message: '该门店节点已创建过门店信息' }
      }
      return { success: false, message: '门店名称已被占用' }
    }
    if (code === '23503') return { success: false, message: '门店节点不存在，请刷新后重试' }
    throw err
  }

  await logOperation(session, 'store.create', 'store', data.storeId, { storeName: node.name, orgNodeId: data.orgNodeId })
  revalidatePath('/stores')
  return { success: true, message: '门店创建成功' }
  },
)

export const updateStore = withPermission(
  'store:update',
  async (
    session,
    storeId: string,
    data: Partial<{
      storeName: string
      openingDate: string | null
      bedCount: number | null
      isClosed: boolean
      
      closedAt: string | null
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
      
      lakalaMerchantId: string | null
    }>,
    
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  
  const lakalaConfigTouched = data.lakalaMerchantId !== undefined
  if (lakalaConfigTouched) {
    if (!hasPermission(session, 'store:lakala_config')) {
      return { success: false, message: '无权修改门店的收款商户绑定' }
    }
    if (data.lakalaMerchantId) {
      const [m] = await db
        .select({ id: lakalaMerchants.id })
        .from(lakalaMerchants)
        .where(eq(lakalaMerchants.id, data.lakalaMerchantId))
        .limit(1)
      if (!m) return { success: false, message: '所选收款商户不存在，请刷新后重试' }
    }
  }

  
  const [before] = await db.select().from(stores).where(eq(stores.storeId, storeId)).limit(1)

  
  
  const scopeCond = scopeCondition(session, stores.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(eq(stores.storeId, storeId), sql`date_trunc('milliseconds', ${stores.updatedAt}) = ${expectedUpdatedAt}`, scopeCond)
    : and(eq(stores.storeId, storeId), scopeCond)

  
  
  
  
  const storeFields = { ...data }
  
  
  
  if (storeFields.isClosed !== undefined && storeFields.closedAt === undefined) {
    storeFields.closedAt = storeFields.isClosed ? shanghaiToday() : null
  }
  let result: any
  try {
    result = await db.transaction(async (tx) => {
      const r: any = await tx.update(stores).set(storeFields).where(whereConditions)
      
      if (
        r.count > 0 &&
        data.storeName !== undefined &&
        before?.orgNodeId &&
        data.storeName !== before.storeName
      ) {
        await tx.update(orgNodes).set({ name: data.storeName }).where(eq(orgNodes.id, before.orgNodeId))
      }
      return r
    })
  } catch (err: unknown) {
    
    if (pgErrorCode(err) === '23505') return { success: false, message: '同市场下已有同名门店' }
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
  },
)


export const getMarketStoreIds = withPermission(
  'store:list',
  async (_session, storeId: string): Promise<string[]> => {
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
  },
)
