/**
 * 会员到店积分 — staffApi 独立副本。
 *
 * 发放口径：会员服务单（售后）最终确认完成 + 至少一个非零价项目 + 非寄存退款假消耗，
 * 按顾客 + service_date 每天最多发一次。积分失败使用 SAVEPOINT 隔离，不阻断服务完成。
 */

const { DEPOSIT_REFUND_REMARK } = require('./consume-filter')

const VISIT_POINTS_CONFIG_KEY = 'visit_points_reward'
const DEFAULT_VISIT_POINTS_REWARD = 20
const VISIT_POINTS_TYPE = '到店赠送'
const VISIT_POINTS_EXTERNAL_REF_PREFIX = 'visit-points'

function parseVisitPointsReward(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return DEFAULT_VISIT_POINTS_REWARD
  }
  const normalized = String(value).trim()
  if (!/^\d+$/.test(normalized)) return 0
  const amount = Number(normalized)
  return Number.isSafeInteger(amount) ? amount : 0
}

function normalizeServiceDate(value) {
  if (value instanceof Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value)
    const pick = (type) => parts.find((part) => part.type === type)?.value || ''
    return `${pick('year')}-${pick('month')}-${pick('day')}`
  }
  const normalized = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : ''
}

function buildVisitPointsExternalRef(userId, serviceDate) {
  return `${VISIT_POINTS_EXTERNAL_REF_PREFIX}:${userId}:${serviceDate}`
}

function isVisitPointsEligible(so, items) {
  return Boolean(
    so &&
    so.service_order_type === '售后' &&
    so.client_user_id &&
    normalizeServiceDate(so.service_date) &&
    so.remark !== DEPOSIT_REFUND_REMARK &&
    Array.isArray(items) &&
    items.some((item) => Number(item.unit_real_price || 0) > 0)
  )
}

async function loadVisitPointsReward(client) {
  const result = await client.query(
    'SELECT value FROM system_configs WHERE key = $1 LIMIT 1',
    [VISIT_POINTS_CONFIG_KEY]
  )
  return parseVisitPointsReward(result.rows[0]?.value)
}

async function grantVisitPoints(client, so, items, now, rewardAmount) {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { granted: false, skipped: 'disabled' }
  }
  if (!isVisitPointsEligible(so, items)) {
    return { granted: false, skipped: 'ineligible' }
  }

  const amount = rewardAmount ?? await loadVisitPointsReward(client)
  if (amount <= 0) return { granted: false, skipped: 'disabled' }

  const serviceDate = normalizeServiceDate(so.service_date)
  const externalRef = buildVisitPointsExternalRef(so.client_user_id, serviceDate)
  // ⚠ 必须同时建 point_batches：余额（points_balance）与批次（point_batches）是两本账，
  // 不变量 I3 要求 balance = Σ 未过期批次 remaining，且**过期处理只扫批次**。
  // 漏建的后果：到店积分永不过期（与 #67 的 365 天口径相悖）+ I3 每日告警。
  // 消费赠送侧由 utils/points.js 的 grantPointBatch 建，此处与它逐字同口径（365 天、
  // earned_at 取流水 created_at）。跨端三份副本（staffApi / clientApi / admin lib）须同步。
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO point_transactions
         (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '到店赠送', $2, NULL, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id, amount, created_at
     ),
     granted_batch AS (
       INSERT INTO point_batches
         (user_id, source_transaction_id, source_type, ref_order_id,
          original_amount, remaining_amount, earned_at, expire_at, created_at, updated_at)
       SELECT $1, i.id, '到店赠送', NULL,
              i.amount, i.amount, i.created_at,
              i.created_at + INTERVAL '365 days', NOW(), NOW()
         FROM inserted i
     )
     UPDATE client_wechat_users
        SET points_balance = COALESCE(points_balance, 0) + (SELECT amount FROM inserted),
            points_updated_at = $4
      WHERE user_id = $1
        AND EXISTS (SELECT 1 FROM inserted)
     RETURNING points_balance`,
    [so.client_user_id, amount, externalRef, now]
  )

  return {
    granted: result.rowCount > 0,
    skipped: result.rowCount > 0 ? null : 'duplicate',
    amount,
    externalRef,
  }
}

async function logVisitPointsFailure(client, so, ctx, rewardAmount, externalRef, err) {
  const auth = ctx?.auth || {}
  const primary = auth.roleBindings?.[0] || null
  const detail = JSON.stringify({
    rewardAmount,
    externalRef,
    userId: so.client_user_id,
    serviceDate: normalizeServiceDate(so.service_date),
    error: String(err?.message || err || 'unknown').slice(0, 500),
  })

  try {
    await client.query('SAVEPOINT visit_points_failure_log')
    await client.query(
      `INSERT INTO operation_logs
         (operator_employee_id, operator_name, operator_role, org_node_id, org_node_name,
          action, target_type, target_id, detail, source, created_at)
       VALUES ($1, $2, $3, $4, $5, 'points.visitGrantFailed', 'service_order', $6, $7::jsonb, 'staffApi', NOW())`,
      [
        auth.staffWfId || null,
        auth.name || null,
        primary?.role || auth.roles?.[0] || null,
        primary?.scopeId || null,
        primary?.scopeName || null,
        so.service_order_id,
        detail,
      ]
    )
    await client.query('RELEASE SAVEPOINT visit_points_failure_log')
  } catch (logErr) {
    try { await client.query('ROLLBACK TO SAVEPOINT visit_points_failure_log') } catch (_) { /* ignore */ }
    console.error('[visit-points] failure log failed:', logErr?.message || logErr)
  }
}

async function grantVisitPointsSafe(client, so, items, ctx, now) {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false' || !isVisitPointsEligible(so, items)) {
    return { granted: false, skipped: 'ineligible-or-disabled' }
  }

  let rewardAmount = DEFAULT_VISIT_POINTS_REWARD
  const serviceDate = normalizeServiceDate(so.service_date)
  const externalRef = buildVisitPointsExternalRef(so.client_user_id, serviceDate)

  try {
    await client.query('SAVEPOINT visit_points_reward')
    rewardAmount = await loadVisitPointsReward(client)
    const result = await grantVisitPoints(client, so, items, now, rewardAmount)
    await client.query('RELEASE SAVEPOINT visit_points_reward')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT visit_points_reward')
      await client.query('RELEASE SAVEPOINT visit_points_reward')
    } catch (_) { /* outer transaction decides connection-level failures */ }
    await logVisitPointsFailure(client, so, ctx, rewardAmount, externalRef, err)
    return { granted: false, skipped: 'failed', amount: rewardAmount, externalRef }
  }
}

module.exports = {
  VISIT_POINTS_CONFIG_KEY,
  DEFAULT_VISIT_POINTS_REWARD,
  VISIT_POINTS_TYPE,
  VISIT_POINTS_EXTERNAL_REF_PREFIX,
  parseVisitPointsReward,
  normalizeServiceDate,
  buildVisitPointsExternalRef,
  isVisitPointsEligible,
  loadVisitPointsReward,
  grantVisitPoints,
  grantVisitPointsSafe,
}
