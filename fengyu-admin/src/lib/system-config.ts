import { db } from '@/db'
import { sql } from 'drizzle-orm'

/**
 * 积分折算元比例（system_configs.points_to_yuan_rate，默认 0.01 即 100 积分 = 1 元）。
 *
 * 内部 PG 工具——给已在 Server Action 中通过 HOF 鉴权的调用方使用
 * （如 refunds 的退款计算）；不再是独立 Server Action，避免内嵌权限冲突
 * （refund 角色不持 system:config）。
 */
export async function getPointsToYuanRate(): Promise<number> {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = 'points_to_yuan_rate' LIMIT 1
    `)
    const raw = (rows as any[])[0]?.value
    const parsed = raw !== undefined ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01
  } catch {
    return 0.01
  }
}

/**
 * 积分抵扣上限比例（system_configs.points_deduction_max_rate，默认 0.03 即订单金额的 3%）。
 *
 * 口径：积分可抵扣的金额上限 = 使用优惠券和积分「前」的订单金额 × 该比例。
 * 日常 3%，活动期运营可在系统配置-基础配置临时调至 5%，活动结束后手动改回。
 * 值域 [0, 1]；DB 无该行 / 解析失败 / 越界（<0 或 >1）一律降级为 0.03。
 *
 * 与 points_to_yuan_rate（积分折算汇率，多少积分=1元）是两个独立配置，勿混。
 *
 * 内部 PG 工具——给已在 Server Action 中通过 HOF 鉴权的调用方使用；非独立 Server Action
 * （与 getPointsToYuanRate 同模式，避免内嵌权限冲突）。
 *
 * 消费方：admin createOrder / staff order.create / client checkout 的 computePointsDeduction。
 */
export async function getPointsDeductionMaxRate(): Promise<number> {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = 'points_deduction_max_rate' LIMIT 1
    `)
    const raw = (rows as any[])[0]?.value
    const parsed = raw !== undefined ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.03
  } catch {
    return 0.03
  }
}
