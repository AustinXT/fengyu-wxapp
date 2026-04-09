/**
 * cronTask 定时触发器云函数
 * 每日凌晨3点执行：
 *   STEP 1: 更新顾客到店状态（customer_status）
 *   STEP 2: 重算会员等级（member_level）+ 升级时发放权益（消息/积分/优惠券）
 *
 * 触发器配置: 0 0 3 * * * *
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { Pool } = require('pg')
const { getMemberThreshold } = require('./config')

let pool = null
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
    pool.on('error', (err) => {
      console.error('PG pool error:', err)
    })
  }
  return pool
}

// ============ STEP 1: customer_status 重算 ============

const UPDATE_CUSTOMER_STATUS_SQL = `
WITH visit_stats AS (
  SELECT
    so.client_user_id,
    MAX(so.service_date) AS last_service_date,
    COUNT(DISTINCT so.service_date) AS total_visits,
    COUNT(DISTINCT so.service_date) FILTER (
      WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
    ) AS visits_90d
  FROM service_orders so
  WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
  GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
SET
  customer_status = CASE
    WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
    WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
    WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '预警沉睡'::customer_status
    WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
    ELSE '休眠'::customer_status
  END,
  updated_at = NOW()
FROM visit_stats vs
WHERE u.user_id = vs.client_user_id
`

const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
SET customer_status = '休眠'::customer_status, updated_at = NOW()
WHERE customer_status != '休眠'
  AND NOT EXISTS (
    SELECT 1 FROM service_orders so
    WHERE so.client_user_id = u.user_id AND so.status = '已完成'
  )
`

// ============ STEP 2: member_level 重算 + 权益发放 ============

// 等级序数（用于"只升不降"判断；null < 初钻 < 星钻 < 粉钻 < 金钻 < 黑钻）
const LEVEL_RANK = { null: 0, '初钻': 1, '星钻': 2, '粉钻': 3, '金钻': 4, '黑钻': 5 }

/**
 * 根据滚动 12 个月消费额计算钻石等级
 * 阈值：黑钻 ≥10w / 金钻 ≥6w / 粉钻 ≥3w / 星钻 ≥1w / 初钻 ≥ 阈值 / null
 * 初钻下限由 system_configs.new_member_threshold 配置，经 refreshMemberLevels 传入。
 */
function determineMemberLevel(spend, threshold) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000)  return '金钻'
  if (spend >= 30000)  return '粉钻'
  if (spend >= 10000)  return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

function isUpgrade(from, to) {
  return (LEVEL_RANK[to] || 0) > (LEVEL_RANK[from] || 0)
}

/**
 * 加载权益配置（system_configs.member_level_benefits）
 * 缺失或解析失败 → 返回 null（cronTask 仍执行等级更新和日志，但跳过权益发放）
 */
async function loadBenefitsConfig(client) {
  const result = await client.query(
    "SELECT value FROM system_configs WHERE key = 'member_level_benefits'"
  )
  if (!result.rows[0]?.value) {
    console.warn('[cronTask] member_level_benefits 配置不存在，跳过权益发放')
    return null
  }
  try {
    return JSON.parse(result.rows[0].value)
  } catch (err) {
    console.error('[cronTask] member_level_benefits 解析失败:', err.message)
    return null
  }
}

/**
 * 三件套权益发放
 * @param {object} client - pg 事务客户端
 * @param {string} userId - client_wechat_users.user_id
 * @param {string|null} fromLevel
 * @param {string} toLevel
 * @param {object} config - benefitsConfig[toLevel]
 */
async function grantUpgradeBenefits(client, userId, fromLevel, toLevel, config) {
  // 1) 消息推送
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, created_at)
       VALUES ('客户', $1, $2, $3, 'system', NOW())`,
      [userId, config.messageTitle, config.messageBody || null]
    )
  }

  // 2) 积分发放
  if (config.points && config.points > 0) {
    await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, created_at)
       VALUES ($1, '等级升级奖励', $2, NULL, NOW())`,
      [userId, config.points]
    )
    await client.query(
      `INSERT INTO customer_points (user_id, balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET balance = customer_points.balance + EXCLUDED.balance,
             updated_at = NOW()`,
      [userId, config.points]
    )
  }

  // 3) 优惠券发放
  if (Array.isArray(config.couponTemplateIds) && config.couponTemplateIds.length > 0) {
    for (const templateId of config.couponTemplateIds) {
      const tplResult = await client.query(
        'SELECT validity_mode, valid_days, valid_to, is_active FROM coupon_templates WHERE template_id = $1',
        [templateId]
      )
      const tpl = tplResult.rows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cronTask] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }

      let expireAt
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(Date.now() + 365 * 86400000)
      }

      // 幂等 key：同一用户同一升级到同一等级，同一模板只发一张
      const couponId = `cpn-up-${userId}-${toLevel}-${templateId}`
      await client.query(
        `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, created_at)
         VALUES ($1, $2, $3, '未使用', $4, NOW())
         ON CONFLICT (coupon_id) DO NOTHING`,
        [couponId, templateId, userId, expireAt]
      )
    }
  }
}

