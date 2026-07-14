

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { rowsAffected } from '@/lib/pg-rows'

export interface ResetCrossStoreFlagsResult {
  customerReset: number
}

export async function resetCrossStoreFlags(db: Db): Promise<ResetCrossStoreFlagsResult> {
  const customerRes = await db.execute(sql`
    UPDATE client_wechat_users
       SET is_cross_store_temp = false
     WHERE is_cross_store_temp = true
  `)
  return {
    customerReset: rowsAffected(customerRes),
  }
}
