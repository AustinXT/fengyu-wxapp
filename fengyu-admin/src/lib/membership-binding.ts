import { sql } from 'drizzle-orm'
import type { db } from '@/db'
import { ApiError } from '@/lib/api-error'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 首次入会付款前的人工归属守护；三端独立副本，成功回调不调用。 */
export async function assertMembershipBinding(tx: AdminTx, clientUserId: string): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT c.customer_type, c.became_member_at,
           EXISTS (SELECT 1 FROM staff_wechat_users e
                   WHERE e.employee_id = c.bound_employee_id) AS has_binding
    FROM client_wechat_users c WHERE c.user_id = ${clientUserId} FOR NO KEY UPDATE OF c
  `) as unknown as Array<{ customer_type: string; became_member_at: unknown; has_binding: boolean }>
  const customer = rows[0]
  if (!customer) throw new ApiError('NOT_FOUND', '顾客不存在')
  if (customer.customer_type === '会员客' || customer.became_member_at) return
  if (!customer.has_binding) {
    throw new ApiError('INVALID_STATE', '请先由店长分配所属员工，再完成入会付款', { reason: 'MEMBERSHIP_BINDING_REQUIRED' })
  }
}
