

const pg = require('../db/pg')


async function loadServiceItems(serviceOrderId) {
  return await pg.query(
    `SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.employee_id,
            sit.unit_real_price,
            si.service_fee, si.sales_category, si.session_count, si.quantity,
            swu.skills
     FROM service_items sit
     JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     LEFT JOIN staff_wechat_users swu ON swu.employee_id = sit.employee_id
     WHERE sit.service_order_id = $1`,
    [serviceOrderId]
  )
}


async function finalizeServiceOrder(client, so, items, now) {
  const serviceOrderId = so.service_order_id

  
  
  for (const item of items) {
    
    
    
    const updateResult = await client.query(
      `UPDATE sale_items
       SET remaining_sessions = remaining_sessions - $1
       WHERE sale_item_id = $2
         AND remaining_sessions >= $1
         AND remaining_sessions IS NOT NULL
         AND (session_count - remaining_sessions + $1) <= COALESCE(paid_sessions, session_count)`,
      [item.session_used, item.sale_item_id]
    )

    if (updateResult.rowCount === 0) {
      const checkRows = await client.query(
        'SELECT store_id, session_count, remaining_sessions, paid_sessions FROM sale_items WHERE sale_item_id = $1',
        [item.sale_item_id]
      )
      if (checkRows.rows.length === 0) {
        throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 不存在`)
      }
      const probe = checkRows.rows[0]
      if (probe.remaining_sessions !== null && probe.remaining_sessions < item.session_used) {
        throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}`)
      }
      if (probe.session_count !== null) {
        const paid = probe.paid_sessions == null ? 0 : Number(probe.paid_sessions)
        const usedNow = Number(probe.session_count) - Number(probe.remaining_sessions)
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.sale_item_id} 已支付次数不足（已付 ${paid}/${probe.session_count}，已用 ${usedNow}，本次需 ${item.session_used}），请先完成付款`)
      }
      throw new Error(`INVALID_PARAMS: 订单行 ${item.sale_item_id} 扣减失败`)
    }

    
    const remainRows = await client.query(
      'SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1',
      [item.sale_item_id]
    )

    if (remainRows.rows.length > 0 && remainRows.rows[0].remaining_sessions === 0) {
      await client.query(
        `UPDATE appointments
         SET status = '已关闭', updated_at = $1
         WHERE sale_item_id = $2
           AND status IN ('待确认', '已确认')`,
        [now, item.sale_item_id]
      )
    }
  }

  
  
  
  
  
  
  
  
  for (const row of items) {
    const skills = Array.isArray(row.skills) ? row.skills : []
    const roleType = skills[0] || '美容师'

    const fixedFee = Math.round(Number(row.service_fee || 0) * row.session_used * 100) / 100
    const perSession = Number(row.unit_real_price || 0)
    const consumeBase = Math.round(perSession * row.session_used * 100) / 100

    const rateRows = await client.query(
      `SELECT commission_rate FROM commission_rate_matrix
       WHERE order_type = '服务单'
         AND role_type = $1
         AND sales_category = $2
         AND amount_tier_min <= $3
         AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
         AND org_id = (
           SELECT m.id FROM service_orders so
             JOIN stores s ON so.store_id = s.store_id
             JOIN org_nodes son ON s.org_node_id = son.id
             JOIN org_nodes m ON son.parent_id = m.id
            WHERE so.service_order_id = $4
         )
       ORDER BY amount_tier_min DESC
       LIMIT 1`,
      [roleType, row.sales_category, consumeBase, serviceOrderId]
    )
    const rate = Number(rateRows.rows[0]?.commission_rate || 0)
    const consumeAmount = Math.round(consumeBase * rate * 100) / 100
    const commissionAmount = Math.round((fixedFee + consumeAmount) * 100) / 100

    
    if (rate === 0 && consumeBase > 0) {
      await client.query(
        `INSERT INTO operation_logs
           (operator_employee_id, operator_name, operator_role, action, target_type, target_id, detail, source, created_at)
         VALUES (NULL, NULL, NULL, 'service.confirm.rate_missing', 'service_item', $1, $2::jsonb, 'clientApi', NOW())`,
        [
          row.service_item_id,
          JSON.stringify({ roleType, salesCategory: row.sales_category, consumeBase, serviceOrderId }),
        ]
      )
    }

    
    await client.query(
      `INSERT INTO service_commissions (
         service_item_id, employee_id, role_type, allocation_ratio,
         commission_rate, commission_amount, fixed_fee, consume_amount,
         is_void
       ) VALUES ($1, $2, $3, 1.00, $4, $5, $6, $7, FALSE)
       ON CONFLICT (service_item_id, employee_id, role_type) WHERE is_void = false
       DO NOTHING`,
      [
        row.service_item_id,
        row.employee_id,
        roleType,
        rate,
        commissionAmount,
        fixedFee,
        consumeAmount,
      ]
    )
  }

  
  const soUpdateResult = await client.query(
    "UPDATE service_orders SET status = '已完成', completed_at = $1, commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND status = '待客户确认'",
    [now, serviceOrderId]
  )
  if (soUpdateResult.rowCount === 0) {
    return false
  }

  
  if (so.appointment_id) {
    await client.query(
      "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
      [now, so.appointment_id]
    )
  }

  return true
}

module.exports = { loadServiceItems, finalizeServiceOrder }
