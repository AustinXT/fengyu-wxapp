/**
 * 会员等级（钻石等级）即时重算 —— 支付结算时「只升不降」升级 member_level。
 *
 * 背景：member_level 原本只由 admin cron（每日凌晨 3:00）重算，顾客刚消费达标后最长要等
 * ~24h 才能在顾客端看到新等级（员工端读同一列、cron 跑过后才一致）。本 helper 在每个支付
 * 结算点即时重算，使顾客端 / 员工端 / 后台全端一致。
 *
 * 三端独立副本（staffApi/utils、clientApi/utils、payNotify 根目录），**内容字节一致**，
 * 一致性由 staffApi __tests__/routes/recalc-member-level-sql.test.js 守护，任一端漂移即失败。
 * 禁止抽取 cloudfunctions-shared（用户已 veto）。
 *
 * 口径与 admin cron `src/cron/steps/refresh-member-levels.ts` + `db/utils/member-level.ts`
 * 完全一致：滚动 12 个月 `received - refunded_amount`，仅纳入 sale_order_type IN ('销售单','转换单')。
 *
 * 仅升级，不降级（降级仍由 cron 在 150 天保级期后处理）。升级礼包（消息/积分/优惠券三件套）
 * **不在此发放**，仍由每日 03:00 cron 的 grantUpgradeBenefits 幂等补发。
 */

// 等级序数；null 视为 0（与 db/utils/member-level.ts 的 LEVEL_RANK 一致）
const LEVEL_RANK = { 初钻: 1, 星钻: 2, 粉钻: 3, 金钻: 4, 黑钻: 5 }

function rank(level) {
  if (!level) return 0
  return LEVEL_RANK[level] || 0
}

/**
 * 按滚动 12 个月消费额计算等级
 * 阈值：黑钻 ≥10w / 金钻 ≥6w / 粉钻 ≥3w / 星钻 ≥1w / 初钻 ≥ threshold
 * 与 db/utils/member-level.ts determineMemberLevel 字面一致。
 */
function determineMemberLevel(spend, threshold) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000) return '金钻'
  if (spend >= 30000) return '粉钻'
  if (spend >= 10000) return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

/**
 * 支付结算时即时重算会员等级（只升不降）。在传入事务 client 内执行。
 *
 * @param {object} client - pg 事务客户端
 * @param {string} clientUserId - client_wechat_users.user_id
 * @param {number} threshold - system_configs.new_member_threshold（初钻门槛）
 * @param {string} sourceEnd - 写入 operation_logs.source（'staffApi' | 'clientApi' | 'payNotify'）
 */
async function recalcMemberLevel(client, clientUserId, threshold, sourceEnd) {
  if (!clientUserId) return

  const cur = await client.query(
    'SELECT member_level, customer_type FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  const row = cur.rows[0]
  // 仅「会员客」参与钻石等级体系（与 cron WHERE customer_type='会员客' 同口径）
  if (!row || row.customer_type !== '会员客') return
  const oldLevel = row.member_level || null

  // 滚动 12 个月消费额（与 cron refresh-member-levels.ts 字面对齐）：
  // 仅纳入 销售单 + 转换单；净额 = received - refunded_amount（已含退款冲销）。
  const spendRes = await client.query(
    `SELECT COALESCE(SUM(GREATEST((so.received::numeric) - (so.refunded_amount::numeric), 0)) FILTER (
              WHERE so.sale_order_type IN ('销售单','转换单')
                AND so.paid_at >= (NOW() - INTERVAL '12 months')
            ), 0) AS spend
       FROM sale_orders so
      WHERE so.client_user_id = $1`,
    [clientUserId]
  )
  const spend = Number(spendRes.rows[0] && spendRes.rows[0].spend) || 0
  const newLevel = determineMemberLevel(spend, threshold)

  // 只升不降：仅当算出等级严格高于当前等级才升级
  if (rank(newLevel) <= rank(oldLevel)) return

  // 升级：写新等级 + 150 天保级期 + old_member_level 快照（与 cron processUpgrade 对齐）
  const upd = await client.query(
    `UPDATE client_wechat_users
        SET old_member_level = member_level,
            member_level = $2::member_level,
            member_level_upgraded_at = NOW(),
            member_level_locked_until = NOW() + INTERVAL '150 days',
            updated_at = NOW()
      WHERE user_id = $1 AND member_level IS DISTINCT FROM $2::member_level`,
    [clientUserId, newLevel]
  )
  if (upd.rowCount > 0) {
    // 审计日志：与 cron memberLevelChange 同结构（_v:3 / _t:'transition'），source 标记触发端。
    // 礼包留给 cron 幂等补发，故 trigger='payment'。
    const detail = JSON.stringify({
      _v: 3,
      _t: 'transition',
      from: oldLevel,
      to: newLevel,
      context: {
        rolling12mSpend: spend,
        trigger: 'payment',
        direction: 'upgrade',
        lockedUntil: '+150d',
      },
    })
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, $3, NOW())`,
      [clientUserId, detail, sourceEnd]
    )
  }
}

module.exports = { LEVEL_RANK, rank, determineMemberLevel, recalcMemberLevel }
