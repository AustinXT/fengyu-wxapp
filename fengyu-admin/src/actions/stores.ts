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
import { randomBytes } from 'crypto'

// drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
const storeNode = alias(orgNodes, 'store_node') as unknown as typeof orgNodes
const marketNode = alias(orgNodes, 'market_node') as unknown as typeof orgNodes

// drizzle 0.45 alias 后的 join row 被推断为宽松 { [x: string]: any }，
// 严格类型签名跟实际不匹配 — 用 any 解锁 build；运行时行为不变
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

/**
 * 生成 KSUID 风格 ID：`{prefix}{8 位时间戳}{12 位随机}`。
 * 手填收款配置新建 lakala_merchants 时用作主键（lm_ 前缀）。
 */
function ksuid(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000).toString(36).padStart(8, '0')
  const rand = randomBytes(6).toString('hex')
  return `${prefix}${ts}${rand}`
}

/**
 * 门店拉卡拉收款配置：upsert 该店关联的 lakala_merchants 档案（N:1）。
 * - 收款字段（merchant_no / term_no / enabled）以 lakala_merchants 为单一权威；收款
 *   （clientApi resolveLakalaMerchant）与退款（refunds.ts refundViaLakalaIfEnabled）都经
 *   stores.lakala_merchant_id 关联读取本表，stores 不再留收款快照列。
 * - 门店仅持 lakala_merchant_id 外键；新建档案时回填该外键，后续编辑复用同一档案。
 * - 商户号为空 → 停用关联档案（enabled=false，保留档案与外键，下次填入复用）。
 * - 调用方（createStore/updateStore）已 require store:lakala_config + 校验「填商户号则商户名必填」。
 * 不通过 withPermission 包装（内部 helper，权限由调用方保证）。
 */
