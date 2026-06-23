/**
 * STEP — 每日重置跨门店临时标记（跨门店员工共享 + 顾客跨门店临时绑定）
 *
 * 决议（张凯提出 / 夜航星确认）：
 *   员工"出差支援"(staff_wechat_users.is_on_business_trip) 与
 *   顾客"临时跨门店"(client_wechat_users.is_cross_store_temp) 均为临时标记，
 *   开单 / 营业额分配时据此放宽门店可选范围。为防止标记长期置 true 导致
 *   可选范围无限膨胀，每日 03:00 统一重置为 false（次日须重新标记）。
 *
 * 纯重置清扫：仅 UPDATE `... = true` 的行（避免全表无谓写入），无副作用、
 * 不写 operation_logs（审计价值低，重置计数已随 cron summary 落 console）。
 * 不感知 CronContext（无时间窗口依赖），签名与只读审计 STEP 一致。
 */

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
