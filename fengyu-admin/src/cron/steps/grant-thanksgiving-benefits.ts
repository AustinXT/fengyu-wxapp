/**
 * STEP 4 — 感恩日权益发放（迁自 cronTask/index.js:598-737）
 *
 * 与 STEP 3 的关键差异：
 *   - 仅每月 20 号触发（DB EXTRACT(DAY FROM CURRENT_DATE) 短路；非 20 号直接 return）
 *   - 幂等键带 {YYYY-MM}（月度事件，非年度）
 *   - 优惠券固定 10 天有效期（admin UI 硬约束，不读 coupon_templates.validity_mode）
 *   - 扫描范围：当日 service_orders.status IN ('已完成','服务中') 的会员（DISTINCT 去重）
 *
 * 幂等键：
 *   消息 idempotency_key  = `thx-msg-${YYYY-MM}-${userId}`
 *   积分 external_ref     = `thx-pts-${YYYY-MM}-${userId}`
 *   优惠券 coupon_id      = 第 1 张沿用 `thx-${YYYY-MM}-${userId}-${templateId}`；
 *                            第 2..N 张为 `thx-${YYYY-MM}-${userId}-${templateId}-${i}`
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { loadJsonConfig } from '../lib/benefits-loader'
import { type CronContext, dateSqlOf, nowOf } from '../lib/cron-context'
import { beijingTs } from '@/lib/db-time'
import { clampCouponQuantity } from '@/lib/coupon-quantity'
import { grantPointBatch } from '@/lib/points-batches'

interface BenefitItem {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
  /** 每个模板的发放数量（缺省=1）；由 admin 配置 normalizeBenefits 保证 [1,99] */
  couponQuantities?: Record<string, number>
}
type ThanksgivingConfig = Record<string, BenefitItem>

export interface ThanksgivingResult {
  total: number
  sentCount: number
  skippedNoConfig: number
  errorCount: number
  skippedNotDay20?: boolean
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function grantThanksgivingBenefits(
  db: Db,
  ctx?: CronContext,
): Promise<ThanksgivingResult> {
  const dateSql = dateSqlOf(ctx)

  // 非 20 号短路返回（避免无谓扫表日志噪音）
  const dayRows = (await db.execute(sql`
    SELECT EXTRACT(DAY FROM ${dateSql})::int AS d
  `)) as Array<{ d: number }>
  if (dayRows[0].d !== 20) {
    return {
      total: 0,
      sentCount: 0,
      skippedNoConfig: 0,
      errorCount: 0,
      skippedNotDay20: true,
    }
  }

  const benefitsConfig = await loadJsonConfig<ThanksgivingConfig>(db, 'thanksgiving_benefits')
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  const ymRows = (await db.execute(sql`
    SELECT TO_CHAR(${dateSql}, 'YYYY-MM') AS ym
  `)) as Array<{ ym: string }>
  const yearMonth = ymRows[0].ym

  const rows = (await db.execute(sql`
    SELECT DISTINCT cwu.user_id, cwu.member_level
    FROM service_orders so
    JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
    WHERE so.service_date = ${dateSql}
      AND so.status IN ('已完成', '服务中')
      AND so.client_user_id IS NOT NULL
      AND cwu.member_level IS NOT NULL
  `)) as Array<{ user_id: string; member_level: string }>

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    try {
      await db.transaction(async (tx) => {
        await grantOneThanksgiving(tx, row.user_id, yearMonth, cfg, ctx)
        const detail = JSON.stringify({
          _v: 1,
          _t: 'thanksgiving',
          yearMonth,
          memberLevel: row.member_level,
          config: {
            points: cfg.points || 0,
            couponTemplateCount: Array.isArray(cfg.couponTemplateIds)
              ? cfg.couponTemplateIds.length
              : 0,
            couponTotalQuantity: Array.isArray(cfg.couponTemplateIds)
              ? cfg.couponTemplateIds.reduce(
                  (s, id) => s + clampCouponQuantity(cfg.couponQuantities?.[id]),
                  0,
                )
              : 0,
            messageTitle: cfg.messageTitle || null,
          },
        })
        await tx.execute(sql`
          INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
          VALUES ('customer.thanksgivingBenefits', 'customer', ${row.user_id}, ${detail}::jsonb, 'cronTask', NOW())
        `)
      })
      sentCount++
    } catch (err) {
      console.error(
        `[cron-worker/thanksgiving] failed for ${row.user_id}:`,
        (err as Error).message,
      )
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

async function grantOneThanksgiving(
  tx: Tx,
  userId: string,
  yearMonth: string,
  config: BenefitItem,
  ctx?: CronContext,
): Promise<void> {
  // 1) 消息
  if (config.messageTitle) {
    const idem = `thx-msg-${yearMonth}-${userId}`
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody ?? null},
              'system', ${idem}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  // 2) 积分（仅当流水成功插入才生成批次并重算余额）
  if (config.points && config.points > 0) {
    const externalRef = `thx-pts-${yearMonth}-${userId}`
    const inserted = (await tx.execute(sql`
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '感恩回馈', ${config.points}, NULL, ${externalRef}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as Array<{ id: number }>
    if (inserted.length > 0) {
      await grantPointBatch(tx, {
        userId,
        pointTransactionId: Number(inserted[0].id),
        type: '感恩回馈',
        amount: config.points,
        refOrderId: null,
      })
      await tx.execute(sql`
        UPDATE client_wechat_users c
           SET points_balance = COALESCE((
                 SELECT SUM(pb.remaining_amount)
                 FROM point_batches pb
                 WHERE pb.user_id = c.user_id
                   AND pb.expire_at > NOW()
               ), 0),
               points_updated_at = NOW()
         WHERE c.user_id = ${userId}
      `)
    }
  }

  // 3) 优惠券（固定 10 天有效期，不读 validity_mode）
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT is_active FROM coupon_templates WHERE template_id = ${templateId}
      `)) as Array<{ is_active: boolean | null }>
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(
          `[cron-worker/thanksgiving] 跳过优惠券 ${templateId}: 模板不存在或已停用`,
        )
        continue
      }

      const expireTs = beijingTs(new Date(nowOf(ctx).getTime() + 10 * 86400000))
      // 第 1 张沿用历史 key，保证补跑命中旧幂等记录；第 2..N 张追加序号。
      const qty = clampCouponQuantity(config.couponQuantities?.[templateId])
      const baseCouponId = `thx-${yearMonth}-${userId}-${templateId}`
      for (let i = 1; i <= qty; i++) {
        const couponId = i === 1 ? baseCouponId : `${baseCouponId}-${i}`
        const externalRef = couponId // 双写 external_ref：DB 层 uq_user_coupons_external_ref 兜底
        await tx.execute(sql`
          INSERT INTO user_coupons
            (coupon_id, template_id, user_id, status, expire_at, external_ref, created_at)
          VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireTs}, ${externalRef}, NOW())
          ON CONFLICT (coupon_id) DO NOTHING
        `)
      }
    }
  }
}