async function applyLakalaPaymentConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle 事务句柄类型宽松，与本文件既有 tx:any 一致
  tx: any,
  storeId: string,
  existingMerchantId: string | null,
  cfg: { merchantName: string | null; merchantNo: string | null; termNo: string | null; enabled: boolean },
): Promise<void> {
  const merchantNo = cfg.merchantNo?.trim() || null
  const merchantName = cfg.merchantName?.trim() || null
  const termNo = cfg.termNo?.trim() || null

  // 商户号为空 = 本店暂无收款配置：停用关联档案（保留档案与外键，下次填入复用）
  if (!merchantNo) {
    if (existingMerchantId) {
      await tx.update(lakalaMerchants).set({ enabled: false }).where(eq(lakalaMerchants.id, existingMerchantId))
    }
    return
  }

  // upsert 档案：已有则更新；没有则新建并回填门店外键（merchant_name 为区分标识，已由调用方校验非空）
  if (existingMerchantId) {
    await tx.update(lakalaMerchants).set({
      merchantName,
      merchantNo,
      termNo,
      enabled: cfg.enabled,
    }).where(eq(lakalaMerchants.id, existingMerchantId))
  } else {
    const merchantId = ksuid('lm_')
    await tx.insert(lakalaMerchants).values({
      id: merchantId,
      merchantName,
      merchantNo,
      termNo,
      enabled: cfg.enabled,
    })
    await tx.update(stores).set({ lakalaMerchantId: merchantId }).where(eq(stores.storeId, storeId))
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

export interface StoreLakalaConfig {
  merchantName: string
  merchantNo: string | null
  termNo: string | null
  enabled: boolean
}

/** 取门店关联的拉卡拉收款配置（编辑页回显用；无关联返回 null） */
export const getStoreLakalaConfig = withPermission(
  'store:list',
  async (session, storeId: string): Promise<StoreLakalaConfig | null> => {
    const [row] = await db
      .select({
        merchantName: lakalaMerchants.merchantName,
        merchantNo: lakalaMerchants.merchantNo,
        termNo: lakalaMerchants.termNo,
        enabled: lakalaMerchants.enabled,
      })
      .from(stores)
      .innerJoin(lakalaMerchants, eq(stores.lakalaMerchantId, lakalaMerchants.id))
      .where(and(eq(stores.storeId, storeId), scopeCondition(session, stores.storeId)))
      .limit(1)
    return row ?? null
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
    // drizzle 0.45 alias 后 select 类型推断退化成 never[]；用 any 解锁 build
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
      // 拉卡拉收款配置（可选，仅 admin；填了商户号则建档 + 同步快照）
      lakalaMerchantName?: string | null
      lakalaMerchantNo?: string | null
      lakalaTermNo?: string | null
      lakalaEnabled?: boolean
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

  // 2.5 拉卡拉收款配置（可选）：仅 admin（store:lakala_config）可填；填了商户号则商户名必填
  const lakalaConfigProvided = (data.lakalaMerchantNo ?? '').trim() !== ''
  if (lakalaConfigProvided) {
    if (!hasPermission(session, 'store:lakala_config')) {
      return { success: false, message: '无权配置门店收款（拉卡拉）' }
    }
    if (!(data.lakalaMerchantName ?? '').trim()) {
      return { success: false, message: '填写拉卡拉商户号时，商户名称必填' }
    }
  }
  // 3. 插入 stores 详情行（不自造节点）+ 可选建档收款配置，事务保证原子
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
      })
      // 收款配置：先建店后建档（applyLakalaPaymentConfig 建 lakala_merchants 档案 + 回填 stores.lakala_merchant_id）
      if (lakalaConfigProvided) {
        await applyLakalaPaymentConfig(tx, data.storeId, null, {
          merchantName: data.lakalaMerchantName ?? null,
          merchantNo: data.lakalaMerchantNo ?? null,
          termNo: data.lakalaTermNo ?? null,
          enabled: data.lakalaEnabled ?? false,
        })
      }
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
      // 拉卡拉收款配置（手填）：统一交 applyLakalaPaymentConfig 处理，不进 generic SET。
      // lakalaMerchantName 非 stores 列，落 lakala_merchants.merchant_name。
      lakalaMerchantName: string | null
      lakalaMerchantNo: string | null
      lakalaTermNo: string | null
      lakalaEnabled: boolean
    }>,
    /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 拉卡拉收款配置编辑权限：仅 admin（store:lakala_config）。hr 可改门店其他信息但不能碰收款。
  const lakalaConfigTouched =
    data.lakalaMerchantName !== undefined ||
    data.lakalaMerchantNo !== undefined ||
    data.lakalaTermNo !== undefined ||
    data.lakalaEnabled !== undefined
  if (lakalaConfigTouched) {
    if (!hasPermission(session, 'store:lakala_config')) {
      return { success: false, message: '无权修改门店的拉卡拉收款配置' }
    }
    // 填了商户号 → 商户名必填（merchant_name NOT NULL + 区分商户标识）
    if ((data.lakalaMerchantNo ?? '').trim() && !(data.lakalaMerchantName ?? '').trim()) {
      return { success: false, message: '填写拉卡拉商户号时，商户名称必填' }
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
  // 拉卡拉收款字段（含 lakalaMerchantName 非 stores 列）统一交 applyLakalaPaymentConfig，
  // 从 generic SET 剥离；其余字段走普通 UPDATE。
  const { lakalaMerchantName, lakalaMerchantNo, lakalaTermNo, lakalaEnabled, ...storeFields } = data
  // is_closed ↔ closed_at 双写一致：调用方仅传 isClosed 时由 action 自动推导 closedAt
  // - isClosed=true 且未显式给 closedAt：写 today
  // - isClosed=false：清空 closedAt（重新开业）
  if (storeFields.isClosed !== undefined && storeFields.closedAt === undefined) {
    storeFields.closedAt = storeFields.isClosed ? shanghaiToday() : null
  }
  let result: any
  try {
    result = await db.transaction(async (tx) => {
      const r: any = await tx.update(stores).set(storeFields).where(whereConditions)
      // 门店名以组织节点为权威：改名时同步 org_nodes.name，保持两者一致
      if (
        r.count > 0 &&
        data.storeName !== undefined &&
        before?.orgNodeId &&
        data.storeName !== before.storeName
      ) {
        await tx.update(orgNodes).set({ name: data.storeName }).where(eq(orgNodes.id, before.orgNodeId))
      }
      // 拉卡拉收款配置：upsert 该店关联 lakala_merchants 档案（新建则回填 stores.lakala_merchant_id）
      if (r.count > 0 && lakalaConfigTouched) {
        await applyLakalaPaymentConfig(tx, storeId, before?.lakalaMerchantId ?? null, {
          merchantName: lakalaMerchantName ?? null,
          merchantNo: lakalaMerchantNo ?? null,
          termNo: lakalaTermNo ?? null,
          enabled: lakalaEnabled ?? false,
        })
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
