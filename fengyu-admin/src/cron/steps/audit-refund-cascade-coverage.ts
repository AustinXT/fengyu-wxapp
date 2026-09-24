/**
 * STEP 9 — 退款 5 通道级联巡检（audit-11 P0-11 cascade coverage，2026-05-18 新增）
 *
 * 背景：
 *   cascadeRefund (fengyu-admin/src/lib/refund-cascade.ts:56-212) 在退款审批通过
 *   时同事务级联 5 个下游通道。STEP 8 auditPaymentInvariants 只校验 received /
 *   refunded_amount / points_balance / prepaid balance / payable_amount 5 项
 *   "资金"不变量；如果某个 cascade 分支被注释掉、或新的退款入口忘了调
 *   cascadeRefund，资金侧仍对得上但提成 / 积分 / 券 / 提货已经漂移。
 *
 *   静态字面量漂移由 cross-end-sql-snapshot.test.js 守护；本 STEP 是运行时数据
 *   的镜像守护，反向检查 "已支付的退款行" 是否产生了对应的 5 通道效果。
 *
 * 5 通道（与 lib/refund-cascade.ts 1:1 对齐）：
 *   C1 sa_not_reversed        — 每个角色池的退款负数冲销总额应与其正向覆盖率匹配
 *   C2 sc_not_voided          — service_commissions.voided_at IS NOT NULL 应已写入
 *   C3 coupon_not_returned    — user_coupons 退款生效时仍未过期的 → 应已恢复 '未使用'
 *                                 （用 sop.paid_at 对齐 cascade 的 NOW() 快照）
 *   C4 point_not_reversed     — point_transactions 正向赠送/获取 → 应存在 -amount 的 '消费冲销'
 *   C5 pickup_quantity_mismatch  — sale_items.picked_up_quantity 必须等于 SUM(pickup_records.pickup_quantity)
 *   C5b settled_quantity_overflow— picked_up + refunded + converted 不得超过 quantity（CHECK 约束的二道保险）
 *   C5c converted_quantity_mismatch — converted_quantity 必须等于未关闭转出行的 quantity 聚合
 *
 * 决议：与 STEP 5/6/7/8 一致，**只告警不修复**。
 *   - 自动 cascade 修复会掩盖上游退款逻辑 bug
 *   - 仅写 operation_logs + notifyOps，由 PM/oncall 追 commit 排查
 *
 * 告警机制：
 *   - operation_logs(action='cron.audit_refund_cascade', target_type='cascade_violation',
 *     target_id=日期戳, source='cronTask')，detail 含每通道 mismatch 计数 + 前 10 条样例
 *   - notifyOps（企微机器人）单条 markdown，每通道一行
 *
 * 当前 PG 数据 0 mismatch 是 DoD（STEP 7 同模式）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const SAMPLE_LIMIT = 10

type CascadeChannel =
  | 'sa_not_reversed'
  | 'c1_receipt_missing'
  | 'sc_not_voided'
  | 'coupon_not_returned'
  | 'point_not_reversed'
  | 'pickup_quantity_mismatch'
  | 'settled_quantity_overflow'
  | 'converted_quantity_mismatch'

interface CascadeViolation {
  channel: CascadeChannel
  count: number
  samples: Array<Record<string, unknown>>
}

export interface RefundCascadeCoverageResult {
  violations: number
  details: CascadeViolation[]
}

export async function auditRefundCascadeCoverage(db: Db): Promise<RefundCascadeCoverageResult> {
  const details: CascadeViolation[] = []

  // ── C1: receipt 子分配按角色池完整冲销 ──
  // 不只检查“有没有负数行”，还按 (sale_item_id, role_type) 校验负数总额。
  // 期望值逐笔回放运行态口径：min(本次退款, 剩余角色池,
  // round(本次退款 × 剩余角色池 / 剩余实收))。正实收/角色池必须取每笔退款发生时的快照，
  // 避免退款后回款改变 R:P 比例，导致历史退款在每晚持续误报。
  // 同一 timestamptz 内用 payment bigserial、receipt bigserial 打破并列：二者单调递增，可近似事务内的插入先后。
  // 因此两个各 100% 的角色池必须各自冲销完整退款额，旧实现的各冲一半会被检出。
  const c1 = (await db.execute(sql`
    WITH RECURSIVE scoped AS (
      SELECT DISTINCT spir.sale_order_id, spir.sale_item_id
        FROM sale_payment_item_receipts spir
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spir.amount < 0
         AND sop.status = '已支付'
         AND sop.change_type = '退款'
    ),
    refund_events AS (
      SELECT spir.sale_order_id, spir.sale_item_id,
             sop.id AS refund_payment_id,
             spir.id AS refund_receipt_id,
             COALESCE(sop.paid_at, sop.created_at) AS refund_at,
             ABS(ROUND(spir.amount::numeric * 100))::bigint AS refund_cents,
             ROW_NUMBER() OVER (
               PARTITION BY spir.sale_order_id, spir.sale_item_id
               ORDER BY COALESCE(sop.paid_at, sop.created_at), sop.id, spir.id
             ) AS refund_seq,
             COALESCE(
               SUM(ABS(ROUND(spir.amount::numeric * 100))::bigint) OVER (
                 PARTITION BY spir.sale_order_id, spir.sale_item_id
                 ORDER BY COALESCE(sop.paid_at, sop.created_at), sop.id, spir.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ),
               0
             )::bigint AS prior_refund_cents
        FROM scoped scope
        JOIN sale_payment_item_receipts spir
          ON spir.sale_order_id = scope.sale_order_id
         AND spir.sale_item_id = scope.sale_item_id
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spir.amount < 0
         AND sop.status = '已支付'
         AND sop.change_type = '退款'
    ),
    receipt_totals AS (
      SELECT re.sale_order_id, re.sale_item_id, re.refund_seq,
             COALESCE(
               ROUND(SUM(pos_spir.amount::numeric) FILTER (
                 WHERE pos_spir.amount > 0
                   AND pos_sop.status = '已支付'
                   AND pos_sop.change_type IN ('首次支付','回款','储值卡抵扣')
                   AND (COALESCE(pos_sop.paid_at, pos_sop.created_at), pos_sop.id, pos_spir.id)
                       < (re.refund_at, re.refund_payment_id, re.refund_receipt_id)
               ) * 100),
               0
             )::bigint AS positive_receipt_cents
        FROM refund_events re
        JOIN scoped scope
          ON scope.sale_order_id = re.sale_order_id
         AND scope.sale_item_id = re.sale_item_id
        LEFT JOIN sale_payment_item_receipts pos_spir
          ON pos_spir.sale_order_id = scope.sale_order_id
         AND pos_spir.sale_item_id = scope.sale_item_id
        LEFT JOIN sale_order_payments pos_sop ON pos_sop.id = pos_spir.sale_payment_id
       GROUP BY re.sale_order_id, re.sale_item_id, re.refund_seq
    ),
    positive_pools AS (
      SELECT re.sale_order_id, re.sale_item_id, re.refund_seq, spia.role_type,
             ROUND(SUM(spia.allocated_amount::numeric) * 100)::bigint AS positive_allocated_cents
        FROM refund_events re
        JOIN scoped scope
          ON scope.sale_order_id = re.sale_order_id
         AND scope.sale_item_id = re.sale_item_id
        JOIN sale_payment_item_receipts pos_spir
          ON pos_spir.sale_order_id = scope.sale_order_id
         AND pos_spir.sale_item_id = scope.sale_item_id
        JOIN sale_order_payments pos_sop ON pos_sop.id = pos_spir.sale_payment_id
        JOIN sale_payment_item_allocations spia
          ON spia.sale_payment_item_receipt_id = pos_spir.id
       WHERE spia.is_void = false
         AND spia.allocated_amount > 0
         AND pos_spir.amount > 0
         AND pos_sop.status = '已支付'
         AND pos_sop.change_type IN ('首次支付','回款','储值卡抵扣')
         AND (COALESCE(pos_sop.paid_at, pos_sop.created_at), pos_sop.id, pos_spir.id)
             < (re.refund_at, re.refund_payment_id, re.refund_receipt_id)
       GROUP BY re.sale_order_id, re.sale_item_id, re.refund_seq, spia.role_type
    ),
    refund_role_events AS (
      SELECT pp.sale_order_id, pp.sale_item_id, pp.role_type,
             pp.refund_seq, re.refund_cents, re.prior_refund_cents,
             rt.positive_receipt_cents, pp.positive_allocated_cents,
             ROW_NUMBER() OVER (
               PARTITION BY pp.sale_order_id, pp.sale_item_id, pp.role_type
               ORDER BY pp.refund_seq
             ) AS role_refund_seq
        FROM positive_pools pp
        JOIN refund_events re
          ON re.sale_order_id = pp.sale_order_id
         AND re.sale_item_id = pp.sale_item_id
         AND re.refund_seq = pp.refund_seq
        JOIN receipt_totals rt
          ON rt.sale_order_id = pp.sale_order_id
         AND rt.sale_item_id = pp.sale_item_id
         AND rt.refund_seq = pp.refund_seq
    ),
    refund_replay AS (
      SELECT re.sale_order_id, re.sale_item_id, re.role_type,
             re.positive_allocated_cents, re.positive_receipt_cents,
             re.refund_seq, re.role_refund_seq, re.refund_cents,
             GREATEST(re.positive_receipt_cents - re.prior_refund_cents, 0) AS remaining_receipt_cents,
             re.positive_allocated_cents AS remaining_pool_cents,
             target.target_cents,
             target.target_cents AS cumulative_target_cents
        FROM refund_role_events re
        CROSS JOIN LATERAL (
          SELECT LEAST(
                   re.refund_cents,
                   re.positive_allocated_cents,
                   GREATEST(
                     0,
                     ROUND(
                       re.refund_cents::numeric * re.positive_allocated_cents
                       / NULLIF(GREATEST(re.positive_receipt_cents - re.prior_refund_cents, 0), 0)
                     )::bigint
                   )
                 ) AS target_cents
        ) target
       WHERE re.role_refund_seq = 1

      UNION ALL

      SELECT re.sale_order_id, re.sale_item_id, re.role_type,
             re.positive_allocated_cents, re.positive_receipt_cents,
             re.refund_seq, re.role_refund_seq, re.refund_cents,
             GREATEST(re.positive_receipt_cents - re.prior_refund_cents, 0) AS remaining_receipt_cents,
             GREATEST(re.positive_allocated_cents - replay.cumulative_target_cents, 0) AS remaining_pool_cents,
             target.target_cents,
             replay.cumulative_target_cents + target.target_cents AS cumulative_target_cents
        FROM refund_replay replay
        JOIN refund_role_events re
          ON re.sale_order_id = replay.sale_order_id
         AND re.sale_item_id = replay.sale_item_id
         AND re.role_type = replay.role_type
         AND re.role_refund_seq = replay.role_refund_seq + 1
        CROSS JOIN LATERAL (
          SELECT LEAST(
                   re.refund_cents,
                   GREATEST(re.positive_allocated_cents - replay.cumulative_target_cents, 0),
                   GREATEST(
                     0,
                     ROUND(
                       re.refund_cents::numeric
                       * GREATEST(re.positive_allocated_cents - replay.cumulative_target_cents, 0)
                       / NULLIF(GREATEST(re.positive_receipt_cents - re.prior_refund_cents, 0), 0)
                     )::bigint
                   )
                 ) AS target_cents
        ) target
    ),
    expected_pools AS (
      SELECT sale_order_id, sale_item_id, role_type,
             MAX(positive_allocated_cents) AS positive_allocated_cents,
             SUM(refund_cents) AS refund_receipt_cents,
             SUM(target_cents) AS expected_negative_cents
        FROM refund_replay
       GROUP BY sale_order_id, sale_item_id, role_type
    ),
    negative_pools AS (
      SELECT spir.sale_order_id, spir.sale_item_id, spia.role_type,
             ABS(ROUND(SUM(spia.allocated_amount::numeric) * 100))::bigint AS negative_allocated_cents
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spia.is_void = false
         AND spia.allocated_amount < 0
         AND spir.amount < 0
         AND sop.status = '已支付'
         AND sop.change_type = '退款'
       GROUP BY spir.sale_order_id, spir.sale_item_id, spia.role_type
    ),
    expected AS (
      SELECT ep.sale_order_id, ep.sale_item_id, ep.role_type,
             ep.positive_allocated_cents, ep.refund_receipt_cents,
             ep.expected_negative_cents,
             COALESCE(np.negative_allocated_cents, 0) AS actual_negative_cents
        FROM expected_pools ep
        LEFT JOIN negative_pools np
          ON np.sale_order_id = ep.sale_order_id
         AND np.sale_item_id = ep.sale_item_id
         AND np.role_type = ep.role_type
    )
    SELECT sale_order_id, sale_item_id, role_type,
           ROUND(positive_allocated_cents::numeric / 100, 2) AS positive_allocated,
           ROUND(refund_receipt_cents::numeric / 100, 2) AS refund_receipt,
           ROUND(expected_negative_cents::numeric / 100, 2) AS expected_negative,
           ROUND(actual_negative_cents::numeric / 100, 2) AS actual_negative
      FROM expected
     WHERE ABS(actual_negative_cents - expected_negative_cents) > 1
        OR actual_negative_cents > positive_allocated_cents + 1
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c1.length > 0) {
    details.push({ channel: 'sa_not_reversed', count: c1.length, samples: c1 })
  }

  // ── C1 通道入口兜底：负数退款主流水必须产生负数 receipt ──
  // 0 元退款只退项/扣次数，运行态合法地不写 receipt，因此必须保留 sop.amount < 0 过滤。
  const c1ReceiptMissing = (await db.execute(sql`
    SELECT sop.id AS sop_id, sop.sale_order_id, sop.ref_sale_item_id, sop.amount
      FROM sale_order_payments sop
     WHERE sop.status = '已支付'
       AND sop.change_type = '退款'
       AND sop.amount < 0
       AND NOT EXISTS (
         SELECT 1
           FROM sale_payment_item_receipts spir
          WHERE spir.sale_payment_id = sop.id
            AND spir.amount < 0
       )
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c1ReceiptMissing.length > 0) {
    details.push({
      channel: 'c1_receipt_missing',
      count: c1ReceiptMissing.length,
      samples: c1ReceiptMissing,
    })
  }

  // ── C2: service_commissions 应已 voided_at IS NOT NULL ──
  const c2 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.ref_sale_item_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    ),
    sc_status AS (
      SELECT r.sop_id, r.sale_order_id, r.ref_sale_item_id,
             COUNT(*) FILTER (WHERE sc.voided_at IS NOT NULL) AS voided,
             COUNT(sc.id)                                      AS total
      FROM refunds r
      LEFT JOIN sale_items s
        ON (r.ref_sale_item_id IS NOT NULL AND s.sale_item_id = r.ref_sale_item_id)
        OR (r.ref_sale_item_id IS NULL     AND s.sale_order_id = r.sale_order_id)
      LEFT JOIN service_items si ON si.sale_item_id = s.sale_item_id
      LEFT JOIN service_commissions sc ON sc.service_item_id = si.service_item_id
      GROUP BY r.sop_id, r.sale_order_id, r.ref_sale_item_id
    )
    SELECT sop_id, sale_order_id, ref_sale_item_id
    FROM sc_status
    WHERE total > 0 AND voided = 0
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c2.length > 0) {
    details.push({ channel: 'sc_not_voided', count: c2.length, samples: c2 })
  }

  // ── C3: user_coupons 应已恢复 ──
  // cascade 的恢复门槛是 expire_at > NOW()。审计若用 NOW() 会出现"审计跑得晚→券过期→误判"，
  // 因此用 sop.paid_at（退款 status 翻 '已支付' 的时间）对齐 cascade 当时的 NOW() 快照。
  const c3 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.paid_at
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
        AND sop.paid_at IS NOT NULL
    )
    SELECT r.sop_id, r.sale_order_id
    FROM refunds r
    WHERE EXISTS (
      SELECT 1 FROM user_coupons uc
      WHERE uc.used_sale_order_id = r.sale_order_id
        AND uc.status = '已使用'
        AND uc.expire_at > r.paid_at
    )
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c3.length > 0) {
    details.push({ channel: 'coupon_not_returned', count: c3.length, samples: c3 })
  }

  // ── C4: point_transactions 反向流水必须存在 ──
  // 修复（Bug O）：cascadeRefund 通道4 写的是「订单维度合并比例冲销」（一行 '消费冲销'，
  // amount = -round(grantedTotal × refunded/received)），非每笔赠送的等额负孪生。
  // 故改为「有正向赠送的已退款订单必须存在 '消费冲销' 行」，去掉精确等额匹配以消除部分/分期退款误报。
  const c4 = (await db.execute(sql`
    WITH refunds AS (
      SELECT DISTINCT sop.sale_order_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    )
    SELECT r.sale_order_id, MIN(pt_pos.user_id) AS user_id
    FROM refunds r
    JOIN point_transactions pt_pos
      ON pt_pos.ref_order_id = r.sale_order_id
     AND pt_pos.type IN ('消费赠送','回款赠送','获取')
     AND pt_pos.amount > 0
    WHERE NOT EXISTS (
      SELECT 1 FROM point_transactions pt_neg
      WHERE pt_neg.ref_order_id = r.sale_order_id
        AND pt_neg.type = '消费冲销'
    )
    GROUP BY r.sale_order_id
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c4.length > 0) {
    details.push({ channel: 'point_not_reversed', count: c4.length, samples: c4 })
  }

  // ── C5: picked_up_quantity 与 pickup_records 守恒（#154）──
  //
  // 旧判据是「原单提过货且 picked_up_quantity >= SUM(pickup_records)」即告警，写于 2026-06-08
  // 止血**之前**——那时 cascade 用减法回滚，picked_up < SUM(pickup_records) 才是正常态。
  // 止血改成把退款数**加进** picked_up 之后，该式对「既提过货又退过款」的行恒成立，
  // 即必然误报；#125 的转换折抵又加了一类。两库 pickup_records 至今为空，所以雷还没炸。
  //
  // #154 拆列后本列回归物理提货量本义，判据随之回到列本义、与退款彻底解耦，
  // 且迁移不留任何豁免行 —— 所以这是一条**全量**不变量：任何 sale_item 的
  // picked_up_quantity 都必须等于它的 pickup_records 合计（没有记录就必须是 0）。
  //
  // 初版曾为迁移保留的「历史提货未留记录」行开 EXISTS 豁免，双谱系评审指出那等于
  // 给巡检开了个正对着「删提货记录」逻辑的永久盲区（而该逻辑正是 C5 存在的理由）：
  // 一旦某行的 pickup_records 被删光而 picked_up 没归零，它就永远出圈了。
  // 现在迁移把那类行一律拦下，判据随之收紧为 FULL JOIN 的全量比对。
  //
  // 写成 EXISTS + 相关 SUM 子查询时 PG 不会合并这两个子计划，会对每个候选行各探一遍
  // pickup_records；聚合驱动只扫一次。
  const c5 = (await db.execute(sql`
    SELECT COALESCE(s.sale_item_id, p.sale_item_id) AS sale_item_id,
           COALESCE(s.picked_up_quantity, 0) AS current_picked,
           COALESCE(p.total_picked, 0) AS total_picked
    FROM sale_items s
    FULL JOIN (
           SELECT sale_item_id, SUM(pickup_quantity)::int AS total_picked
             FROM pickup_records
            GROUP BY sale_item_id
         ) p ON p.sale_item_id = s.sale_item_id
    WHERE COALESCE(s.picked_up_quantity, 0) <> COALESCE(p.total_picked, 0)
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c5.length > 0) {
    details.push({ channel: 'pickup_quantity_mismatch', count: c5.length, samples: c5 })
  }

  // ── C5b: 「已结算」不得超过购买件数（#154）──
  // 这条不变量的**权威表达**是迁移 0043 的 CHECK 约束 chk_sale_item_settled_le_quantity，
  // 它不可能被绕过；各写入点 UPDATE 的 WHERE 守卫负责把冲突转成友好的 CONFLICT 而不是 23514。
  // 本项是二道保险：约束若被误 DROP（运维手滑、pg_restore 漏建），这里仍能次日发现。
  // ⚠ 谓词是表达式、用不上索引，本项**设计为全表扫**（日频、百毫秒级，可接受）。
  const c5b = (await db.execute(sql`
    SELECT s.sale_item_id, s.quantity,
           COALESCE(s.picked_up_quantity, 0) AS picked_up_quantity,
           COALESCE(s.refunded_quantity, 0) AS refunded_quantity,
           COALESCE(s.converted_quantity, 0) AS converted_quantity
    FROM sale_items s
    WHERE COALESCE(s.picked_up_quantity, 0)
        + COALESCE(s.refunded_quantity, 0)
        + COALESCE(s.converted_quantity, 0) > s.quantity
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c5b.length > 0) {
    details.push({ channel: 'settled_quantity_overflow', count: c5b.length, samples: c5b })
  }

  // ── C5c: converted_quantity 与转出行聚合守恒（#154）──
  // 三列里它是唯一「有独立交叉源」的：转出行本身就是折抵的凭证。
  // picked_up 有 C5、settled 有 CHECK 约束，converted 此前无人看 ——
  // 折抵关闭回退漏跑或写错列只能靠 C5b 的上限检查间接发现，而「少减」根本发现不了。
  const c5c = (await db.execute(sql`
    SELECT COALESCE(s.sale_item_id, o.ref_sale_item_id) AS sale_item_id,
           COALESCE(s.converted_quantity, 0) AS current_converted,
           COALESCE(o.total_converted, 0) AS total_converted
    FROM sale_items s
    FULL JOIN (
           SELECT out_item.ref_sale_item_id, SUM(out_item.quantity)::int AS total_converted
             FROM sale_items out_item
             JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
            WHERE out_item.item_direction = '转出'
              AND out_item.product_type = '家居产品'
              AND out_item.ref_sale_item_id IS NOT NULL
              AND conv_order.status <> '已关闭'
            GROUP BY out_item.ref_sale_item_id
         ) o ON o.ref_sale_item_id = s.sale_item_id
    WHERE COALESCE(s.converted_quantity, 0) <> COALESCE(o.total_converted, 0)
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c5c.length > 0) {
    details.push({ channel: 'converted_quantity_mismatch', count: c5c.length, samples: c5c })
  }

  if (details.length > 0) {
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'refund_cascade_coverage',
      date: dateStamp,
      total: details.length,
      violations: details,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_refund_cascade', 'cascade_violation', ${dateStamp},
              ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = details.map((d) => `- ${d.channel}: ${d.count} 条 mismatch`)
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_refund_cascade',
        '退款 5 通道级联巡检发现 mismatch：',
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { violations: details.length, details }
}
