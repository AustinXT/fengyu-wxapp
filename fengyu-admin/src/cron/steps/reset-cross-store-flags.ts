

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { rowsAffected } from '@/lib/pg-rows'

export interface ResetCrossStoreFlagsResult {
  staffReset: number
  customerReset: number
}

export async function resetCrossStoreFlags(db: Db): Promise<ResetCrossStoreFlagsResult> {
  const staffRes = await db.execute(sql`
    UPDATE staff_wechat_users
       SET is_on_business_trip = false
     WHERE is_on_business_trip = true
  `)
  const customerRes = await db.execute(sql`
    UPDATE client_wechat_users
       SET is_cross_store_temp = false
     WHERE is_cross_store_temp = true
  `)
  return {
    staffReset: rowsAffected(staffRes),
    customerReset: rowsAffected(customerRes),
  }
}
