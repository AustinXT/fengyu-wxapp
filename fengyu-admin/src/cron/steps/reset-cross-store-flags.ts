/**
 * STEP — 每日重置顾客「临时跨门店」标记
 *
 * 决议变更（2026-07-13）：
 *   原设计（2026-06-24，张凯提出 / 夜航星确认）将员工「出差支援」
 *   (staff_wechat_users.is_on_business_trip) 与顾客「临时跨门店」
 *   (client_wechat_users.is_cross_store_temp) 均视为当日临时标记，每日 03:00 统一重置为 false。
 *   现业务希望员工出差支援长期生效（直至 admin 在员工详情页手动改回「否」），
 *   故本 STEP 不再重置员工标记，仅继续重置顾客临时跨门店标记，防止跨店可选范围无限膨胀。
 *
 * 纯重置清扫：仅 UPDATE `... = true` 的行（避免全表无谓写入），无副作用、
 * 不写 operation_logs（审计价值低，重置计数已随 cron summary 落 console）。
 * 不感知 CronContext（无时间窗口依赖），签名与只读审计 STEP 一致。
 */

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
