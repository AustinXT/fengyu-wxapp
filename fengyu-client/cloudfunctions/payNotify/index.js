/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')
const { settlePointsSafe } = require('./points')
const { parseErrorPrefix } = require('./error-codes')

// 充值卡虚拟 SKU 标识 — 必须与 clientApi/routes/_constants.js 中的
// RECHARGE_VIRTUAL_SKU_ID 保持一致；payNotify 是独立云函数，故重复定义。
// seed 由 db/scripts/seed-recharge-virtual-product.js 维护。
const RECHARGE_VIRTUAL_SKU_ID = 'sku-recharge-virtual'

// PostgreSQL 连接（懒初始化）
let pgPool = null
function getPg() {
  if (!pgPool) {
    const { Pool } = require('pg')
    pgPool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 3,
      idleTimeoutMillis: 60000
    })
  }
  return pgPool
}

/**
 * D-Q1-2026-04-26 决策：payNotify 立即停用直到补完拉卡拉签名校验
 * 详见 notes/tickets/2026-04-26-sale-order-domain-refactor.md
 *      docs/audit/audit-04-pay-notify.md (P0-04-01)
 *
 * 拉卡拉对接前线上支付走"线下/储值卡"通道（admin/staff 路径），
 * payNotify 完全不应被任何客户端/小程序/外部回调触发。
 *
 * 任何 invocation 都直接拒绝 + 写 operation_logs 告警，
 * 等拉卡拉对接完成且签名校验补完后才解除此守卫。
 *
 * 关闭守卫的条件（缺一不可）：
 * 1. 拉卡拉商户配置完成 + APIv3 密钥/平台证书托管到环境变量
 * 2. 实现 verifyLakalaSignature(headers, body, secret) helper
 * 3. 实现 IP 白名单（拉卡拉回调来源段）
 * 4. 实现 transactionId 幂等键
 * 5. operation_logs 'cron.audit_invariants' 跑 1 周无 violations 后才允许解除
 *
 * 解除时：将 PAYNOTIFY_DISABLED 改为 false，并实现完整 V3 签名校验链路。
 * 原有业务逻辑保留在守卫之后（不删除），作为后续拉卡拉对接的参考。
 */
const PAYNOTIFY_DISABLED = true

/**
 * 云函数入口
 *
 * 注意：member_level（钻石等级）由 cronTask 每日凌晨3点统一重算，本函数不直接更新。
 */
