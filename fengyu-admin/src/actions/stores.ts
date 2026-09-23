'use server'

import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { eq, and, sql, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { alias } from 'drizzle-orm/pg-core'
import type { Store } from '@/lib/types'
import { scopeCondition, hasPermission, isAdminScope, isInScope } from '@/lib/permissions'
import { getSession } from '@/lib/auth'
import { isNodeInScope } from '@/lib/node-scope'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'
// stores.org_node_id 是「门店↔组织节点」映射的写入方，与 org 侧改类型的守卫共用 ①（#318）
import { lockOrgTree } from '@/lib/invariant-locks'
import { isNodeWithinScopeRoots } from '@/lib/org-ancestry'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { shanghaiToday } from '@/lib/datetime'
import { lakalaMerchants } from '@db/lakala'
import type { MarketStoreFilterOptions } from '@/lib/market-store-filter-types'

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

export const getStores = withPermission('store:list', async (session): Promise<Store[]> => {
  const rows = await db
    .select()
    .from(stores)
    .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
    .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
    .where(scopeCondition(session, stores.storeId))
    // 例外：选择器场景占主导（本 action 同时用作 /stores 主列表与 15+ 处筛选下拉），门店是低变更频率实体，字母序对下拉选择更稳定
    .orderBy(asc(stores.storeName))

  return rows.map(rowToStore)
})

/**
 * 列表页的辅助市场/门店筛选数据。
 *
 * 主列表的读取权限与 `store:list` 是两套能力；没有门店读取权限时返回空选项，
 * 不能让辅助下拉把已授权页面 SSR 成 403。空结果不会泄露任何门店信息。
 */
// eslint-disable-next-line no-restricted-syntax -- 可选筛选数据须在无 store:list 时返回空数组，不能由 HOF 抛 403
export async function getMarketStoreFilterOptions(): Promise<MarketStoreFilterOptions> {
  const session = await getSession()
  if (!session || !hasPermission(session, 'store:list')) {
    return { markets: [], stores: [] }
  }

    const rows = await db
      .select({
        storeId: stores.storeId,
        storeName: stores.storeName,
        marketId: marketNode.id,
        marketName: marketNode.name,
      })
      .from(stores)
      .leftJoin(storeNode, eq(stores.orgNodeId, storeNode.id))
      .leftJoin(marketNode, eq(storeNode.parentId, marketNode.id))
      .where(scopeCondition(session, stores.storeId))
      .orderBy(asc(marketNode.name), asc(stores.storeName))

    const marketMap = new Map<string, string>()
    for (const row of rows) {
      if (row.marketId && row.marketName) marketMap.set(row.marketId, row.marketName)
    }

    return {
      markets: [...marketMap.entries()].map(([marketId, marketName]) => ({ marketId, marketName })),
      stores: rows.map((row) => ({
        storeId: row.storeId,
        storeName: row.storeName,
        marketId: row.marketId,
        marketName: row.marketName,
      })),
    }
}

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
      // 关联收款商户（可选，仅 admin store:lakala_config）：lakala_merchants.id 或 null=不关联
      lakalaMerchantId?: string | null
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

  // 2.5 关联收款商户（可选）：仅 admin（store:lakala_config）可设置门店↔商户绑定。
  //     商户档案本身在「商户管理」(/merchants) 维护；此处仅选择关联哪个已有商户。
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
  /**
   * 3. 插入 stores 详情行（不自造节点）+ 可选建档收款配置，事务保证原子。
   *
   * ## 必须取组织树锁（#318 第 5 轮，codex P1）
   *
   * `stores.org_node_id` 是「门店 ↔ 组织节点」映射的写入方，而
   * `org.updateOrgNode` 改类型那条路径的守卫要查「本节点上有没有门店映射」
   * （不许把挂着门店的节点改成非门店）。两边不共锁就能交叉穿透：
   * 改类型事务查到「节点还没被门店引用」→ 本事务把门店映射上去并按**旧**类型过 trigger
   * → 改类型事务再把节点改成非门店 → 留下「门店指向非门店节点」。
   * 取 `org_nodes:reparent`（① ，锁序见 `lib/invariant-locks.ts`）即互斥。
   */
  type CreateOutcome = { ok: true } | { ok: false; message: string }
  let created: CreateOutcome
  try {
    created = await db.transaction(async (tx): Promise<CreateOutcome> => {
      await lockOrgTree(tx)

      // 锁内重读节点类型 —— 事务外读到的可能已被并发改掉
      const [lockedNode] = await tx
        .select({ type: orgNodes.type, name: orgNodes.name })
        .from(orgNodes)
        .where(eq(orgNodes.id, data.orgNodeId))
        .limit(1)
      if (!lockedNode) return { ok: false, message: '门店节点不存在，请刷新后重试' }
      if (lockedNode.type !== '门店') {
        return { ok: false, message: '所选组织节点不是门店类型，请刷新后重新选择' }
      }
      /**
       * 节点是否**还**在操作者管辖范围内 —— 按当前树判（codex 第 6 轮 P1）。
       * 事务外那次走的是 `isNodeInScope`（session 构造时展开好的内存集合），
       * 窗口是整个 JWT 寿命：节点在登录后被改挂到另一个市场，旧 session 照样放行。
       */
      if (!isAdminScope(session)) {
        const scopeRoots = session.roles.map((role) => role.scopeId)
        if (!(await isNodeWithinScopeRoots(data.orgNodeId, scopeRoots, tx))) {
          return { ok: false, message: '无权在该节点下创建门店' }
        }
      }

      await tx.insert(stores).values({
        storeId: data.storeId,
        // 门店名以组织节点为权威 → 用**锁内**复读到的名字，事务外那个可能已被并发改掉
        storeName: lockedNode.name,
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
        // 关联收款商户（N:1）：直接写外键，商户档案在 /merchants 维护
        lakalaMerchantId: data.lakalaMerchantId ?? null,
      })
      await logOperation(
        session, 'store.create', 'store', data.storeId,
        { storeName: lockedNode.name, orgNodeId: data.orgNodeId }, tx,
      )
      return { ok: true }
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

  if (!created.ok) return { success: false, message: created.message }

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
      // 关联收款商户（stores 列，直接 SET）：lakala_merchants.id 或 null=不关联
      lakalaMerchantId: string | null
    }>,
    /** 乐观锁：提交时携带的 updated_at，后端校验防止并发覆盖 */
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
  // 门店↔收款商户绑定编辑权限：仅 admin（store:lakala_config）。hr 可改门店其他信息但不能碰收款绑定。
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

  // 获取旧值用于日志 diff
  const [before] = await db.select().from(stores).where(eq(stores.storeId, storeId)).limit(1)

  // 乐观锁 + scope 隔离：WHERE store_id = $1 [AND updated_at = $2] [AND scope]
  // 注意：PostgreSQL NOW() 有微秒精度，JS Date 仅毫秒精度，需 date_trunc 对齐
  const scopeCond = scopeCondition(session, stores.storeId)
  const whereConditions = expectedUpdatedAt
    ? and(eq(stores.storeId, storeId), sql`date_trunc('milliseconds', ${stores.updatedAt}) = ${expectedUpdatedAt}`, scopeCond)
    : and(eq(stores.storeId, storeId), scopeCond)

  /**
   * ## 写库字段走**显式白名单**，不要 `{ ...data }`（#318 第 7 轮 GLM P1）
   *
   * `data: Partial<{…}>` 只是**编译期**类型。Server Action 是可直接调用的端点，
   * 入参原样到达，没有任何运行时白名单 —— 裸 spread 进 `.set()` 时，客户端只要多塞一个
   * `orgNodeId`（`stores` 的合法列）就能改掉「门店 ↔ 组织节点」映射：
   * 绕过 `createStore` 那三层守卫（① 锁 / 锁内复读节点类型 / 按树复判 scope），
   * 「门店只能映射门店型节点」直接破；同理还能改 `storeId`（主键）与 `updatedAt`（伪造乐观锁基线）。
   * 这与 `updateEmployee` 的字段白名单是同一条教训（#249/#259），`updateStore` 当时漏了。
   *
   * ⚠️ 新增可编辑字段时**必须**在这里登记一行，否则会静默不生效（比静默写坏安全得多）。
   */
  const storeFields: Record<string, unknown> = {}
  const EDITABLE = [
    'storeName', 'openingDate', 'bedCount', 'isClosed', 'closedAt',
    'coverImage', 'images', 'district', 'streetAddress', 'latitude', 'longitude',
    'phone', 'businessHours', 'description', 'announcement', 'parkingInfo',
    'lakalaMerchantId',
  ] as const
  for (const key of EDITABLE) {
    if (data[key] !== undefined) storeFields[key] = data[key]
  }
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
/**
 * 同市场的兄弟门店 id（含自身）。
 *
 * ⚠️ 必须过 scope（#318 第 7 轮 GLM P2）：本 action 原先既不校验入参门店是否在操作者
 * scope 内、也不过滤结果 —— 市场 A 的管理员传一个市场 B 的 storeId 就能枚举 B 的全部门店 id，
 * 而同文件的 `getStores` / `getStoreById` / `getMarketStoreFilterOptions` 都套了 `scopeCondition`。
 * 这里走原生 SQL，所以在**入参**与**结果**两侧各判一次（admin 由 `isInScope` 内部短路）。
 */
export const getMarketStoreIds = withPermission(
  'store:list',
  async (session, storeId: string): Promise<string[]> => {
    if (!isInScope(session, storeId)) return []
    const rows = await db.execute(sql`
      SELECT s2.store_id
      FROM stores s1
      JOIN org_nodes sn1 ON s1.org_node_id = sn1.id
      JOIN org_nodes sn2 ON sn2.parent_id = sn1.parent_id AND sn2.type = '门店'
      JOIN stores s2 ON s2.org_node_id = sn2.id
      WHERE s1.store_id = ${storeId}
    `)
    const ids = (rows as any[])
      .map((r: any) => r.store_id as string)
      .filter((id) => isInScope(session, id))
    return ids.length > 0 ? ids : [storeId]
  },
)
