/**
 * 服务单确认（待客户确认 → 已完成）时计算并写入服务提成 —— admin 独立副本。
 *
 * 镜像 staff finalizeServiceOrder（fengyu-staff/cloudfunctions/staffApi/routes/service.js:463-547）
 * 与 client finalizeServiceOrder（fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js:100-168）。
 * 核心三段 SQL（commission_rate_matrix SELECT / service_commissions INSERT ON CONFLICT /
 * commission_status UPDATE）三端字面一致，由
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
 * 「服务单 finalize 跨端 SQL 一致性守护」block 守护。改一端必同步其它端 + 跑 snapshot。
 *
 * 与 staff/client 一致：commission_rate 缺失（rate=0 且有消耗金额）时落 rate=0 行 + 写
 * operation_logs 'service.complete.rate_missing'，不阻塞确认（容错口径，区别于手存
 * service-commissions.ts 的 throw 口径）。
 *
 * 与 staff/client 一致：寄存单退款单（service_orders.remark === DEPOSIT_REFUND_REMARK，
 * 真扣次数、假消耗）跳过提成写入，仅置 commission_status='已分配'（镜像 staff
 * finalizeServiceOrder service.js:494 / client service-finalize.js:105 的 per-item continue）。
 *
 * 调用方须在外层 db.transaction 内、扣减次数 + 置「已完成」成功后调用。
 */

import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'

