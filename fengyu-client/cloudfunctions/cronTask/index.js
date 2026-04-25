/**
 * cronTask 定时触发器云函数
 * 每日凌晨3点执行：
 *   STEP 1: 更新顾客到店状态（customer_status）
 *   STEP 2: 重算会员等级（member_level）+ 升级时发放权益（消息/积分/优惠券）
 *   STEP 3: 生日权益发放（按当前会员等级读取 birthday_benefits 配置）
 *   STEP 4: 感恩日权益发放（每月 20 号当日有护理单的会员，thanksgiving_benefits 配置，优惠券固定 10 天有效期）
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

function isDowngrade(from, to) {
  return (LEVEL_RANK[to] || 0) < (LEVEL_RANK[from] || 0)
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
  const idemKey = `member-upgrade-${userId}-${toLevel}`

  // 1) 消息推送（幂等键：同一用户升到同一等级只发一次）
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, config.messageTitle, config.messageBody || null, idemKey]
    )
  }

  // 2) 积分发放（幂等 + 余额条件累加）
  // 余额缓存统一为 client_wechat_users.points_balance；原 customer_points 表已删除
  if (config.points && config.points > 0) {
    const inserted = await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '等级升级奖励', $2, NULL, $3, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, config.points, idemKey]
    )
    if (inserted.rowCount > 0) {
      await client.query(
        `UPDATE client_wechat_users
            SET points_balance    = COALESCE(points_balance, 0) + $2,
                points_updated_at = NOW()
          WHERE user_id = $1`,
        [userId, config.points]
      )
    }
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
    "SELECT user_id, member_level, member_level_locked_until FROM client_wechat_users WHERE customer_type = '会员客'"
  )).rows

  let upgradeCount = 0
  let downgradeCount = 0
  let heldCount = 0
  let unchangedCount = 0
  let errorCount = 0

  for (const row of memberClients) {
    try {
      // 滚动 12 个月消费额：paid_amount 累计；仅销售单；paid_amount>0；退款通过 payments 负流水自然冲抵
      const spendRow = (await client.query(
        `SELECT COALESCE(SUM(paid_amount::numeric), 0) AS spend
         FROM sale_orders
         WHERE client_user_id = $1
           AND sale_order_type = '销售单'
           AND paid_amount > 0
           AND paid_at >= (NOW() - INTERVAL '12 months')`,
        [row.user_id]
      )).rows[0]

      const spend = Number(spendRow.spend || 0)
      const newLevel = determineMemberLevel(spend, memberThreshold)
      const oldLevel = row.member_level

      if (newLevel === oldLevel) {
        unchangedCount++
        continue
      }

      if (isUpgrade(oldLevel, newLevel)) {
        await processUpgrade(client, row.user_id, oldLevel, newLevel, spend, benefitsConfig)
        upgradeCount++
      } else if (isDowngrade(oldLevel, newLevel)) {
        const held = await processDowngrade(client, row.user_id, oldLevel, newLevel, spend, row.member_level_locked_until)
        if (held) heldCount++
        else downgradeCount++
      } else {
        unchangedCount++
      }
    } catch (err) {
      console.error(`[cronTask] member_level update failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }

  return { upgradeCount, downgradeCount, heldCount, unchangedCount, errorCount, total: memberClients.length }
}

/**
 * 升级：UPDATE + 日志 + 权益发放；150 天保级重置
 */
