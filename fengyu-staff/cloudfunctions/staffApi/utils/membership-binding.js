/** 首次入会前必须已有人工归属。调用方负责真实入会金额判定，成功回调不调用。 */
async function assertMembershipBinding(client, clientUserId) {
  if (!clientUserId) return
  const result = await client.query(
    `SELECT c.customer_type, c.became_member_at,
            EXISTS (SELECT 1 FROM staff_wechat_users e
                    WHERE e.employee_id = c.bound_employee_id) AS has_binding
       FROM client_wechat_users c WHERE c.user_id = $1 FOR NO KEY UPDATE OF c`,
    [clientUserId],
  )
  const customer = result.rows[0]
  if (!customer) throw new Error('NOT_FOUND: 顾客不存在')
  // 存量会员/曾入会后被标签重算者属于阶段2，不阻断其正常消费。
  if (customer.customer_type === '会员客' || customer.became_member_at) return
  if (!customer.has_binding) {
    throw new Error('INVALID_STATE: MEMBERSHIP_BINDING_REQUIRED: 请先由店长分配所属员工，再完成入会付款')
  }
}

module.exports = { assertMembershipBinding }
