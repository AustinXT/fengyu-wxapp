/**
 * STEP 7 — 6 项资金不变量守护（I2b / I6b 为附加监控项，共 8 条 SELECT）（2026-04-26 sale-order-domain-refactor §4.6 + audit-CC1 §7）
 *
 * 背景：
 *   重构后 sale_orders.received / refunded_amount / prepaid_card_amount 均为
 *   sale_order_payments 的冗余快照；client_wechat_users.points_balance 是未过期积分批次
 *   剩余量缓存；prepaid_cards.balance 是流水冗余快照。任何应用层双写漏写、并发写偏、
 *   或人为脱拍都会让冗余值与真值漂移。本 STEP 每日只读校验 6 项不变量，发现偏差仅告警不修复（与 STEP 5
 *   auditPointsBalance / STEP 6 auditRoleTypeNulls 决策一致 — 自动修补会掩盖上游 bug）。
 *
 * 6 项不变量（详见 ticket §1.2 + audit-CC1 §7）：
 *   I1: sale_orders.received        = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount
 *       （豁免 legacy_source='workfine'：历史单 received 为旧系统平移值、无支付流水）
 *   I2: sale_orders.refunded_amount = -Σ sop[已支付, 退款].amount
 *   I3: client_wechat_users.points_balance = Σ 未过期 point_batches.remaining_amount
 *   I4: prepaid_cards.balance       = Σ card_transactions.amount
 *   I5: sale_orders.payable_amount  = total_amount - prepaid_card_amount
 *   I6 : sop[首次支付].performance_attribution_date = sale_orders.performance_attribution_date
 *   I6b: sop[已支付,储值卡抵扣].performance_attribution_date = 同次配对主流水的归属日期
 *       （issue #137：查询侧直读款项级归属日期后，这两条镜像脱拍都会让业绩静默落错日子）
 *
 * 容差：金额不变量（I1/I2/I4/I5）容忍 0.01 元（NUMERIC(10,2) 累加边界），
 *       积分不变量（I3）与归属日期（I6）严格相等。
 *
 * 告警机制（与 STEP 5/6 一致）：
 *   - operation_logs(action='cron.audit_invariants', target_type='invariant_violation')
 *     单条 INSERT，detail 含每项 violations 行数 + 前 100 条样例
 *   - 命中任意 violation 时调用 notifyOps（企微机器人）
 *   - 永远不修补（自动修复会掩盖上游 bug）
 *
 * 执行频次：每日 1 次（与 cron-worker 其他 STEP 同 03:00 串行）。
 *   ticket 原文建议"凌晨 4 点单独跑"避免与其他 STEP 争资源；当前 cron-worker
 *   STEP 串行 + 全部只读 SELECT，放在 03:00 STEP 链末尾即可，无需独立 cron 句柄。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const MONEY_EPSILON = 0.01

interface ViolationSample {
  invariant: string
  count: number
  samples: Array<Record<string, unknown>>
}

export interface PaymentInvariantsResult {
  violations: number
  details: ViolationSample[]
}

const SAMPLE_LIMIT = 100

export async function auditPaymentInvariants(db: Db): Promise<PaymentInvariantsResult> {
  const details: ViolationSample[] = []

  // ── I1: received = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount
  //        豁免 legacy_source='workfine'（历史单无支付流水，received 为平移值） ──
  // ⚠ WHERE 必须排在 LEFT JOIN **之后**：2026-07-20 加 legacy 豁免时把它插到了 JOIN 前面，
  // 那是 PG 语法错误（`syntax error at or near "LEFT"`）。r1 在本函数最前面，一抛就整步退出，
  // 被 run.ts 的 per-STEP try/catch 吞掉 —— I1~I5 全部静默停摆了近两个月，2026-09-14 修复。
  const r1 = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.received::numeric                  AS received,
           COALESCE(SUM(sop.amount::numeric), 0) AS computed
    FROM sale_orders so
    LEFT JOIN sale_order_payments sop
      ON sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
    WHERE so.legacy_source IS DISTINCT FROM 'workfine'
    GROUP BY so.sale_order_id, so.received
    HAVING ABS(so.received::numeric - COALESCE(SUM(sop.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; received: string | number; computed: string | number }>
  if (r1.length > 0) {
    details.push({ invariant: 'received_eq_sum_payments', count: r1.length, samples: r1 as unknown as Array<Record<string, unknown>> })
  }

  // ── I2: refunded_amount = -Σ sop[已支付, 退款].amount ──
  const r2 = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.refunded_amount::numeric             AS refunded_amount,
           COALESCE(-SUM(sop.amount::numeric), 0) AS computed
    FROM sale_orders so
    LEFT JOIN sale_order_payments sop
      ON sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.change_type = '退款'
    GROUP BY so.sale_order_id, so.refunded_amount
    HAVING ABS(so.refunded_amount::numeric - COALESCE(-SUM(sop.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; refunded_amount: string | number; computed: string | number }>
  if (r2.length > 0) {
    details.push({ invariant: 'refunded_amount_eq_neg_sum_refund_payments', count: r2.length, samples: r2 as unknown as Array<Record<string, unknown>> })
  }

  // ── I2b: refunded_amount ≤ received（监控-1，守护 Bug A 超额退款资损：累计退款不得超过实收）──
  const r2b = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.received::numeric        AS received,
           so.refunded_amount::numeric AS refunded_amount
    FROM sale_orders so
    WHERE so.refunded_amount::numeric > so.received::numeric + ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; received: string | number; refunded_amount: string | number }>
  if (r2b.length > 0) {
    details.push({ invariant: 'refunded_le_received', count: r2b.length, samples: r2b as unknown as Array<Record<string, unknown>> })
  }

  // ── I3: client_wechat_users.points_balance = Σ 未过期 point_batches.remaining_amount ──
  // 与 STEP 5 (audit-points-balance) 重叠，但语义独立：本处作为"6 项不变量"统一报表的一项。
  // 容差严格相等（integer 无浮点误差）。
  const r3 = (await db.execute(sql`
    WITH sums AS (
      SELECT user_id, COALESCE(SUM(remaining_amount), 0)::bigint AS total_from_batches
      FROM point_batches
      WHERE remaining_amount > 0
        AND expire_at > NOW()
      GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0) AS cached_balance,
           COALESCE(s.total_from_batches, 0) AS expected_balance
    FROM client_wechat_users u
    LEFT JOIN sums s ON s.user_id = u.user_id
    WHERE COALESCE(u.points_balance, 0) <> COALESCE(s.total_from_batches, 0)
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ user_id: string; cached_balance: number | string; expected_balance: number | string }>
  if (r3.length > 0) {
    details.push({ invariant: 'points_balance_eq_unexpired_batches', count: r3.length, samples: r3 as unknown as Array<Record<string, unknown>> })
  }

  // ── I4: prepaid_cards.balance = Σ card_transactions.amount ──
  const r4 = (await db.execute(sql`
    SELECT pc.card_id,
           pc.balance::numeric                    AS balance,
           COALESCE(SUM(ct.amount::numeric), 0)  AS computed
    FROM prepaid_cards pc
    LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
    GROUP BY pc.card_id, pc.balance
    HAVING ABS(pc.balance::numeric - COALESCE(SUM(ct.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ card_id: string; balance: string | number; computed: string | number }>
  if (r4.length > 0) {
    details.push({ invariant: 'prepaid_balance_eq_sum_card_txns', count: r4.length, samples: r4 as unknown as Array<Record<string, unknown>> })
  }

  // ── I5: payable_amount = total_amount - prepaid_card_amount ──
  // 白名单：销售单 / 内部单 / 转换单 / 寄存单 满足该不变量。
  // 排除「充值单」—— total_amount 是充值卡面额、payable_amount 是顾客实付，
  // 差额 = 充值卡赠送（例：充1000送20、充10万送5000），业务正向差，非不变量违规。
  // 白名单形式而非黑名单：未来再加单据类型默认不校验，加入时主动决策。
  const r5 = (await db.execute(sql`
    SELECT sale_order_id,
           total_amount::numeric        AS total_amount,
           prepaid_card_amount::numeric AS prepaid_card_amount,
           payable_amount::numeric      AS payable_amount
    FROM sale_orders
    WHERE sale_order_type IN ('销售单','内部单','转换单','寄存单')
      AND ABS(payable_amount::numeric - (total_amount::numeric - prepaid_card_amount::numeric)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{
    sale_order_id: string
    total_amount: string | number
    prepaid_card_amount: string | number
    payable_amount: string | number
  }>
  if (r5.length > 0) {
    details.push({ invariant: 'payable_eq_total_minus_prepaid', count: r5.length, samples: r5 as unknown as Array<Record<string, unknown>> })
  }

  // ── I6: 首次支付款项的业绩归属日期 = 所属订单的业绩归属日期 ──
  // 迁移 0041 起各端报表直读 sale_order_payments.performance_attribution_date（不再有 CASE 回退），
  // 首次支付那一行是 sale_orders 的镜像。镜像一旦脱拍，那笔业绩会静默落到错误的日子，
  // 金额不变量（I1/I2）也查不出来 —— 它们只看总额，不看归属日。
  // 写入侧由两个 trigger 保证：initialize_payment_performance_attribution_date（BEFORE，0040）
  // 与 sync_order_performance_attribution_to_payments（sale_orders AFTER UPDATE，0040）。
  // 本项守护的是"trigger 被绕过"（禁用触发器的批量导入 / session_replication_role=replica）。
  const r6 = (await db.execute(sql`
    SELECT p.id::text AS id,
           p.sale_order_id,
           p.performance_attribution_date::text  AS payment_attribution_date,
           so.performance_attribution_date::text AS order_attribution_date
    FROM sale_order_payments p
    JOIN sale_orders so ON so.sale_order_id = p.sale_order_id
    WHERE p.change_type = '首次支付'
      AND p.performance_attribution_date IS DISTINCT FROM so.performance_attribution_date
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{
    id: string
    sale_order_id: string
    payment_attribution_date: string | null
    order_attribution_date: string | null
  }>
  if (r6.length > 0) {
    details.push({ invariant: 'first_payment_attribution_eq_order', count: r6.length, samples: r6 as unknown as Array<Record<string, unknown>> })
  }

  // ── I6b: 同次混合支付的储值卡抵扣行的归属日期 = 配对主流水的归属日期 ──
  // I6 只守首次支付↔订单那条镜像；卡行↔主流水这条同样是直读列之后才变得致命，
  // 而迁移 0041 的自检只管迁移那一刻。谓词与 trigger / 迁移自检的配对条件保持一致：
  // 同单、同 status、paid_at 精确相同，首次支付优先于回款。
  const r6b = (await db.execute(sql`
    SELECT card.id::text AS id,
           card.sale_order_id,
           card.performance_attribution_date::text    AS card_attribution_date,
           primary_payment.performance_attribution_date::text AS primary_attribution_date
    FROM sale_order_payments card
    JOIN LATERAL (
      SELECT p.performance_attribution_date
      FROM sale_order_payments p
      WHERE p.sale_order_id = card.sale_order_id
        AND p.change_type IN ('首次支付', '回款')
        AND p.status = card.status
        AND p.paid_at IS NOT DISTINCT FROM card.paid_at
      ORDER BY CASE WHEN p.change_type = '首次支付' THEN 0 ELSE 1 END, p.id
      LIMIT 1
    ) primary_payment ON true
    WHERE card.change_type = '储值卡抵扣'
      AND card.status = '已支付'
      AND card.performance_attribution_date
          IS DISTINCT FROM primary_payment.performance_attribution_date
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{
    id: string
    sale_order_id: string
    card_attribution_date: string | null
    primary_attribution_date: string | null
  }>
  if (r6b.length > 0) {
    details.push({ invariant: 'card_attribution_eq_paired_primary', count: r6b.length, samples: r6b as unknown as Array<Record<string, unknown>> })
  }

  if (details.length > 0) {
    // operation_logs 单条聚合写入（避免 N 条小写）。target_id 用日期戳便于查询。
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'invariants',
      date: dateStamp,
      total: details.length,
      violations: details,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_invariants', 'invariant_violation', ${dateStamp}, ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = details.map(
      (d) => `- ${d.invariant}: ${d.count} 条偏差`,
    )
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_invariants',
        '6 项资金不变量违规：',
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { violations: details.length, details }
}