async function processUpgrade(client, userId, oldLevel, newLevel, spend, benefitsConfig) {
  await client.query('BEGIN')
  try {
    await client.query(
      `UPDATE client_wechat_users
         SET old_member_level = member_level,
             member_level = $1,
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NOW() + INTERVAL '150 days',
             updated_at = NOW()
       WHERE user_id = $2
         AND member_level IS DISTINCT FROM $1`,
      [newLevel, userId]
    )

    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
      [
        userId,
        JSON.stringify({
          _v: 3,
          _t: 'transition',
          from: oldLevel,
          to: newLevel,
          context: { rolling12mSpend: spend, trigger: 'cronTask', direction: 'upgrade', lockedUntil: '+150d' },
        }),
      ]
    )

    if (benefitsConfig?.[newLevel]) {
      await grantUpgradeBenefits(client, userId, oldLevel, newLevel, benefitsConfig[newLevel])
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * 降级：保级期内跳过并记 memberLevelHeld 日志；保级期已过则静默降级并清 locked_until
 * @returns {boolean} true=保级跳过；false=实际降级
 */
async function processDowngrade(client, userId, oldLevel, newLevel, spend, lockedUntil) {
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('customer.memberLevelHeld', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
      [
        userId,
        JSON.stringify({
          _v: 3,
          _t: 'hold',
          currentLevel: oldLevel,
          recomputedLevel: newLevel,
          context: { rolling12mSpend: spend, lockedUntil, reason: '150d_lock' },
        }),
      ]
    )
    return true
  }

  await client.query('BEGIN')
  try {
    await client.query(
      `UPDATE client_wechat_users
         SET old_member_level = member_level,
             member_level = $1,
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NULL,
             updated_at = NOW()
       WHERE user_id = $2
         AND member_level IS DISTINCT FROM $1`,
      [newLevel, userId]
    )
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('customer.memberLevelChange', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
      [
        userId,
        JSON.stringify({
          _v: 3,
          _t: 'transition',
          from: oldLevel,
          to: newLevel,
          context: { rolling12mSpend: spend, trigger: 'cronTask', direction: 'downgrade' },
        }),
      ]
    )
    await client.query('COMMIT')
    return false
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

// ============ STEP 3: 生日权益发放 ============

/**
 * 加载生日权益配置（system_configs.birthday_benefits）
 * 缺失或解析失败 → 返回 null（cronTask 仍执行其他 STEP，仅跳过 STEP 3）
 */
async function loadBirthdayBenefitsConfig(client) {
  const result = await client.query(
    "SELECT value FROM system_configs WHERE key = 'birthday_benefits'"
  )
  if (!result.rows[0]?.value) {
    console.warn('[cronTask] birthday_benefits 配置不存在，跳过 STEP 3')
    return null
  }
  try {
    return JSON.parse(result.rows[0].value)
  } catch (err) {
    console.error('[cronTask] birthday_benefits 解析失败:', err.message)
    return null
  }
}

/**
 * 生日三件套权益发放（消息 / 积分 / 优惠券）
 * 幂等键前缀与 upgrade 不同，避免两场景混淆
 *   消息：birthday-msg-{YYYY}-{userId}
 *   积分：birthday-pts-{YYYY}-{userId}
 *   优惠券：bday-{YYYY}-{userId}-{templateId}
 *
 * @param {object} client - pg 事务客户端
 * @param {string} userId - client_wechat_users.user_id
 * @param {number} year - 当前年份（DB CURRENT_DATE 提取，避免时区漂移）
 * @param {string} level - 顾客当前会员等级
 * @param {object} config - benefitsConfig[level]
 */
async function grantBirthdayBenefits(client, userId, year, level, config) {
  // 1) 消息推送
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, config.messageTitle, config.messageBody || null, `birthday-msg-${year}-${userId}`]
    )
  }

  // 2) 积分发放（余额条件累加：仅当流水成功插入才累加，避免幂等冲突时重复加）
  if (config.points && config.points > 0) {
    const externalRef = `birthday-pts-${year}-${userId}`
    const inserted = await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '生日积分', $2, NULL, $3, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, config.points, externalRef]
    )
    if (inserted.rowCount > 0) {
      await client.query(
        `UPDATE client_wechat_users
            SET points_balance = points_balance + $2,
                points_updated_at = NOW()
          WHERE user_id = $1`,
        [userId, config.points]
      )
    }
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
        console.warn(`[cronTask/birthday] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
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

      const couponId = `bday-${year}-${userId}-${templateId}`
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
 * 生日权益发放主流程
 * 扫描 birthday IS NOT NULL AND member_level IS NOT NULL 且月日 = 今天的顾客
 * 闰年策略 B1：非闰年 2/29 自然跳过（SQL 精确匹配，无额外分支）
 * 每个用户独立子事务：grantBirthdayBenefits + operation_logs
 */
async function refreshBirthdayBenefits(client) {
  const benefitsConfig = await loadBirthdayBenefitsConfig(client)
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  // 年份从 DB CURRENT_DATE 提取，与 SELECT 同源，彻底避免 JS/DB 时区漂移
  const yearRow = (await client.query(
    'SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS year'
  )).rows[0]
  const year = yearRow.year

  const rows = (await client.query(
    `SELECT user_id, member_level
       FROM client_wechat_users
      WHERE birthday IS NOT NULL
        AND member_level IS NOT NULL
        AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)`
  )).rows

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    await client.query('BEGIN')
    try {
      await grantBirthdayBenefits(client, row.user_id, year, row.member_level, cfg)

      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('customer.birthdayBenefits', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
        [
          row.user_id,
          JSON.stringify({
            _v: 1,
            _t: 'birthday',
            year,
            memberLevel: row.member_level,
            config: {
              points: cfg.points || 0,
              couponTemplateCount: Array.isArray(cfg.couponTemplateIds) ? cfg.couponTemplateIds.length : 0,
              messageTitle: cfg.messageTitle || null,
            },
          }),
        ]
      )

      await client.query('COMMIT')
      sentCount++
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`[cronTask/birthday] failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

// ============ STEP 4: 感恩日权益发放 ============

