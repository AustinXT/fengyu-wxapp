/**
 * Cron e2e 命名空间数据构造 / 清理工具。
 *
 * 命名空间约定（与现有 link-* 测试隔离）：
 *   - 顾客 user_id 前缀：'CRON_E2E_CLI_'
 *   - 预约 appointment_id 前缀：'CRON_E2E_APT_'
 *   - 销售单 sale_order_id 前缀：'CRON_E2E_SO_'
 *   - 员工 employee_id 前缀：'CRON_E2E_STAFF_'
 *   - 服务单 service_order_id 前缀：'CRON_E2E_SVC_'
 *   - 消息/积分/券幂等键前缀：'cron-e2e-'
 *
 * cleanupCronE2E() 按 FK 依赖反向序删除全部 CRON_E2E_* 残留 + cron-e2e-* 幂等键。
 */

import { psql } from './cron-runner'

export const PREFIX = {
  CLIENT: 'CRON_E2E_CLI_',
  APT: 'CRON_E2E_APT_',
  SO: 'CRON_E2E_SO_',
  STAFF: 'CRON_E2E_STAFF_',
  SVC: 'CRON_E2E_SVC_',
  CARD: 'CRON_E2E_CARD_',
  IDEM: 'cron-e2e-',
} as const

/**
 * 构造测试会员客顾客。默认 customer_type='会员客'，birthday/level/locked_until 可定制。
 * @param suffix 后缀，会拼接到 CRON_E2E_CLI_ 后；同 suffix 多次调用 ON CONFLICT 更新
 */
export interface UpsertClientOptions {
  customerType?: '会员客' | '流量客' | '体验客' | '小美客'
  memberLevel?: '初钻' | '星钻' | '粉钻' | '金钻' | '黑钻' | null
  birthday?: string // 'YYYY-MM-DD'
  pointsBalance?: number
  memberLevelLockedUntil?: string // ISO 或 'YYYY-MM-DD HH:MM:SS'
  inviterUserId?: string | null
  storeId?: string | null
}

export function upsertClient(suffix: string, options: UpsertClientOptions = {}): string {
  const uid = `${PREFIX.CLIENT}${suffix}`
  const customerType = options.customerType ?? '会员客'
  const memberLevel = options.memberLevel === undefined ? null : options.memberLevel
  const birthday = options.birthday ?? null
  const pointsBalance = options.pointsBalance ?? 0
  const lockedUntil = options.memberLevelLockedUntil ?? null
  const inviter = options.inviterUserId ?? null
  const storeId = options.storeId ?? null

  // 生成 11 位手机号：199 + hash(suffix) 取 8 位数字，保证唯一且符合 chk_cwu_phone_format
  const hash = Array.from(suffix).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0)
  const phone = `199${String(hash).padStart(8, '0').slice(-8)}`

  const cols = [
    `user_id`,
    `phone`,
    `name`,
    `customer_type`,
    `member_level`,
    `birthday`,
    `points_balance`,
    `member_level_locked_until`,
    `inviter_user_id`,
    `bound_store_id`,
    `created_at`,
    `updated_at`,
  ]
  const vals = [
    `'${uid}'`,
    `'${phone}'`,
    `'CRON_E2E_${suffix}'`,
    `'${customerType}'`,
    memberLevel === null ? `NULL` : `'${memberLevel}'`,
    birthday ? `'${birthday}'` : `NULL`,
    `${pointsBalance}`,
    lockedUntil ? `'${lockedUntil}'::timestamptz` : `NULL`,
    inviter ? `'${inviter}'` : `NULL`,
    storeId ? `'${storeId}'` : `NULL`,
    `NOW()`,
    `NOW()`,
  ]
  psql(`
    INSERT INTO client_wechat_users (${cols.join(', ')})
    VALUES (${vals.join(', ')})
    ON CONFLICT (user_id) DO UPDATE SET
      customer_type = EXCLUDED.customer_type,
      member_level = EXCLUDED.member_level,
      birthday = EXCLUDED.birthday,
      points_balance = EXCLUDED.points_balance,
      member_level_locked_until = EXCLUDED.member_level_locked_until,
      inviter_user_id = EXCLUDED.inviter_user_id,
      bound_store_id = EXCLUDED.bound_store_id,
      updated_at = NOW()
  `)
  return uid
}

