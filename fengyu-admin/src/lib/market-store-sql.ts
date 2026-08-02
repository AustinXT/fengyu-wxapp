import { db } from '@/db'
import { stores, orgNodes } from '@db/org'
import { eq, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

export function marketStoreIdsSubquery(marketId: string) {
  return db
    .select({ storeId: stores.storeId })
    .from(stores)
    .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
    .where(eq(orgNodes.parentId, marketId))
}

export function storeInMarketCondition(
  storeIdColumn: PgColumn,
  marketId: string,
): SQL {
  return inArray(storeIdColumn, marketStoreIdsSubquery(marketId)) as SQL
}