/**
 * 加载感恩日权益配置（system_configs.thanksgiving_benefits）
 * 缺失或解析失败 → 返回 null（cronTask 仍执行其他 STEP，仅跳过 STEP 4）
 */
async function loadThanksgivingBenefitsConfig(client) {
  const result = await client.query(
    "SELECT value FROM system_configs WHERE key = 'thanksgiving_benefits'"
  )
  if (!result.rows[0]?.value) {
    console.warn('[cronTask] thanksgiving_benefits 配置不存在，跳过 STEP 4')
    return null
  }
  try {
    return JSON.parse(result.rows[0].value)
  } catch (err) {
    console.error('[cronTask] thanksgiving_benefits 解析失败:', err.message)
    return null
  }
}

/**
 * 感恩日三件套权益发放（消息 / 积分 / 优惠券）
 * 与 birthday 的关键差异：
 *   - 幂等键带 {YYYY-MM}（月度事件，而非年度）
 *   - 优惠券有效期强制 10 天（admin UI 硬约束，不读 coupon_templates.validity_mode）
 *
 * 幂等键前缀：
 *   消息：thx-msg-{YYYY-MM}-{userId}
 *   积分：thx-pts-{YYYY-MM}-{userId}
 *   优惠券：thx-{YYYY-MM}-{userId}-{templateId}
 *
 * @param {object} client - pg 事务客户端
 * @param {string} userId - client_wechat_users.user_id
 * @param {string} yearMonth - 形如 '2026-04'（DB CURRENT_DATE 提取，规避时区）
 * @param {string} level - 顾客当前会员等级
 * @param {object} config - benefitsConfig[level]
 */
