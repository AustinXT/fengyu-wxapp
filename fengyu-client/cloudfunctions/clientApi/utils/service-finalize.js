/**
 * 服务单 finalize 副作用（待客户确认 → 已完成）—— 客户端独立副本。
 *
 * 跨端独立副本：核心 SQL（扣减 UPDATE / commission_rate_matrix SELECT /
 * service_commissions INSERT ON CONFLICT / 状态 UPDATE / 关预约 UPDATE）与
 * staffApi routes/service.js 的 finalizeServiceOrder 字面一致；
 * admin confirmServiceOrder（fengyu-admin/src/actions/services.ts）经
 * lib/service-commission-settle.ts 镜像同口径（Drizzle sql 归一化后等价）。
 * 由 fengyu-staff .../cross-end-sql-snapshot.test.js「服务单 finalize 跨端 SQL 一致性守护」守护。改一端必同步其它端。
 *
 * 顾客在小程序点「确认服务完成」时调用。operation_logs 的 operator 在客户端为系统级
 * （operator_employee_id=null），source='clientApi'——该 INSERT 不纳入跨端字面量 snapshot。
 */

const pg = require('../db/pg')
const { DEPOSIT_REFUND_REMARK } = require('./deposit-refund-remark')

/**
 * 加载服务单的所有 service_items + 关联 sale_items 快照 + 员工 skills。
 */
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

/**
 * 在外层事务内执行 finalize 副作用。
 * @returns {boolean} 状态翻转是否成功；false 表示已被其它入口（店长代确认）确认（幂等）
 */
async function finalizeServiceOrder(client, so, items, now) {
  const serviceOrderId = so.service_order_id

  // 原子扣减每条订单行的剩余次数。
  // 可核销门店由 service.create 的「顾客绑定门店」校验把关，此处仅按 sale_item_id 扣减、不再比卡售出门店（卡跟顾客走）。
  for (const item of items) {
    // 原子扣减条件叠加 paid_sessions 限额（ticket 2026-05-19）：
    //   扣减后已用次数 (session_count - (remaining - sessionUsed)) 不得超 paid_sessions
    //   paid_sessions NULL 视为 session_count（兼容历史数据 / 旧 fixture）
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

    // 查询扣减后剩余次数，若归零则关闭对应预约
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

  // ========== 计算并写入服务提成（service_commissions）==========
  // 双字段模型：fixed_fee = service_fee × session_used
  //            consume_amount = unit_real_price × session_used × commission_rate
  //            commission_amount = fixed_fee + consume_amount
  // 说明：sale_items/service_items.unit_real_price 已是 per-session 单次价（如 5次卡 3500/5=700），
  //       直接作为每次消耗基准，无需再 ÷session_count。
  // roleType 取员工 skills[0] 自动推断；无 skills 兜底 '美容师'
  // commission_rate 缺失时 rate=0 + 写 operation_logs，不阻塞确认
  for (const row of items) {
    // 寄存单退款单（M8）：真扣次数、假消耗 → 跳过提成写入（service.create 已强制 remark 打标；此为 finalize 兜底防漏）
    if (so.remark === DEPOSIT_REFUND_REMARK) continue

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

    // rate=0 且有消耗金额时，提示运维补齐矩阵规则（客户端 operator 为系统级 null）
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

    // INSERT 提成记录：ON CONFLICT 保证幂等（partial unique index where is_void=false）
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

  // 更新服务单状态（WHERE 锁定当前状态防止并发竞态）+ 同步 commission_status
  const soUpdateResult = await client.query(
    "UPDATE service_orders SET status = '已完成', completed_at = $1, commission_status = '已分配', updated_at = $1 WHERE service_order_id = $2 AND status = '待客户确认'",
    [now, serviceOrderId]
  )
  if (soUpdateResult.rowCount === 0) {
    return false
  }

  // 如关联预约，将预约状态更新为已完成
  if (so.appointment_id) {
    await client.query(
      "UPDATE appointments SET status = '已完成', updated_at = $1 WHERE appointment_id = $2 AND status = '已确认'",
      [now, so.appointment_id]
    )
  }

  return true
}

module.exports = { loadServiceItems, finalizeServiceOrder }
