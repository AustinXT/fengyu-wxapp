/**
 * 退款级联回滚（cascadeRefund）—— 逐 item + 语义收敛
 *
 * 2026-04-26 sale-order-domain-refactor 新建；2026-06-08 重构（Bug Q/M）：
 *   - 改为按本次退款明细逐 item 级联（params.items），不再用单 saleItemId / null 整单分支；
 *     修复「多项退真子集误走整单分支清掉未退明细的分配/提成/券/提货」（Bug Q）。
 *   - 通道 3（券）仅整单全退（isWholeOrderRefund）才回滚。
 *
 * 2026-06-24 退款联级重构（记负数冲销）：
 *   - 通道 1（销售提成 sale_allocations）：由「软删 is_void」改为「记负数冲销」——对所有被退 item
 *     按本次实退额（params.items[].refundAmount）记负数镜像行（保留原正数行，报表 SUM 自动净额化），
 *     负数行挂退款流水 id（params.refundPaymentId）。消费过的卡退剩余次数 → 等比部分冲销，已消费业绩保留。
 *   - 通道 2（服务提成 service_commissions）：保持软删（仅零消费 isFullItemRefund item，恒 no-op）——
 *     已消费次数的服务提成保留（退的是未消费次数，本无服务提成）。
 *
 * 在退款审批通过（approveRefund）的同事务内调用。
 *
 * **修改本文件必须同步 fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js**
 * （独立副本设计，用户 veto cloudfunctions-shared 抽取；漂移由
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * `'SUMMARY v3 §2 #14'` describe 块的 5 通道 keyword 守护捕获）。
 */

import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'

export type TransactionLike = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 可执行 SQL 的对象（db 顶层或事务 tx 均可） */
type SqlExecutor = Pick<typeof db, 'execute'> | TransactionLike

/**
 * 待审批退款冻结判定（Bug I）：订单存在待审批退款时返回 true，调用方返回 {success:false} 阻止操作。
 * admin action 范式用返回值（throw 会冒泡成 500 且生产脱敏）；SQL 谓词镜像 staff utils/refund.js。
 */