async function grantThanksgivingBenefits(client, userId, yearMonth, level, config) {
  // 1) 消息推送
  if (config.messageTitle) {
    await client.query(
      `INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
       VALUES ('客户', $1, $2, $3, 'system', $4, NOW())
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [userId, config.messageTitle, config.messageBody || null, `thx-msg-${yearMonth}-${userId}`]
    )
  }

  // 2) 积分发放（余额条件累加：仅当流水成功插入才累加，避免幂等冲突时重复加）
  if (config.points && config.points > 0) {
    const externalRef = `thx-pts-${yearMonth}-${userId}`
    const inserted = await client.query(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '感恩回馈', $2, NULL, $3, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, config.points, externalRef]
    )
    if (inserted.rowCount > 0) {
      await client.query(
        `UPDATE client_wechat_users
            SET points_balance = points_balance + $2,
                points_updated_at = NOW()
          WHERE user_id = $1`,
        [userId, config.points]
      )
    }
  }

  // 3) 优惠券发放（固定 10 天有效期，不读 validity_mode）
  if (Array.isArray(config.couponTemplateIds) && config.couponTemplateIds.length > 0) {
    for (const templateId of config.couponTemplateIds) {
      const tplResult = await client.query(
        'SELECT is_active FROM coupon_templates WHERE template_id = $1',
        [templateId]
      )
      const tpl = tplResult.rows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cronTask/thanksgiving] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }

      // admin UI 硬约束：感恩日券固定 10 天有效期
      const expireAt = new Date(Date.now() + 10 * 86400000)
      const couponId = `thx-${yearMonth}-${userId}-${templateId}`
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
 * 感恩日权益发放主流程
 *   仅每月 20 号触发（EXTRACT(DAY FROM CURRENT_DATE)=20 短路，避免其他日期无谓扫表）
 *   扫描：当日（service_date = CURRENT_DATE）有 status IN ('已完成','服务中') 服务单 + member_level 非空
 *   DISTINCT 去重（一位顾客当日多单只发一份）
 *   每个用户独立子事务：grantThanksgivingBenefits + operation_logs
 */
async function refreshThanksgivingBenefits(client) {
  // 非 20 号短路返回（避免无谓扫表日志噪音）
  const dayRow = (await client.query(
    'SELECT EXTRACT(DAY FROM CURRENT_DATE)::int AS d'
  )).rows[0]
  if (dayRow.d !== 20) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0, skippedNotDay20: true }
  }

  const benefitsConfig = await loadThanksgivingBenefitsConfig(client)
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  // 年月从 DB 取，规避 CloudBase Node.js UTC 时区漂移
  const ymRow = (await client.query(
    "SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS ym"
  )).rows[0]
  const yearMonth = ymRow.ym  // 形如 '2026-04'

  const rows = (await client.query(
    `SELECT DISTINCT cwu.user_id, cwu.member_level
       FROM service_orders so
       JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
      WHERE so.service_date = CURRENT_DATE
        AND so.status IN ('已完成', '服务中')
        AND so.client_user_id IS NOT NULL
        AND cwu.member_level IS NOT NULL`
  )).rows

  let sentCount = 0
  let skippedNoConfig = 0
  let errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    await client.query('BEGIN')
    try {
      await grantThanksgivingBenefits(client, row.user_id, yearMonth, row.member_level, cfg)

      await client.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('customer.thanksgivingBenefits', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
        [
          row.user_id,
          JSON.stringify({
            _v: 1,
            _t: 'thanksgiving',
            yearMonth,
            memberLevel: row.member_level,
            config: {
              points: cfg.points || 0,
              couponTemplateCount: Array.isArray(cfg.couponTemplateIds) ? cfg.couponTemplateIds.length : 0,
              messageTitle: cfg.messageTitle || null,
            },
          }),
        ]
      )

      await client.query('COMMIT')
      sentCount++
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`[cronTask/thanksgiving] failed for ${row.user_id}:`, err.message)
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

// ============ STEP 5: points_balance 一致性校验 ============

/**
 * 校验 client_wechat_users.points_balance 与 point_transactions 流水合计是否一致
 * 发现偏差写入 operation_logs（仅告警，不自动修复）
 *
 * 正确语义：points_balance = SUM(point_transactions.amount WHERE user_id = u.user_id)
 * 决策 D7：自动修补会掩盖上游 bug，只告警让人工排查
 */
async function auditPointsBalance(client) {
  const { rows } = await client.query(`
    WITH sums AS (
      SELECT user_id, COALESCE(SUM(amount), 0)::int AS total_from_txns
      FROM point_transactions
      GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0) AS cached_balance,
           COALESCE(s.total_from_txns, 0) AS expected_balance
      FROM client_wechat_users u
      LEFT JOIN sums s ON s.user_id = u.user_id
     WHERE COALESCE(u.points_balance, 0) <> COALESCE(s.total_from_txns, 0)
  `)

  for (const row of rows) {
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('points.balanceMismatch', 'customer', $1, $2::jsonb, 'cronTask', NOW())`,
      [
        row.user_id,
        JSON.stringify({
          cachedBalance: Number(row.cached_balance),
          expectedBalance: Number(row.expected_balance),
          delta: Number(row.expected_balance) - Number(row.cached_balance),
        }),
      ],
    )
  }

  const checkedCount = (
    await client.query('SELECT COUNT(*)::int AS cnt FROM client_wechat_users')
  ).rows[0]?.cnt || 0

  return { mismatchCount: rows.length, checkedCount }
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
      `held=${levelResult.heldCount} unchanged=${levelResult.unchangedCount} error=${levelResult.errorCount}`
    )

    // STEP 3: 生日权益（必须在 STEP 2 之后，使顾客当日既升级又命中生日时按新等级发放）
    const bdayResult = await refreshBirthdayBenefits(client)
    console.log(
      `[cronTask] STEP 3: birthday total=${bdayResult.total} ` +
      `sent=${bdayResult.sentCount} skipped=${bdayResult.skippedNoConfig} error=${bdayResult.errorCount}`
    )

    // STEP 4: 感恩日权益（仅每月 20 号触发；在 STEP 2 之后使得当日既升级又命中感恩日时按新等级发放）
    const thxResult = await refreshThanksgivingBenefits(client)
    if (thxResult.skippedNotDay20) {
      console.log('[cronTask] STEP 4: thanksgiving skipped (not day 20)')
    } else {
      console.log(
        `[cronTask] STEP 4: thanksgiving total=${thxResult.total} ` +
        `sent=${thxResult.sentCount} skipped=${thxResult.skippedNoConfig} error=${thxResult.errorCount}`
      )
    }

    // STEP 5: 积分余额一致性校验（仅告警，不自动修 — 决策 D7）
    // 规则：client_wechat_users.points_balance 应等于 SUM(point_transactions.amount)
    // 发现偏差写 operation_logs('points.balanceMismatch')，由人工排查上游触发点 bug
    const mismatchResult = await auditPointsBalance(client)
    console.log(
      `[cronTask] STEP 5: points balance audit mismatch=${mismatchResult.mismatchCount} ` +
      `checked=${mismatchResult.checkedCount}`
    )

    return {
      code: 0,
      message: 'success',
      data: {
        updatedCount,
        resetCount,
        stats,
        memberLevel: levelResult,
        birthday: bdayResult,
        thanksgiving: thxResult,
        pointsAudit: mismatchResult,
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

// 测试导出（CloudBase 运行时仅使用 main；以下为 vitest 单测访问内部函数）
exports.__test__ = {
  loadBirthdayBenefitsConfig,
  grantBirthdayBenefits,
  refreshBirthdayBenefits,
  loadThanksgivingBenefitsConfig,
  grantThanksgivingBenefits,
  refreshThanksgivingBenefits,
}