/**
 * 等级重算 + 权益发放主流程
 * 对所有 customer_type='会员客' 的顾客逐个处理（独立子事务）
 */
async function refreshMemberLevels(client) {
  const benefitsConfig = await loadBenefitsConfig(client)
  const memberThreshold = await getMemberThreshold()

  const memberClients = (await client.query(
    "SELECT user_id, member_level FROM client_wechat_users WHERE customer_type = '会员客'"
  )).rows

  let upgradeCount = 0
  let downgradeCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const row of memberClients) {
    try {
      // 计算滚动 12 个月消费额
      const spendRow = (await client.query(
        `SELECT COALESCE(SUM(total_amount::numeric), 0) AS spend
         FROM sale_orders
         WHERE client_user_id = $1
           AND status IN ('已支付', '已完成')
           AND sale_order_type != '内部单'
           AND paid_at >= (NOW() - INTERVAL '12 months')`,
        [row.user_id]
      )).rows[0]

      const newLevel = determineMemberLevel(Number(spendRow.spend || 0), memberThreshold)
      const oldLevel = row.member_level

      if (newLevel === oldLevel) {
        unchangedCount++
        continue
      }

      // 单用户事务：保证更新+日志+权益的原子性
      await client.query('BEGIN')
      try {
        await client.query(
          'UPDATE client_wechat_users SET member_level = $1, updated_at = NOW() WHERE user_id = $2',
          [newLevel, row.user_id]
        )

        await client.query(
          `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
          [
            'customer.memberLevelChange',
            'customer',
            row.user_id,
            JSON.stringify({
              _v: 2,
              _t: 'transition',
              from: oldLevel,
              to: newLevel,
              context: { rolling12mSpend: Number(spendRow.spend), trigger: 'cronTask' },
            }),
            'cronTask',
          ]
        )

        if (isUpgrade(oldLevel, newLevel)) {
          if (benefitsConfig?.[newLevel]) {
            await grantUpgradeBenefits(client, row.user_id, oldLevel, newLevel, benefitsConfig[newLevel])
          }
          upgradeCount++
        } else {
          downgradeCount++
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    } catch (err) {
      console.error(`[cronTask] member_level update failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }

  return { upgradeCount, downgradeCount, unchangedCount, errorCount, total: memberClients.length }
}

// ============ 入口 ============

exports.main = async (event) => {
  console.log('[cronTask] triggered:', JSON.stringify(event))

  const client = await getPool().connect()
  try {
    // STEP 1: customer_status
    await client.query('BEGIN')

    const { rowCount: updatedCount } = await client.query(UPDATE_CUSTOMER_STATUS_SQL)
    console.log(`[cronTask] STEP 1: 有服务记录的顾客已更新: ${updatedCount}`)

    const { rowCount: resetCount } = await client.query(RESET_NO_VISITS_SQL)
    console.log(`[cronTask] STEP 1: 无服务记录的顾客已重置: ${resetCount}`)

    const { rows: stats } = await client.query(`
      SELECT customer_status, COUNT(*) AS cnt
      FROM client_wechat_users
      GROUP BY customer_status ORDER BY customer_status
    `)
    console.log('[cronTask] STEP 1: 状态分布:', JSON.stringify(stats))

    await client.query('COMMIT')

    // STEP 2: member_level + 权益发放（独立于 STEP 1 事务，每个用户独立子事务）
    const levelResult = await refreshMemberLevels(client)
    console.log(
      `[cronTask] STEP 2: member_level total=${levelResult.total} ` +
      `upgrade=${levelResult.upgradeCount} downgrade=${levelResult.downgradeCount} ` +
      `unchanged=${levelResult.unchangedCount} error=${levelResult.errorCount}`
    )

    return {
      code: 0,
      message: 'success',
      data: {
        updatedCount,
        resetCount,
        stats,
        memberLevel: levelResult,
      },
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    console.error('[cronTask] ERROR:', err)
    return { code: -1, message: err.message }
  } finally {
    client.release()
  }
}