/** 删除当前 cron e2e 命名空间内的全部残留数据（按 FK 反向） */
export function cleanupCronE2E(): void {
  const stmts = [
    // operation_logs（target_id 是 customer 或 appointment 类的 cron 日志）
    `DELETE FROM operation_logs WHERE source = 'cronTask' AND (target_id LIKE '${PREFIX.CLIENT}%' OR target_id LIKE '${PREFIX.APT}%' OR target_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}%'))`,
    // messages
    `DELETE FROM messages WHERE idempotency_key LIKE '${PREFIX.IDEM}%' OR recipient_id LIKE '${PREFIX.CLIENT}%'`,
    // point_transactions
    `DELETE FROM point_transactions WHERE external_ref LIKE '${PREFIX.IDEM}%' OR external_ref LIKE 'birthday-pts-%-${PREFIX.CLIENT}%' OR external_ref LIKE 'thx-pts-%-${PREFIX.CLIENT}%' OR external_ref LIKE 'member-upgrade-${PREFIX.CLIENT}%' OR user_id LIKE '${PREFIX.CLIENT}%'`,
    // user_coupons
    `DELETE FROM user_coupons WHERE coupon_id LIKE '${PREFIX.IDEM}%' OR coupon_id LIKE 'bday-%-${PREFIX.CLIENT}%' OR coupon_id LIKE 'thx-%-${PREFIX.CLIENT}%' OR coupon_id LIKE 'cpn-up-${PREFIX.CLIENT}%' OR coupon_id LIKE 'sg-%-${PREFIX.SO}%' OR user_id LIKE '${PREFIX.CLIENT}%'`,
    // appointments
    `DELETE FROM appointments WHERE appointment_id LIKE '${PREFIX.APT}%' OR client_user_id LIKE '${PREFIX.CLIENT}%'`,
    // service_orders / service_items (深 FK 先删 service_items)
    `DELETE FROM service_items WHERE service_order_id IN (SELECT service_order_id FROM service_orders WHERE service_order_id LIKE '${PREFIX.SVC}%' OR client_user_id LIKE '${PREFIX.CLIENT}%')`,
    `DELETE FROM service_orders WHERE service_order_id LIKE '${PREFIX.SVC}%' OR client_user_id LIKE '${PREFIX.CLIENT}%'`,
    // sale_orders / sale_items / sale_order_payments
    `DELETE FROM sale_order_payments WHERE sale_order_id LIKE '${PREFIX.SO}%'`,
    `DELETE FROM sale_allocations WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id LIKE '${PREFIX.SO}%')`,
    `DELETE FROM sale_items WHERE sale_order_id LIKE '${PREFIX.SO}%'`,
    `DELETE FROM sale_orders WHERE sale_order_id LIKE '${PREFIX.SO}%' OR client_user_id LIKE '${PREFIX.CLIENT}%'`,
    // card_transactions
    `DELETE FROM card_transactions WHERE card_id LIKE '${PREFIX.CARD}%'`,
    `DELETE FROM prepaid_cards WHERE card_id LIKE '${PREFIX.CARD}%' OR user_id LIKE '${PREFIX.CLIENT}%'`,
    // client_wechat_users
    `DELETE FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}%'`,
    // staff_wechat_users
    `DELETE FROM staff_wechat_users WHERE employee_id LIKE '${PREFIX.STAFF}%'`,
  ]
  for (const s of stmts) {
    try {
      psql(s)
    } catch (e) {
      console.warn(`[cleanupCronE2E] skipped: ${(e as Error).message.split('\n')[0]}`)
    }
  }
}

/** 构造一笔已支付 sale_order，便于 spend / refund_amount 计算测试 */
export interface InsertSaleOrderOptions {
  storeId: string
  clientUserId: string
  saleOrderType?: '销售单' | '内部单' | '转换单'
  received: number
  refundedAmount?: number
  paidAt: string // ISO 'YYYY-MM-DD HH:MM:SS' 或 'YYYY-MM-DD'
  status?: '已支付' | '已完成' | '待支付'
}

export function insertSaleOrder(suffix: string, opt: InsertSaleOrderOptions): string {
  const soid = `${PREFIX.SO}${suffix}`
  const saleOrderType = opt.saleOrderType ?? '销售单'
  const status = opt.status ?? '已支付'
  const refunded = opt.refundedAmount ?? 0
  // sale_orders.market_name NOT NULL，从已有数据取一个 fallback
  const market = psql(`SELECT market_name FROM sale_orders WHERE market_name IS NOT NULL LIMIT 1`)
  const marketName = market.replace(/'/g, "''")
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, store_id, market_name, client_user_id, sale_order_type,
      received, refunded_amount, total_amount, payable_amount, prepaid_card_amount,
      paid_at, sale_order_datetime, payment_method, status, created_at, updated_at
    )
    VALUES (
      '${soid}', '${opt.storeId}', '${marketName}', '${opt.clientUserId}', '${saleOrderType}',
      ${opt.received}, ${refunded}, ${opt.received}, ${opt.received}, 0,
      '${opt.paidAt}'::timestamptz, '${opt.paidAt}'::timestamptz, '微信', '${status}', NOW(), NOW()
    )
    ON CONFLICT (sale_order_id) DO UPDATE SET
      received = EXCLUDED.received,
      refunded_amount = EXCLUDED.refunded_amount,
      paid_at = EXCLUDED.paid_at,
      status = EXCLUDED.status,
      sale_order_type = EXCLUDED.sale_order_type,
      updated_at = NOW()
  `)
  return soid
}
