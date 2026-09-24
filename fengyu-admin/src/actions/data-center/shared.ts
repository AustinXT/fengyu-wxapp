'use server'

/**
 * 数据中心公共 server action：scope 三级筛选器数据源 + 数据起点。
 *
 * 各板块取数 action 分别在 sales.ts / customer.ts / efficiency.ts / product.ts，
 * 均用 withPermission('data_center:dashboard', ...) 包装；公共逻辑（scope 校验/时间/meta）
 * 在 src/lib/data-center/context.ts（纯/DB 辅助，不放此处以免被 actions ESLint 规则要求 HOF）。
 *
 * 经营明细报表（#367）按页面要求的权限点各有一个 scope 数据源：顾客明细类 / 员工提成类页面要求
 * 「dashboard + 专用权限点」由同一角色授权同时提供（withAllPermissions），范围也只按这些角色展开——
 * 不能拿只有 dashboard 的那条授权的范围去看顾客明细。
 */
import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, asc, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { withAllPermissions, withPermission } from '@/lib/with-permission'
import { isAdminScope, expandVisibleMarketIds } from '@/lib/permissions'
import { getScopeTopLevel } from '@/lib/data-center/context'
import { loadStoreDataStarts } from '@/lib/data-center/data-start-query'
import {
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  DATA_CENTER_STAFF_COMMISSION_ACTIONS,
} from '@/lib/data-center/report-permissions'
import type { StoreDataStarts } from '@/lib/data-center/data-start'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'
import type { AuthSession } from '@/lib/types'

/**
 * 返回当前账号可选的 scope 树（市场 + 门店）。
 * - 总部/admin：全部市场 + 全部在营门店
 * - 市场：所有获授权市场 + 其下授权门店
 * - 门店：所有获授权门店及其所属市场（可能是多店）
 */
export const getDataCenterScopeOptions = withPermission(
  'data_center:dashboard',
  async (session): Promise<DataCenterScopeOptions> => loadScopeOptions(session),
)

/** 顾客明细类报表（顾客频率表、顾客剩余卡项清单）的 scope 数据源兼页面闸门。 */
export const getCustomerDetailScopeOptions = withAllPermissions(
  DATA_CENTER_CUSTOMER_DETAIL_ACTIONS,
  async (session): Promise<DataCenterScopeOptions> => loadScopeOptions(session),
)

/** 员工提成类报表（员工提成日报、提成明细）的 scope 数据源兼页面闸门。 */
export const getStaffCommissionScopeOptions = withAllPermissions(
  DATA_CENTER_STAFF_COMMISSION_ACTIONS,
  async (session): Promise<DataCenterScopeOptions> => loadScopeOptions(session),
)

/**
 * 各门店的数据起点（#367 数据起点提示）。总部范围返回全部门店，其余只返回授权门店。
 * 判定在纯函数 `lib/data-center/data-start.ts`，页面按所选 scope 与期间自行计算。
 */
export const getDataStartDates = withPermission(
  'data_center:dashboard',
  async (session): Promise<StoreDataStarts> => {
    const all = await loadStoreDataStarts()
    if (getScopeTopLevel(session) === 'all') return all
    const visible = new Set(session.permissions.scopeStoreIds)
    return Object.fromEntries(Object.entries(all).filter(([storeId]) => visible.has(storeId)))
  },
)

async function loadScopeOptions(session: AuthSession): Promise<DataCenterScopeOptions> {
  const topLevel = getScopeTopLevel(session)
  const visibleMarketIds = await expandVisibleMarketIds(session) // null=总部全开
  const seeAll = isAdminScope(session) || visibleMarketIds === null

  // 非总部且无可见市场 → 空
  if (!seeAll && (visibleMarketIds?.length ?? 0) === 0) {
    return { topLevel, markets: [] }
  }

  // 市场列表
  const marketRows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(
      and(
        eq(orgNodes.type, '市场'),
        seeAll ? undefined : inArray(orgNodes.id, visibleMarketIds as string[]),
      ),
    )
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(orgNodes.sortOrder))

  // 门店列表（JOIN 门店节点拿所属市场 = 节点 parent_id）
  const orgStore = alias(orgNodes, 'org_store')
  const storeRows = await db
    .select({
      storeId: stores.storeId,
      storeName: stores.storeName,
      marketId: orgStore.parentId,
    })
    .from(stores)
    .innerJoin(orgStore, eq(stores.orgNodeId, orgStore.id))
    .where(
      and(
        eq(stores.isClosed, false),
        eq(orgStore.type, '门店'),
        eq(orgStore.isActive, true),
        // 总部看全部门店；其他角色仅看 scopeStoreIds（市场账号=其下门店，门店账号=本店）
        seeAll
          ? undefined
          : session.permissions.scopeStoreIds.length > 0
            ? inArray(stores.storeId, session.permissions.scopeStoreIds)
            : eq(stores.storeId, '__none__'),
      ),
    )
    .orderBy(asc(stores.storeName))

  const markets = marketRows.map((m) => ({
    id: m.id,
    name: m.name,
    stores: storeRows
      .filter((s) => s.marketId === m.id)
      .map((s) => ({ storeId: s.storeId, storeName: s.storeName })),
  }))

  return { topLevel, markets }
}
