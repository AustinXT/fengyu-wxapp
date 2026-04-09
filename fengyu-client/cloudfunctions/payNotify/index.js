/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')

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
 * 云函数入口
 *
 * 注意：member_level（钻石等级）由 cronTask 每日凌晨3点统一重算，本函数不直接更新。
 */
exports.main = async (event) => {
  console.log('[payNotify] received event:', JSON.stringify(event))

  try {
    // ========== Mock 模式：手动触发测试 ==========
    const { orderNo, transactionId } = event
    if (!orderNo) {
      return { code: 'FAIL', message: '缺少 orderNo' }
    }

    const pg = getPg()

    // 幂等检查：订单是否已支付
    const orderResult = await pg.query(
      'SELECT status, payment_method, wechat_transaction_id, preferred_employee_id, total_amount, client_user_id FROM sale_orders WHERE sale_order_id = $1',
      [orderNo]
    )

    if (orderResult.rows.length === 0) {
      console.error('[payNotify] 订单不存在:', orderNo)
      return { code: 'FAIL', message: '订单不存在' }
    }

    const order = orderResult.rows[0]

    // 幂等：已支付则直接返回成功
    if (order.status === '已支付' || order.status === '已完成') {
      console.log('[payNotify] 订单已支付，跳过:', orderNo)
      return { code: 'SUCCESS', message: '已处理' }
    }

    // 仅处理待支付状态
    if (order.status !== '待支付') {
      console.warn('[payNotify] 订单状态异常:', orderNo, order.status)
      return { code: 'FAIL', message: `订单状态异常: ${order.status}` }
    }

    const now = new Date()
    const txnId = transactionId || `mock_txn_${Date.now()}`

    // 开启事务：更新订单 + 设置单品到期日 + 自动创建业绩分配
    const client = await pg.connect()
    try {
      await client.query('BEGIN')

      // 1. 更新订单状态 → 已支付
      await client.query(
        `UPDATE sale_orders
         SET status = '已支付', paid_at = $1, wechat_transaction_id = $2, updated_at = $1
         WHERE sale_order_id = $3 AND status = '待支付'`,
        [now, txnId, orderNo]
      )

      // 2. 设置单品到期日（paid_at + 1 year）
      await client.query(
        `UPDATE sale_items
         SET expire_date = ($1::date + interval '1 year')::date
         WHERE sale_order_id = $2
           AND product_type = '单品'
           AND expire_date IS NULL`,
        [now, orderNo]
      )

      // 3. 自动创建业绩分配（如有指定美容师）
      if (order.preferred_employee_id) {
        const totalAmount = order.total_amount

        // 查询该订单的所有明细
        const itemsResult = await client.query(
          'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
          [orderNo]
        )

        // 为每个明细行创建分配记录（100% 给指定美容师）
        for (const item of itemsResult.rows) {
          await client.query(
            `INSERT INTO sale_allocations (sale_item_id, employee_id, allocation_ratio, total_amount, created_at, updated_at)
             VALUES ($1, $2, 1.00, $3, $4, $4)
             ON CONFLICT DO NOTHING`,
            [item.sale_item_id, order.preferred_employee_id, item.received, now]
          )
        }
      }

      // 4. 重算顾客历史消费档位
      if (order.client_user_id) {
        await client.query(
          `UPDATE client_wechat_users
           SET spending_tier = CASE
             WHEN t.total >= 100000 THEN '10W+'
             WHEN t.total >= 60000  THEN '6-10W'
             WHEN t.total >= 30000  THEN '3-6W'
             WHEN t.total >= 10000  THEN '1-3W'
             WHEN t.total >= 1990   THEN '1990-1W'
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
          [order.client_user_id]
        )

        // 5. 重算顾客类型（只升不降，已是会员客则跳过）
        const curType = await client.query(
          'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
          [order.client_user_id]
        )
        if (curType.rows[0]?.customer_type !== '会员客') {
          const threshold = await getMemberThreshold()

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
                 SELECT 1 FROM sale_orders
                 WHERE client_user_id = $1
                   AND status IN ('已支付', '已完成')
                   AND sale_order_type = '销售单'
               ) THEN '小美客'
               WHEN EXISTS (
                 SELECT 1 FROM sale_orders
                 WHERE client_user_id = $1
                   AND status IN ('已支付', '已完成')
                   AND sale_order_type = '销售单'
               ) THEN '体验客'
               ELSE '流量客'
             END AS computed_type`,
            [order.client_user_id, threshold]
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
            [order.client_user_id, newType]
          )
          if (upgradeResult.rowCount > 0 && upgradeResult.rows[0].customer_type === '会员客') {
            await client.query(
              `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
              [order.client_user_id]
            )
          }
        }
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
    console.error('[payNotify] Error:', err)
    return { code: 'FAIL', message: err.message }
  }
}