exports.main = async (event) => {
  // ========== D-Q1-2026-04-26 守卫：payNotify 全锁 ==========
  // 必须最先执行，在任何业务逻辑、签名校验、解密之前。
  // 必须 return（不能 throw），避免被外层 try/catch 吞掉而继续走旧逻辑。
  if (PAYNOTIFY_DISABLED) {
    const safeEvent = event && typeof event === 'object' ? event : {}
    const isLikelyExternalCall = !!(safeEvent.transactionId || safeEvent.out_trade_no || safeEvent.signature)
    const severity = isLikelyExternalCall ? 'HIGH' : 'INFO'
    const eventKeys = Object.keys(safeEvent)

    console.warn(
      '[payNotify] DISABLED invocation rejected',
      JSON.stringify({ severity, isLikelyExternalCall, eventKeys })
    )

    // 写 operation_logs 告警（best-effort，失败不阻塞拒绝响应）
    try {
      let wxContext = null
      try {
        wxContext = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : null
      } catch (ctxErr) {
        wxContext = null
      }

      const targetId = isLikelyExternalCall ? 'EXTERNAL' : 'INTERNAL'
      const detail = {
        _v: 1,
        severity,
        event_keys: eventKeys,
        wxContext,
        timestamp: new Date().toISOString(),
        reason: 'PAYNOTIFY_DISABLED (D-Q1-2026-04-26)',
      }

      const pg = getPg()
      await pg.query(
        `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
         VALUES ('paynotify.disabled_invocation', 'security_event', $1, $2::jsonb, 'payNotify', NOW())`,
        [targetId, JSON.stringify(detail)]
      )
    } catch (logErr) {
      console.error('[payNotify disabled] log failure:', logErr && logErr.message)
    }

    return {
      code: -403,
      message: 'PERMISSION_DENIED: PAYNOTIFY_DISABLED',
      data: null,
    }
  }
  // ========== 守卫结束。以下为原有业务逻辑（保留为参考，等拉卡拉对接时启用） ==========

  console.log('[payNotify] received event:', JSON.stringify(event))

  try {
    // ========== Mock 模式：手动触发测试 ==========
    const { orderNo, transactionId, payAmount: payAmountInput, paymentMethod: paymentMethodInput } = event
    if (!orderNo) {
      return { code: 'FAIL', message: '缺少 orderNo' }
    }

    const pg = getPg()

    // 幂等检查：订单是否已支付
    // 读 sale_order_type + ref_sale_order_id 以支持"回款凭证单"场景（Ticket 2026-04-24 PR-C）
    const orderResult = await pg.query(
      `SELECT status, payment_method, wechat_transaction_id, preferred_employee_id,
              total_amount, client_user_id, store_id, prepaid_card_amount,
              sale_order_type, ref_sale_order_id
       FROM sale_orders WHERE sale_order_id = $1`,
      [orderNo]
    )

    if (orderResult.rows.length === 0) {
      console.error('[payNotify] 订单不存在:', orderNo)
      return { code: 'FAIL', message: '订单不存在' }
    }

    const order = orderResult.rows[0]

    // 回款单场景：payments 行应写到 ref_sale_order_id（原销售单）；
    // 凭证单自身仅状态翻 '已支付'，业务动作（次数到期/业绩/充值/消费扣款/档位）以原单为准。
    const isRepaymentCredential = order.sale_order_type === '回款单' && order.ref_sale_order_id
    let targetOrderNo = orderNo
    let targetOrder = order
    if (isRepaymentCredential) {
      const origRes = await pg.query(
        `SELECT status, payment_method, wechat_transaction_id, preferred_employee_id,
                total_amount, client_user_id, store_id, prepaid_card_amount,
                sale_order_type, ref_sale_order_id
         FROM sale_orders WHERE sale_order_id = $1`,
        [order.ref_sale_order_id]
      )
      if (origRes.rows.length === 0) {
        console.error('[payNotify] 回款凭证单对应的原单不存在:', orderNo, '->', order.ref_sale_order_id)
        return { code: 'FAIL', message: '原销售单不存在' }
      }
      targetOrderNo = order.ref_sale_order_id
      targetOrder = origRes.rows[0]
    }

    // 幂等：凭证单自身或原单已终态 → 再写一次 payments（ON CONFLICT DO NOTHING）后返回
    if (order.status === '已支付' || order.status === '已完成') {
      console.log('[payNotify] 订单已支付，跳过:', orderNo)
      return { code: 'SUCCESS', message: '已处理' }
    }

    // 处理 '待支付' / '部分支付' 两种状态
    if (order.status !== '待支付' && order.status !== '部分支付') {
      console.warn('[payNotify] 订单状态异常:', orderNo, order.status)
      return { code: 'FAIL', message: `订单状态异常: ${order.status}` }
    }

    const now = new Date()
    const txnId = transactionId || `mock_txn_${Date.now()}`
    // payment_method：默认沿用订单上记录的支付方式（pay/alipayPay 发起时已写入），
    // 允许回调事件显式覆盖（方便 staff 端走同一 payNotify 通道）。
    const paymentMethod = paymentMethodInput
      || (order.payment_method === '支付宝' ? '支付宝' : '微信')

    // 开启事务：更新订单 + 设置单品到期日 + 自动创建业绩分配
    const client = await pg.connect()
    try {
      await client.query('BEGIN')

      // ========== 核心幂等：INSERT payments 行（ON CONFLICT DO NOTHING） ==========
      //
      // 幂等键：uq_sop_txn (sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL
      //
      // **回款凭证单场景**：payments / 业务动作以 targetOrderNo（=原销售单）为准；
      //   凭证单本身在事务末尾再更新 status='已支付'。
      //
      // 先决定本次金额 payAmount：优先取 event.payAmount，否则按目标订单剩余应付推算
      //   remaining = (total_amount - prepaid_card_amount) - Σ payments.amount (已支付, 首次/回款/退款)
      // 第一次回调时 payments 表为空，remaining = total_amount - prepaid_card_amount（即全单线上应付）
      const payableAmount = Math.round(
        (Number(targetOrder.total_amount || 0) - Number(targetOrder.prepaid_card_amount || 0)) * 100
      ) / 100
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid_sum
         FROM sale_order_payments
         WHERE sale_order_id = $1
           AND status = '已支付'
           AND change_type IN ('首次支付','回款','退款')`,
        [targetOrderNo]
      )
      const paidSum = Number(sumRes.rows[0]?.paid_sum || 0)
      const remaining = Math.round((payableAmount - paidSum) * 100) / 100
      const thisPayAmount = (payAmountInput !== undefined && payAmountInput !== null)
        ? Math.round(Number(payAmountInput) * 100) / 100
        : remaining

      if (!(thisPayAmount > 0)) {
        throw new Error(`INVALID_PAY_AMOUNT: ${thisPayAmount}`)
      }

      // change_type：
      //   - 回款凭证单回调：总是 '回款'（线上通道）
      //   - 普通销售单：判断是否已有 '首次支付' 行
      let changeType
      if (isRepaymentCredential) {
        changeType = '回款'
      } else {
        const firstPayCheck = await client.query(
          `SELECT 1 FROM sale_order_payments
           WHERE sale_order_id = $1 AND change_type = '首次支付' LIMIT 1`,
          [targetOrderNo]
        )
        changeType = firstPayCheck.rows.length > 0 ? '回款' : '首次支付'
      }

      // INSERT payments（幂等：重复回调 ON CONFLICT DO NOTHING）
      // 注意：payments.sale_order_id 写 targetOrderNo（原销售单），不是凭证单
      const insertRes = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, operator_employee_id,
          note, created_at, paid_at
        ) VALUES ($1, $2, $3, $4, $5, '已支付', 'notify', NULL, $6, $7, $7)
        ON CONFLICT (sale_order_id, payment_method, external_txn_id)
          WHERE external_txn_id IS NOT NULL
        DO NOTHING
        RETURNING id`,
        [
          targetOrderNo, changeType, thisPayAmount, paymentMethod, txnId,
          isRepaymentCredential
            ? `${paymentMethod} 回款到账 凭证 ${orderNo}`
            : `${paymentMethod} 回调到账`,
          now,
        ]
      )

      if (insertRes.rows.length === 0) {
        // 唯一索引命中，重复回调；静默 ack 不再修改 sale_orders
        await client.query('ROLLBACK')
        console.log('[payNotify] 重复回调（uq_sop_txn 命中），跳过:', orderNo, txnId)
        return { code: 'SUCCESS', message: '已处理（幂等）' }
      }

      // 判定目标订单最终状态
      const newPaidSum = Math.round((paidSum + thisPayAmount) * 100) / 100
      const fullyPaid = newPaidSum + 0.001 >= payableAmount
      const newStatus = fullyPaid ? '已支付' : '部分支付'

      // 1. 更新目标订单：received 累加、status 置新值、paid_at（全额时）
      await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             received = $2,
             paid_at = CASE WHEN $1::text = '已支付' THEN $3 ELSE paid_at END,
             wechat_transaction_id = COALESCE(wechat_transaction_id, $4),
             updated_at = $3
         WHERE sale_order_id = $5`,
        [newStatus, newPaidSum, now, txnId, targetOrderNo]
      )

      // 1b. 回款凭证单：同步翻 '已支付' + 记录 paid_at + 记录 txn
      if (isRepaymentCredential) {
        await client.query(
          `UPDATE sale_orders
           SET status = '已支付'::order_status,
               paid_at = COALESCE(paid_at, $1),
               wechat_transaction_id = COALESCE(wechat_transaction_id, $2),
               updated_at = $1
           WHERE sale_order_id = $3`,
          [now, txnId, orderNo]
        )
      }

      // 后续业务动作（单品到期日 / 充值入账 / 消费扣款 / 业绩分配 / 顾客档位重算）
      // 仅当目标订单整单结清（fullyPaid = true）时才触发，避免部分支付中途产生副作用。
      if (!fullyPaid) {
        await client.query('COMMIT')
        console.log('[payNotify] 订单部分支付到账:', orderNo, `paid_sum=${newPaidSum}/${payableAmount}`)
        return { code: 'SUCCESS', message: '部分支付已到账' }
      }

      // 2. 设置单品到期日（paid_at + 1 year）——以原销售单为准
      await client.query(
        `UPDATE sale_items
         SET expire_date = ($1::date + interval '1 year')::date
         WHERE sale_order_id = $2
           AND product_type = '单品'
           AND expire_date IS NULL`,
        [now, targetOrderNo]
      )

      // 3a. 充值卡入账（识别 sale_items.is_recharge_card=true 的行 → UPSERT prepaid_cards + INSERT card_transactions）
      // 必须在状态翻转之后、业绩分配之前；与上述 UPDATE 同事务保证原子性。
      //
      // 覆盖两种下单路径：
      //   - 虚拟 SKU（clientApi 自助充值 / staffApi 自定义金额）：面值从 product_name 的 "¥{n}" 解析
      //   - 真实档位 SKU（staffApi 店长替充）：面值 = product_skus.price
      //
      // 幂等：card_transactions.ref_order_id 单独 SELECT 去重（表无 UNIQUE 约束），
      // 外层 status 翻转 rowCount 已是第一道幂等闸。
      //
      // 2026-04-26 capability 化：判定从 product_categories.product_kind='充值卡' 字面量
      // 切换为 sale_items.is_recharge_card 行级快照（开单时从 product_skus.is_recharge_card 拷贝）
      if (targetOrder.client_user_id && targetOrder.store_id) {
        const rechargeRows = await client.query(
          `SELECT si.sku_id, si.product_name, sk.price AS sku_price
           FROM sale_items si
           LEFT JOIN product_skus sk ON si.sku_id = sk.sku_id
           WHERE si.sale_order_id = $1 AND si.is_recharge_card = true`,
          [targetOrderNo]
        )
        if (rechargeRows.rows.length > 0) {
          const dupCheck = await client.query(
            `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 LIMIT 1`,
            [targetOrderNo]
          )
          if (dupCheck.rows.length === 0) {
            for (const row of rechargeRows.rows) {
              let faceValue
              if (row.sku_id === RECHARGE_VIRTUAL_SKU_ID) {
                const m = (row.product_name || '').match(/¥\s*(\d+(?:\.\d+)?)/)
                if (!m) {
                  throw new Error(`[payNotify] 充值订单 product_name 无法解析面值: ${row.product_name}`)
                }
                faceValue = parseFloat(m[1])
              } else {
                faceValue = Number(row.sku_price)
              }
              if (!(faceValue > 0)) continue

              const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
              const upsertRes = await client.query(
                `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW())
                 ON CONFLICT (user_id) DO UPDATE
                   SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
                 RETURNING card_id`,
                [newCardId, targetOrder.client_user_id, faceValue]
              )
              const cardId = upsertRes.rows[0].card_id
              await client.query(
                `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
                 VALUES ($1, '充值', $2, $3, NOW())`,
                [cardId, faceValue, targetOrderNo]
              )
              console.log(`[payNotify] 充值入账: order=${targetOrderNo}, card=${cardId}, faceValue=${faceValue}, skuId=${row.sku_id}`)
            }
          } else {
            console.log(`[payNotify] 充值入账幂等跳过: order=${targetOrderNo}`)
          }
        }
      }

      // 3b. 消费扣款入账（订单的 prepaid_card_amount > 0 时扣余额）
      // 幂等：card_transactions 用 ref_order_id + type='扣款' 的 NOT EXISTS 守护
      // 余额不足时抛错 → 整个事务回滚 → 订单保持 '待支付'（ticket §4.8 #38）
      if (targetOrder.client_user_id && Number(targetOrder.prepaid_card_amount) > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
          [targetOrderNo]
        )
        if (dupCheck.rows.length === 0) {
          const prepaidAmount = Number(targetOrder.prepaid_card_amount)
          // 二次校验余额（FOR UPDATE 锁，防并发）
          const cardRow = await client.query(
            `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
            [targetOrder.client_user_id]
          )
          if (cardRow.rows.length === 0 || Number(cardRow.rows[0].balance) < prepaidAmount) {
            throw new Error(`INSUFFICIENT_BALANCE: 储值卡余额不足以完成扣款`)
          }
          const cardId = cardRow.rows[0].card_id
          await client.query(
            `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
            [prepaidAmount, cardId]
          )
          await client.query(
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
             VALUES ($1, '扣款', $2, $3, NOW())`,
            [cardId, -prepaidAmount, targetOrderNo]
          )
          // 写储值卡抵扣流水（与 confirmOffline/staffApi 一致，amount 为负数）
          await client.query(
            `INSERT INTO sale_order_payments (
              sale_order_id, change_type, amount, payment_method,
              external_txn_id, status, source_end, operator_employee_id,
              note, created_at, paid_at
            ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'notify', NULL,
              $3, NOW(), NOW())`,
            [targetOrderNo, -prepaidAmount, `储值卡抵扣 订单 ${targetOrderNo}`]
          )
          console.log(`[payNotify] 消费扣款: order=${targetOrderNo}, card=${cardId}, amount=${prepaidAmount}`)
        } else {
          console.log(`[payNotify] 消费扣款幂等跳过: order=${targetOrderNo}`)
        }
      }

      // 3. 自动创建业绩分配（如有指定美容师）——以原销售单为准
      if (targetOrder.preferred_employee_id) {
        // 读取员工 skills 推断 role_type（首位技能，缺省回退到 '美容师'）
        const empRow = await client.query(
          'SELECT skills FROM staff_wechat_users WHERE employee_id = $1',
          [targetOrder.preferred_employee_id]
        )
        const skills = Array.isArray(empRow.rows[0]?.skills) ? empRow.rows[0].skills : []
        const roleType = skills[0] || '美容师'

        // 查询该订单的所有明细
        const itemsResult = await client.query(
          'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
          [targetOrderNo]
        )

        // 为每个明细行创建分配记录（100% 给指定美容师）
        for (const item of itemsResult.rows) {
          await client.query(
            `INSERT INTO sale_allocations
               (sale_item_id, employee_id, role_type, allocation_ratio, total_amount,
                is_void, created_at, updated_at)
             VALUES ($1, $2, $3, 1.00, $4, FALSE, $5, $5)
             ON CONFLICT ON CONSTRAINT uq_sale_alloc_item_emp_role DO NOTHING`,
            [item.sale_item_id, targetOrder.preferred_employee_id, roleType, item.received, now]
          )
        }
      }

      // 4. 重算顾客历史消费档位
      // B1 方案：'1990-1W' 档下界从 config 读取，枚举标签保留（历史 bucket id）
      if (targetOrder.client_user_id) {
        const tierThreshold = await getMemberThreshold()
        await client.query(
          `UPDATE client_wechat_users
           SET spending_tier = CASE
             WHEN t.total >= 100000 THEN '10W+'
             WHEN t.total >= 60000  THEN '6-10W'
             WHEN t.total >= 30000  THEN '3-6W'
             WHEN t.total >= 10000  THEN '1-3W'
             WHEN t.total >= $2     THEN '1990-1W'
             ELSE '<1990'
           END::spending_tier,
           updated_at = NOW()
           FROM (
             SELECT COALESCE(SUM(total_amount), 0) AS total
             FROM sale_orders
             WHERE client_user_id = $1
               AND status IN ('已支付', '已完成')
           ) t
           WHERE user_id = $1`,
          [targetOrder.client_user_id, tierThreshold]
        )

        // 5. 重算顾客类型（只升不降，已是会员客则跳过）
        const curType = await client.query(
          'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
          [targetOrder.client_user_id]
        )
        if (curType.rows[0]?.customer_type !== '会员客') {
          const threshold = await getMemberThreshold()

          // 三端 SQL 独立副本（admin actions/orders.ts + staffApi routes/order.js + payNotify index.js）
          // 修改时必须同步另外两端；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
          // 守护（会员客分支允许 payNotify 特有的回款单累计差异）。
          const typeResult = await client.query(
            `SELECT CASE
               WHEN EXISTS (
                 SELECT 1 FROM sale_orders o
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND (
                     o.total_amount >= $2
                     OR (o.total_amount + COALESCE((
                       SELECT SUM(r.total_amount)
                       FROM sale_orders r
                       WHERE r.ref_sale_order_id = o.sale_order_id
                         AND r.sale_order_type = '回款单'
                         AND r.status IN ('已支付', '已完成')
                     ), 0)) >= $2
                   )
               ) THEN '会员客'
               WHEN EXISTS (
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND si.is_experience = false
               ) THEN '小美客'
               WHEN EXISTS (
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND si.is_experience = true
               ) THEN '体验客'
               ELSE '流量客'
             END AS computed_type`,
            [targetOrder.client_user_id, threshold]
          )

          const newType = typeResult.rows[0].computed_type
          // 只升不降；若跃迁为 '会员客'，同步写入 became_member_at
          // TODO: 将来若开放降级路径，需同步 UPDATE became_member_at = NULL。
          const upgradeResult = await client.query(
            `UPDATE client_wechat_users
             SET customer_type = $2::customer_type, updated_at = NOW()
             WHERE user_id = $1
               AND (CASE customer_type
                      WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
                      WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
                    END)
                 < (CASE $2::customer_type
                      WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
                      WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
                    END)
             RETURNING customer_type`,
            [targetOrder.client_user_id, newType]
          )
          if (upgradeResult.rowCount > 0 && upgradeResult.rows[0].customer_type === '会员客') {
            await client.query(
              `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
              [targetOrder.client_user_id]
            )
          }
        }
      }

      // 6. 积分结算（订单链净额差值法，幂等）
      // targetOrderNo 已指向原销售单（回款凭证单场景上面已重映射），直接作为原单 id 传入
      const pointsResult = await settlePointsSafe(client, targetOrderNo, 'payNotify')
      if (pointsResult.delta) {
        console.log(`[payNotify] 积分结算: order=${targetOrderNo}, delta=${pointsResult.delta}, expected=${pointsResult.expected}`)
      }

      // 7. 分享礼：首单结清时向邀请人 + 新客各发一张动态面值代金券 + 一条站内消息
      // 仅在整单结清（fullyPaid=true）路径调用；回款凭证单场景以 targetOrderNo（原销售单）为幂等根键。
      // 幂等由 grantShareGift 内部 INSERT ... ON CONFLICT 保证；失败不阻塞主支付事务（ticket §9.4）。
      try {
        await client.query('SAVEPOINT sp_share_gift')
        const { grantShareGift } = require('./share-gift')
        const sgRes = await grantShareGift(client, {
          saleOrderId: targetOrderNo,
          clientUserId: targetOrder.client_user_id,
          paidAmount: newPaidSum,
          source: 'payNotify',
        })
        await client.query('RELEASE SAVEPOINT sp_share_gift')
        if (sgRes.granted) {
          console.log('[payNotify/share-gift] granted', sgRes)
        } else {
          console.log('[payNotify/share-gift] skipped', sgRes.reason)
        }
      } catch (sgErr) {
        // 分享礼失败不阻塞主支付事务
        try { await client.query('ROLLBACK TO SAVEPOINT sp_share_gift') } catch (e) {}
        console.error('[payNotify/share-gift] error (non-fatal):', sgErr)
      }

      await client.query('COMMIT')
      console.log('[payNotify] 订单支付成功:', orderNo)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return { code: 'SUCCESS', message: '成功' }
  } catch (err) {
    // [CC5] 用 parseErrorPrefix 给错误日志做归类（ops 按 errorType 监控告警）
    // 响应仍保持微信支付/拉卡拉协议要求的 {code: 'SUCCESS'|'FAIL', message} 外壳
    const parsed = parseErrorPrefix(err && err.message)
    console.error('[payNotify] Error:', err, parsed ? { errorType: parsed.prefix } : { errorType: null })
    return { code: 'FAIL', message: err.message }
  }
}
