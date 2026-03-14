'use server'

import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { alias } from 'drizzle-orm/pg-core'
import type { Store } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

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
    .where(eq(stores.storeId, storeId))

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

  // 同时创建 org_node（type=store）和 stores 记录
  const orgNodeId = `store-${data.storeId}`
  await db.insert(orgNodes).values({
    id: orgNodeId,
    name: data.storeName,
    type: 'store',
    parentId: data.marketId,
    sortOrder: 0,
    isActive: true,
  })

  await db.insert(stores).values({
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
  }>
) {
  const session = await getSession()
  requirePermission(session, 'store:update')

  await db.update(stores).set(data).where(eq(stores.storeId, storeId))

  await logOperation(session, 'store.update', 'store', storeId, data)
  revalidatePath('/stores')
}