export async function hasPendingRefund(executor: SqlExecutor, saleOrderId: string): Promise<boolean> {
  if (!saleOrderId) return false
  const r = await executor.execute(sql`
    SELECT 1 FROM sale_order_payments
    WHERE sale_order_id = ${saleOrderId} AND change_type = '退款' AND status = '待审批' LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}

/** 按服务单反查其涉及的所有订单是否有待审批退款（confirmServiceOrder 用）。 */
export async function hasPendingRefundByServiceOrder(
  executor: SqlExecutor,
  serviceOrderId: string,
): Promise<boolean> {
  if (!serviceOrderId) return false
  const r = await executor.execute(sql`
    SELECT 1 FROM service_items sit
      JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
     WHERE sit.service_order_id = ${serviceOrderId} AND sop.change_type = '退款' AND sop.status = '待审批' LIMIT 1
  `)
  return (r as unknown as unknown[]).length > 0
}

/** 退款通知：发起 → 门店店长（自审降噪）。executor 须事务内 tx。Bug C；SQL 谓词镜像 staff utils/refund.js。 */
export async function notifyRefundCreated(
  executor: SqlExecutor,
  p: { paymentId: number; saleOrderId: string; storeId: string | null; operatorId: string | null; amount: number; customerName: string | null },
): Promise<void> {
  if (!p.storeId) return
  const mgrs = await executor.execute(sql`
    SELECT DISTINCT pr.employee_id FROM permission_roles pr
      JOIN stores s ON s.org_node_id = pr.scope_id
     WHERE pr.role = 'manager' AND s.store_id = ${p.storeId}
  `)
  for (const m of mgrs as unknown as Array<{ employee_id: string }>) {
    if (m.employee_id === p.operatorId) continue
    await executor.execute(sql`
      INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
      VALUES ('员工', ${m.employee_id}, '退款待审批', ${`${p.customerName || '顾客'}的订单 ${p.saleOrderId} 发起退款 ¥${p.amount}，请及时审批`}, 'order', ${`refund-created-${p.paymentId}-${m.employee_id}`}, 'sale_order_payment', ${String(p.paymentId)}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }
}

/** 退款审批结果通知：通过/驳回 → 发起人。executor 须事务内 tx。Bug C。 */
export async function notifyRefundResult(
  executor: SqlExecutor,
  p: { paymentId: number; saleOrderId: string; recipientEmployeeId: string | null; approved: boolean; reason?: string; amount: number },
): Promise<void> {
  if (!p.recipientEmployeeId) return
  const title = p.approved ? '退款已通过' : '退款已驳回'
  const body = p.approved
    ? `订单 ${p.saleOrderId} 退款 ¥${p.amount} 已审批通过`
    : `订单 ${p.saleOrderId} 退款申请被驳回${p.reason ? '：' + p.reason : ''}`
  const key = p.approved ? `refund-approved-${p.paymentId}` : `refund-rejected-${p.paymentId}`
  await executor.execute(sql`
    INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, ref_entity_type, ref_entity_id, created_at)
    VALUES ('员工', ${p.recipientEmployeeId}, ${title}, ${body}, 'order', ${key}, 'sale_order_payment', ${String(p.paymentId)}, NOW())
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  `)
}

export interface CascadeRefundItem {
  saleItemId: string
  /** 退疗程卡/家居的数量；NULL 时通道 5 跳过 */
  sessionCount: number | null
  /** 本次该 item 的退款金额（元）；通道 1 据此记负数冲销销售提成。NULL/0 → 通道 1 跳过该 item */
  refundAmount: number | null
  /** 该 item 本次是否零消费全退（控制通道 2 服务提成门控 + 通道 3 整单券判定；通道 1 不再依赖） */
  isFullItemRefund: boolean
}

export interface CascadeRefundParams {
  /** 被退款的原销售单 ID */
  saleOrderId: string
  /** 退款流水 sale_order_payments.id —— 通道 1 负数冲销行的 sale_payment_id 归属键 */
  refundPaymentId: number
  /** 本次退款涉及的明细行 */
  items: CascadeRefundItem[]
  /** 是否整单全退（所有购买项全退）→ 控制 user_coupons 回滚 */
  isWholeOrderRefund: boolean
  /** 退款原因；写入 voided_reason */
  refundReason: string
}

export interface CascadeRefundResult {
  voidedAllocations: number
  voidedCommissions: number
  refundedCoupons: number
  reversedPoints: number
  rolledBackPickups: number
}

export async function cascadeRefund(
  tx: TransactionLike,
  params: CascadeRefundParams,
): Promise<CascadeRefundResult> {
  const { saleOrderId, refundPaymentId, items, isWholeOrderRefund, refundReason } = params
  const reason = `退款审批通过：${refundReason ?? ''}`.slice(0, 500)

  // 兜底：items 为空（老退款行 / 整单退无明细）→ 查所有购买项视为全退（兼容历史数据）
  let effItems = Array.isArray(items) ? items.filter((it) => it && it.saleItemId) : []
  let wholeOrder = !!isWholeOrderRefund
  if (effItems.length === 0) {
    const r = await tx.execute(sql`
      SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
    `)
    const rows = (r as unknown as Array<{ sale_item_id: string }>) ?? []
    effItems = rows.map((x) => ({ saleItemId: x.sale_item_id, sessionCount: null, refundAmount: null, isFullItemRefund: true }))
    wholeOrder = true
  }

  // 仅「零消费全退」item 才作废服务提成（通道 2）+ 参与整单券判定（通道 3）；通道 1 不再依赖（Bug M 语义收敛）
  const fullItemIds = effItems.filter((it) => it.isFullItemRefund).map((it) => it.saleItemId)

  // ── 1) sale_allocations 记负数冲销（销售提成）：对所有被退 item 按实退额冲销 ───────────
  // 业务口径（2026-06-24）：退款撤销营业额分配 = 记负数（保留原正数行 + 新增负数镜像行，报表 SUM 自动净额化）。
  // item 级目标冲销额 = min(本次该 item 退款额, 该 item 活跃正数分配 Σtotal_amount)，按各 (emp,role) 行
  // total_amount 权重最大余数法分摊到分；负数行挂退款流水 id（新维度，不撞 uq_sale_alloc_item_emp_role_payment）。
  // 消费过的卡退剩余次数 → 退额 < 已分配额 → 等比部分冲销，已消费部分业绩保留。两端镜像 staff helpers/refund-cascade.js。
  let voidedAllocations = 0
  for (const it of effItems) {
    const refundAmt = Number(it.refundAmount || 0)
    if (refundAmt <= 0) continue
    const allocRows = (await tx.execute(sql`
      SELECT employee_id, role_type,
             MAX(allocation_ratio) AS ratio,
             MAX(department_name) AS dept,
             SUM(total_amount::numeric) AS sum_total,
             MAX(commission_rate) AS rate,
             COALESCE(SUM(commission_amount::numeric), 0) AS sum_comm
      FROM sale_allocations
      WHERE sale_item_id = ${it.saleItemId} AND is_void = false AND total_amount > 0
      GROUP BY employee_id, role_type
    `)) as unknown as Array<{
      employee_id: string; role_type: string; ratio: string
      dept: string | null; sum_total: string; rate: string | null; sum_comm: string
    }>
    if (allocRows.length === 0) continue
    const baseCents = allocRows.reduce((s, r) => s + Math.round(Number(r.sum_total) * 100), 0)
    if (baseCents <= 0) continue
    const targetCents = Math.min(Math.round(refundAmt * 100), baseCents)
    // 最大余数法：按各组 total_amount 权重分摊 targetCents，余数逐分补给小数部分最大者（精确到分）
    const parts = allocRows.map((r) => {
      const wCents = Math.round(Number(r.sum_total) * 100)
      const exact = (targetCents * wCents) / baseCents
      const floorC = Math.floor(exact)
      return { r, cents: floorC, frac: exact - floorC }
    })
    const rem = targetCents - parts.reduce((s, p) => s + p.cents, 0)
    parts.sort((a, b) => b.frac - a.frac)
    for (let i = 0; i < rem; i++) parts[i].cents += 1
    for (const p of parts) {
      if (p.cents <= 0) continue
      const voidTotal = p.cents / 100
      const sumTotal = Number(p.r.sum_total)
      const sumComm = Number(p.r.sum_comm || 0)
      // 提成按该组 total→comm 比例同步冲销（保持原提成率），精确到分
      const voidComm = sumTotal > 0 ? Math.round((sumComm * voidTotal) / sumTotal * 100) / 100 : 0
      await tx.execute(sql`
        INSERT INTO sale_allocations
          (sale_item_id, employee_id, role_type, department_name, allocation_ratio,
           total_amount, commission_rate, commission_amount, sale_payment_id, is_void, created_at, updated_at)
        VALUES (${it.saleItemId}, ${p.r.employee_id}, ${p.r.role_type}, ${p.r.dept ?? null}, ${p.r.ratio},
                ${(-voidTotal).toFixed(2)}, ${p.r.rate ?? null}, ${(-voidComm).toFixed(2)}, ${refundPaymentId}, false, NOW(), NOW())
        ON CONFLICT (sale_item_id, employee_id, role_type, sale_payment_id) WHERE is_void = false DO NOTHING
      `)
      voidedAllocations += 1
    }
  }

  // ── 2) service_commissions 软删（仅全退 item） ──────────────────────
  let voidedCommissions = 0
  if (fullItemIds.length > 0) {
    const res = await tx.execute(sql`
      UPDATE service_commissions
         SET voided_at = NOW(),
             voided_reason = ${reason},
             is_void = true,
             updated_at = NOW()
       WHERE service_item_id IN (
               SELECT si.service_item_id
               FROM service_items si
               WHERE si.sale_item_id IN (${sql.join(fullItemIds.map((id) => sql`${id}`), sql`, `)})
             )
         AND voided_at IS NULL
    `)
    voidedCommissions = rowsAffected(res)
  }

  // ── 3) user_coupons 已用且未过期券恢复（仅整单全退） ──────────────
  let refundedCoupons = 0
  if (wholeOrder) {
    const res = await tx.execute(sql`
      UPDATE user_coupons
         SET status = '未使用',
             used_at = NULL,
             used_sale_order_id = NULL,
             updated_at = NOW()
       WHERE used_sale_order_id = ${saleOrderId}
         AND status = '已使用'
         AND (expire_at IS NULL OR expire_at > NOW())
    `)
    refundedCoupons = rowsAffected(res)
  }

  // ── 4) point_transactions 比例冲销 + client_wechat_users.points_balance 重算（订单级） ──
  let reversedPoints = 0
  {
    const giftRes = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS g, MIN(user_id) AS user_id
      FROM point_transactions
      WHERE ref_order_id = ${saleOrderId}
        AND type IN ('消费赠送', '回款赠送', '获取')
        AND amount > 0
    `)
    const giftRow = (giftRes as unknown as Array<{ g: unknown; user_id: unknown }>)[0]
    const grantedTotal = Number(giftRow?.g ?? 0)
    const pointUserId = giftRow?.user_id != null ? String(giftRow.user_id) : null

    if (grantedTotal > 0 && pointUserId) {
      const orderRes = await tx.execute(sql`
        SELECT received, COALESCE(refunded_amount, 0) AS refunded
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
      `)
      const orderRow = (orderRes as unknown as Array<{ received: unknown; refunded: unknown }>)[0]
      const received = Number(orderRow?.received ?? 0)
      const refunded = Number(orderRow?.refunded ?? 0)
      const target = received > 0 ? Math.round((grantedTotal * refunded) / received) : grantedTotal
      await tx.execute(sql`
        INSERT INTO point_transactions (
          user_id, ref_order_id, type, amount, created_at
        )
        VALUES (${pointUserId}, ${saleOrderId}, '消费冲销', ${-target}, NOW())
        ON CONFLICT (user_id, ref_order_id, type)
          WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
        DO UPDATE SET amount = EXCLUDED.amount
      `)
      reversedPoints = target
      await tx.execute(sql`
        UPDATE client_wechat_users c
           SET points_balance = COALESCE((
                 SELECT SUM(pt.amount) FROM point_transactions pt WHERE pt.user_id = c.user_id
               ), 0),
               points_updated_at = NOW(),
               updated_at = NOW()
         WHERE c.user_id = ${pointUserId}
      `)
    }
  }

  // ── 5) 家居退款计入已结算（逐被退家居 item，按退款数量） ──
  // 修复（家居提货账 schema-free 止血 2026-06-08）：退家居退的是「未提货」数量，
  // 原 GREATEST(0, picked_up - qty) 错把退款数从已提货里减 → 损坏提货账 + refundable
  // (=quantity-picked_up) 回升致可重复退（资损）。改为把已退数计入 picked_up（语义升级为
  // 「已结算」= 已提货 + 已退），LEAST(quantity) 封顶，使 refundable 正确归零、不可超退。
  // 代价：picked_up 不再纯指已物理提货（pickup_records 仍是真实提货源）；彻底分离待 refunded_quantity 列。
  // 字段名 rolledBackPickups 保留（跨端 snapshot 守护），语义现为「计入已结算的家居退款行数」。
  let rolledBackPickups = 0
  for (const it of effItems) {
    const qty = it.sessionCount && Number(it.sessionCount) > 0 ? Number(it.sessionCount) : null
    if (!qty) continue
    const res = await tx.execute(sql`
      UPDATE sale_items
         SET picked_up_quantity = LEAST(quantity, COALESCE(picked_up_quantity, 0) + ${qty}),
             updated_at = NOW()
       WHERE sale_item_id = ${it.saleItemId}
         AND product_type = '家居产品'
    `)
    rolledBackPickups += rowsAffected(res)
  }

  return {
    voidedAllocations,
    voidedCommissions,
    refundedCoupons,
    reversedPoints,
    rolledBackPickups,
  }
}