/** 可执行 SQL 的对象（db 顶层或事务 tx 均可） */
type SqlExecutor = Pick<typeof db, 'execute'> | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** operation_logs 的操作者信息（admin 代确认场景从 AuthSession 映射而来） */
export type CommissionOperator = {
  employeeId: string | null
  name: string | null
  role: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 为指定服务单计算并写入所有 service_items 的服务提成，并把 commission_status 置「已分配」。
 * 幂等：service_commissions 用 ON CONFLICT DO NOTHING；commission_status 重复置无副作用。
 */
export async function settleServiceCommissions(
  executor: SqlExecutor,
  serviceOrderId: string,
  operator: CommissionOperator,
): Promise<void> {
  // 1. 加载 service_items + 关联 sale_items 快照 + 员工 skills（role_type 推断用）
  const itemsRows = (await executor.execute(sql`
    SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.employee_id,
           sit.unit_real_price,
           si.service_fee, si.sales_category, si.session_count,
           swu.skills
    FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    LEFT JOIN staff_wechat_users swu ON swu.employee_id = sit.employee_id
    WHERE sit.service_order_id = ${serviceOrderId}
  `)) as unknown as Array<{
    service_item_id: string
    sale_item_id: string
    session_used: number | string
    employee_id: string
    unit_real_price: string | number | null
    service_fee: string | number | null
    sales_category: string | null
    session_count: number | string | null
    skills: unknown
  }>

  // 寄存单退款单（M8）：真扣次数、假消耗 → 跳过提成写入（镜像 staff service.js:494 /
  // client service-finalize.js:105 的 `if (so.remark === DEPOSIT_REFUND_REMARK) continue`）。
  // service.create 不再强制 remark 打标（空备注按正常消耗计业绩），此处为 finalize 兜底防漏。⚠ commission_status='已分配'
  // 仍在循环后无条件置（与 staff/client 一致——它们也把 commission_status 写进无条件的状态翻转 UPDATE）。
  const remarkRows = (await executor.execute(sql`
    SELECT remark FROM service_orders WHERE service_order_id = ${serviceOrderId}
  `)) as unknown as Array<{ remark: string | null }>
  const isDepositRefund = remarkRows[0]?.remark === DEPOSIT_REFUND_REMARK

  // ========== 计算并写入服务提成（service_commissions）==========
  // 双字段模型：fixed_fee = service_fee × session_used
  //            consume_amount = unit_real_price × session_used × commission_rate
  //            commission_amount = fixed_fee + consume_amount
  // 说明：sale_items/service_items.unit_real_price 已是 per-session 单次价（如 5次卡 3500/5=700），
  //       直接作为每次消耗基准，无需再 ÷session_count。
  // roleType 取员工 skills[0] 自动推断；无 skills 兜底 '美容师'（与 staff/client 一致）
  for (const row of itemsRows) {
    if (isDepositRefund) continue

    const skills = Array.isArray(row.skills) ? (row.skills as unknown[]) : []
    const roleType = (skills[0] as string) || '美容师'

    const sessionUsed = Number(row.session_used)
    const fixedFee = round2(Number(row.service_fee || 0) * sessionUsed)
    const perSession = Number(row.unit_real_price || 0)
    const consumeBase = round2(perSession * sessionUsed)

    // 2. 查 commission_rate_matrix（org_id via stores→org_nodes 市场节点）
    const rateRows = (await executor.execute(sql`
      SELECT commission_rate FROM commission_rate_matrix
       WHERE order_type = '服务单'
         AND role_type = ${roleType}
         AND sales_category = ${row.sales_category}
         AND amount_tier_min <= ${consumeBase}
         AND (amount_tier_max IS NULL OR amount_tier_max >= ${consumeBase})
         AND org_id = (
           SELECT m.id FROM service_orders so
             JOIN stores s ON so.store_id = s.store_id
             JOIN org_nodes son ON s.org_node_id = son.id
             JOIN org_nodes m ON son.parent_id = m.id
            WHERE so.service_order_id = ${serviceOrderId}
         )
       ORDER BY amount_tier_min DESC
       LIMIT 1
    `)) as unknown as Array<{ commission_rate: string | number | null }>
    const rate = Number(rateRows[0]?.commission_rate || 0)
    const consumeAmount = round2(consumeBase * rate)
    const commissionAmount = round2(fixedFee + consumeAmount)

    // 3. rate=0 且有消耗金额时，提示运维补齐矩阵规则（容错不 throw，与 staff/client finalize 一致）
    if (rate === 0 && consumeBase > 0) {
      await executor.execute(sql`
        INSERT INTO operation_logs
          (operator_employee_id, operator_name, operator_role, action, target_type, target_id, detail, source, created_at)
        VALUES (
          ${operator.employeeId}, ${operator.name}, ${operator.role},
          'service.complete.rate_missing', 'service_item', ${row.service_item_id},
          ${JSON.stringify({ roleType, salesCategory: row.sales_category, consumeBase, serviceOrderId })}::jsonb,
          'admin', NOW()
        )
      `)
    }

    // 4. INSERT 提成记录：ON CONFLICT 保证幂等（partial unique index where is_void=false）
    //    注意：uq_svc_comm_item_emp_role 是 partial unique INDEX 不是 CONSTRAINT，
    //    ON CONFLICT ON CONSTRAINT 形式会报 "constraint does not exist"，必须用列推断 + WHERE。
    await executor.execute(sql`
      INSERT INTO service_commissions (
        service_item_id, employee_id, role_type, allocation_ratio,
        commission_rate, commission_amount, fixed_fee, consume_amount, is_void
      ) VALUES (
        ${row.service_item_id}, ${row.employee_id}, ${roleType}, 1.00,
        ${rate}, ${commissionAmount}, ${fixedFee}, ${consumeAmount}, FALSE
      )
      ON CONFLICT (service_item_id, employee_id, role_type) WHERE is_void = false
      DO NOTHING
    `)
  }

  // 5. 同步 commission_status（与 staff/client finalize 一致）。⚠ CAS 守卫
  // （commission_status NULL|'待分配' → '已分配' 状态机翻转）：
  //   - service_orders.commission_status 无 DB default，三端 INSERT 均不写 → 建单初值是
  //     **NULL**（不是 '待分配'；'待分配' 只在 staff serviceCommission.save 清空重分配时出现）。
  //     故守卫必须含 IS NULL，否则 admin 代确认永远 0 行、状态留 NULL：
  //     staff 端列表渲染成 "null"、serviceCommission.save 报「服务单提成状态异常」，
  //     admin 服务提成导出两段（待分配/已分配）双双漏单。（2026-09-04 修复）
  //   - 重入/重试时已为 '已分配' → 0 行 no-op（仍有幂等性与 M1 寄存退款无副作用）
  // staff/client 等效机制在状态翻转 UPDATE（status='待客户确认'→'已完成'）中捆绑
  // commission_status；admin 此更新独立于 CTE，故须自有 CAS 防并发/重入错位。
  await executor.execute(sql`
    UPDATE service_orders
       SET commission_status = '已分配', updated_at = NOW()
     WHERE service_order_id = ${serviceOrderId}
       AND (commission_status IS NULL OR commission_status = '待分配')
  `)
}
