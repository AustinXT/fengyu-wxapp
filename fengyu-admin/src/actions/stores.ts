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
import { _internalApplyLakalaLink } from './lakala-onboarding'

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
    lakalaMerchantNo: s.lakalaMerchantNo,
    lakalaTermNo: s.lakalaTermNo,
    lakalaSubAppid: s.lakalaSubAppid,
    lakalaMerchantId: s.lakalaMerchantId,
    lakalaEnabled: s.lakalaEnabled,
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
    // 例外：选择器场景占主导（本 action 同时用作 /stores 主列表与 15+ 处筛选下拉），门店是低变更频率实体，字母序对下拉选择更稳定
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

/**
 * 可挂载门店信息的组织节点（type='门店' 且尚无 stores 行），供创建门店页选择。
 * 门店实体以组织树门店节点为权威：/org 建节点，/stores 给节点补详情。
 */
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

    // scope 过滤：非 admin 只看自己 scope（含其下市场）内的门店节点
    const visible: Array<{ id: string; name: string; marketName: string }> = []
    for (const r of rows) {
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
      orgNodeId: string  // 所挂载的门店节点 id（type='门店'，必填）
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
    },
  ): Promise<{ success: boolean; message: string }> => {
  // 1. 校验目标节点存在且为门店类型，门店名以节点名为准
  const [node] = await db
    .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
    .from(orgNodes)
    .where(eq(orgNodes.id, data.orgNodeId))
    .limit(1)
  if (!node) return { success: false, message: '门店节点不存在，请刷新后重试' }
  if (node.type !== '门店') return { success: false, message: '只能为「门店」类型的组织节点创建门店信息' }

  // 2. scope 隔离：非 admin 只能在自己 scope（含其下市场）的门店节点上创建
  if (!(await isNodeInScope(session, data.orgNodeId))) {
    return { success: false, message: '无权在该门店节点下创建门店信息' }
  }

  // 3. 仅插入 stores 详情行，org_node_id 指向权威门店节点（不再自造节点）
  try {
    await db.insert(stores).values({
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
    })
  } catch (err: unknown) {
    const code = pgErrorCode(err)
    if (code === '23505') {
      // org_node_id 唯一 → 该节点已挂过门店；store_name 唯一 → 同名门店已存在
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
      /** 闭店日期（YYYY-MM-DD）；与 isClosed 双写一致，由 action 自动维护 */
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
      lakalaMerchantNo: string | null
      lakalaTermNo: string | null
      lakalaSubAppid: string | null
      lakalaEnabled: boolean
      /**
       * 关联拉卡拉商户 ID（N:1，stores.lakala_merchant_id）。
       * - admin 角色可写；hr 只读（涉及收款配置）。
       * - 非空 → 调内部 _internalApplyLakalaLink 验证商户态 + 刷快照 2 列（merchantNo/subAppid）
       * - 显式 null → 解绑：清快照 + 强置 lakalaEnabled=false
       * - undefined → 不动 lakala_merchant_id（保留原绑定关系）
       */
      lakalaMerchantId: string | null
    }>,
    /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 关联商户权限拦截：hr 不可改 lakala_merchant_id（涉及收款配置），仅 admin 持 lakala:onboarding:update
  if (data.lakalaMerchantId !== undefined) {
    if (!hasPermission(session, 'lakala:onboarding:update')) {
      return { success: false, message: '无权修改门店的拉卡拉商户关联' }
    }
  }

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(stores).where(eq(stores.storeId, storeId)).limit(1)

  // 乐观锁 + scope 隔离：WHERE store_id = $1 [AND updated_at = $2] [AND scope]
  // 注意：PostgreSQL NOW() 有微秒精度，JS Date 仅毫秒精度，需 date_trunc 对齐
  const scopeCond = scopeCondition(session, stores.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(eq(stores.storeId, storeId), sql`date_trunc('milliseconds', ${stores.updatedAt}) = ${expectedUpdatedAt}`, scopeCond)
    : and(eq(stores.storeId, storeId), scopeCond)

  // is_closed ↔ closed_at 双写一致：调用方仅传 isClosed 时由 action 自动推导 closedAt
  // - isClosed=true 且未显式给 closedAt：写 today
  // - isClosed=false：清空 closedAt（重新开业）
  const updateData = { ...data }
  if (data.isClosed !== undefined && data.closedAt === undefined) {
    updateData.closedAt = data.isClosed ? shanghaiToday() : null
  }
  // lakala_merchant_id 由 _internalApplyLakalaLink 在事务内单独处理（含商户态校验 + 快照刷新 + enabled 强置）
  // 不能让 generic SET 把 merchantNo / subAppid 当成 caller 直接传值（admin UI 不再手填）
  const lakalaMerchantIdChange = data.lakalaMerchantId
  if (lakalaMerchantIdChange !== undefined) {
    delete (updateData as Partial<typeof updateData>).lakalaMerchantId
    // 同时 strip 掉 merchantNo / subAppid（不允许 admin UI 同时传，避免 race）
    delete (updateData as Partial<typeof updateData>).lakalaMerchantNo
    delete (updateData as Partial<typeof updateData>).lakalaSubAppid
  }

  let result: any
  try {
    result = await db.transaction(async (tx) => {
      const r: any = await tx.update(stores).set(updateData).where(whereConditions)
      // 门店名以组织节点为权威：改名时同步 org_nodes.name，保持两者一致
      if (
        r.count > 0 &&
        data.storeName !== undefined &&
        before?.orgNodeId &&
        data.storeName !== before.storeName
      ) {
        await tx.update(orgNodes).set({ name: data.storeName }).where(eq(orgNodes.id, before.orgNodeId))
      }
      // 关联商户的事务内子动作：仅在显式传 lakalaMerchantId 时执行
      if (r.count > 0 && lakalaMerchantIdChange !== undefined && lakalaMerchantIdChange !== before?.lakalaMerchantId) {
        await _internalApplyLakalaLink(tx, storeId, lakalaMerchantIdChange)
      }
      return r
    })
  } catch (err: unknown) {
    // 同步节点名可能撞 uq_org_nodes_parent_name（同市场同名）
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

/** 根据门店 ID 获取同市场下所有门店 ID（含自身） */
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
