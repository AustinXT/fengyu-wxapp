/**
 * Cron e2e 断言工具：直查 PG 验证 STEP 副作用。
 *
 * 设计：
 *   - countXxx：返回单值 int（COUNT 类查询）
 *   - getXxx：返回单行字段
 *   - listXxx：返回多行（多列以 '|' 分隔，psql -A 模式）
 */

import { psql } from './cron-runner'

/** SQL 字符串字面量转义（防注入用，但本测试用例都构造可控值） */
function esc(s: string): string {
  return s.replace(/'/g, "''")
}

export function countMessagesByKey(idemKey: string): number {
  const out = psql(`SELECT COUNT(*) FROM messages WHERE idempotency_key = '${esc(idemKey)}'`)
  return Number(out) || 0
}

export function countPointTransactionsByRef(externalRef: string): number {
  const out = psql(
    `SELECT COUNT(*) FROM point_transactions WHERE external_ref = '${esc(externalRef)}'`,
  )
  return Number(out) || 0
}

export function sumPointTransactionsByUser(userId: string): number {
  const out = psql(
    `SELECT COALESCE(SUM(amount), 0)::int FROM point_transactions WHERE user_id = '${esc(userId)}'`,
  )
  return Number(out) || 0
}

export function countUserCouponsByPrefix(prefix: string): number {
  const out = psql(
    `SELECT COUNT(*) FROM user_coupons WHERE coupon_id LIKE '${esc(prefix)}%'`,
  )
  return Number(out) || 0
}

export function listUserCouponsByPrefix(
  prefix: string,
): Array<{ coupon_id: string; template_id: string; user_id: string; expire_at: string; status: string }> {
  const out = psql(`
    SELECT coupon_id, template_id, user_id, expire_at::text, status
    FROM user_coupons
    WHERE coupon_id LIKE '${esc(prefix)}%'
    ORDER BY coupon_id
  `)
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [coupon_id, template_id, user_id, expire_at, status] = line.split('|')
      return { coupon_id, template_id, user_id, expire_at, status }
    })
}

export function getClientLevelAndLock(userId: string): { level: string | null; lockedUntil: string | null } {
  const out = psql(
    `SELECT COALESCE(member_level::text, '') || '|' || COALESCE(member_level_locked_until::text, '')
     FROM client_wechat_users WHERE user_id = '${esc(userId)}'`,
  )
  if (!out) return { level: null, lockedUntil: null }
  const [level, lockedUntil] = out.split('|')
  return {
    level: level || null,
    lockedUntil: lockedUntil || null,
  }
}

export function getPointsBalance(userId: string): number {
  const out = psql(
    `SELECT COALESCE(points_balance, 0) FROM client_wechat_users WHERE user_id = '${esc(userId)}'`,
  )
  return Number(out) || 0
}

export function getCustomerStatus(userId: string): string | null {
  const out = psql(
    `SELECT COALESCE(customer_status::text, '') FROM client_wechat_users WHERE user_id = '${esc(userId)}'`,
  )
  return out || null
}

export function getAppointmentStatus(appointmentId: string): string | null {
  const out = psql(
    `SELECT status::text FROM appointments WHERE appointment_id = '${esc(appointmentId)}'`,
  )
  return out || null
}

export function countOperationLogs(action: string, targetId?: string): number {
  const filter = targetId ? ` AND target_id = '${esc(targetId)}'` : ''
  const out = psql(
    `SELECT COUNT(*) FROM operation_logs WHERE action = '${esc(action)}'${filter}`,
  )
  return Number(out) || 0
}

export function findOperationLog(
  action: string,
  targetId: string,
): { action: string; target_id: string; detail: string } | null {
  const out = psql(`
    SELECT action || '||' || target_id || '||' || detail::text
    FROM operation_logs
    WHERE action = '${esc(action)}' AND target_id = '${esc(targetId)}'
    ORDER BY created_at DESC
    LIMIT 1
  `)
  if (!out) return null
  const [a, t, d] = out.split('||')
  return { action: a, target_id: t, detail: d }
}
