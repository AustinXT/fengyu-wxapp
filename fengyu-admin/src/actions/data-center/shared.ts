'use server'


import { db } from '@/db'
import { orgNodes, stores } from '@db/org'
import { eq, and, asc, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { withPermission } from '@/lib/with-permission'
import { isAdminScope, expandVisibleMarketIds } from '@/lib/permissions'
import { getScopeTopLevel } from '@/lib/data-center/context'
import type { DataCenterScopeOptions } from '@/lib/data-center/types'


export const getDataCenterScopeOptions = withPermission(
  'data_center:dashboard',
  async (session): Promise<DataCenterScopeOptions> => {
    const topLevel = getScopeTopLevel(session)
    const visibleMarketIds = await expandVisibleMarketIds(session) 
    const seeAll = isAdminScope(session) || visibleMarketIds === null

    
    if (!seeAll && (visibleMarketIds?.length ?? 0) === 0) {
      return { topLevel, markets: [] }
    }

    
    const marketRows = await db
      .select({ id: orgNodes.id, name: orgNodes.name })
      .from(orgNodes)
      .where(
        and(
          eq(orgNodes.type, '市场'),
          seeAll ? undefined : inArray(orgNodes.id, visibleMarketIds as string[]),
        ),
      )
      
      .orderBy(asc(orgNodes.sortOrder))

    
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
  },
)
