

import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'


type SqlExecutor = Pick<typeof db, 'execute'> | Parameters<Parameters<typeof db.transaction>[0]>[0]


export type CommissionOperator = {
  employeeId: string | null
  name: string | null
  role: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100


export async function settleServiceCommissions(
  executor: SqlExecutor,
  serviceOrderId: string,
  operator: CommissionOperator,
): Promise<void> {
  
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

  
  
  
  
  const remarkRows = (await executor.execute(sql`
    SELECT remark FROM service_orders WHERE service_order_id = ${serviceOrderId}
  `)) as unknown as Array<{ remark: string | null }>
  const isDepositRefund = remarkRows[0]?.remark === DEPOSIT_REFUND_REMARK

  
  
  
  
  
  
  
  for (const row of itemsRows) {
    if (isDepositRefund) continue

    const skills = Array.isArray(row.skills) ? (row.skills as unknown[]) : []
    const roleType = (skills[0] as string) || '美容师'

    const sessionUsed = Number(row.session_used)
    const fixedFee = round2(Number(row.service_fee || 0) * sessionUsed)
    const perSession = Number(row.unit_real_price || 0)
    const consumeBase = round2(perSession * sessionUsed)

    
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

  
  
  
  
  
  
  await executor.execute(sql`
    UPDATE service_orders
       SET commission_status = '已分配', updated_at = NOW()
     WHERE service_order_id = ${serviceOrderId}
       AND commission_status = '待分配'
  `)
}
