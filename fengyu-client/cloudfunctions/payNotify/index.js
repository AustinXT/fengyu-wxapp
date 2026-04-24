/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { getMemberThreshold } = require('./config')

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
      'SELECT status, payment_method, wechat_transaction_id, preferred_employee_id, total_amount, client_user_id, store_id, prepaid_card_amount FROM sale_orders WHERE sale_order_id = $1',
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

      // 3a. 充值卡入账（识别 product_kind='充值卡' 的行 → UPSERT prepaid_cards + INSERT card_transactions）
      // 必须在状态翻转之后、业绩分配之前；与上述 UPDATE 同事务保证原子性。
      //
      // 覆盖两种下单路径：
      //   - 虚拟 SKU（clientApi 自助充值 / staffApi 自定义金额）：面值从 product_name 的 "¥{n}" 解析
      //   - 真实档位 SKU（staffApi 店长替充）：面值 = product_skus.price
      //
      // 幂等：card_transactions.ref_order_id 单独 SELECT 去重（表无 UNIQUE 约束），
      // 外层 status 翻转 rowCount 已是第一道幂等闸。
      if (order.client_user_id && order.store_id) {
        const rechargeRows = await client.query(
          `SELECT si.sku_id, si.product_name, sk.price AS sku_price
           FROM sale_items si
           LEFT JOIN product_skus sk ON si.sku_id = sk.sku_id
           LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
           WHERE si.sale_order_id = $1 AND pc.product_kind = '充值卡'`,
          [orderNo]
        )
        if (rechargeRows.rows.length > 0) {
          const dupCheck = await client.query(
            `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 LIMIT 1`,
            [orderNo]
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
                [newCardId, order.client_user_id, faceValue]
              )
              const cardId = upsertRes.rows[0].card_id
              await client.query(
                `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
                 VALUES ($1, '充值', $2, $3, NOW())`,
                [cardId, faceValue, orderNo]
              )
              console.log(`[payNotify] 充值入账: order=${orderNo}, card=${cardId}, faceValue=${faceValue}, skuId=${row.sku_id}`)
            }
          } else {
            console.log(`[payNotify] 充值入账幂等跳过: order=${orderNo}`)
          }
        }
      }

      // 3b. 消费扣款入账（订单的 prepaid_card_amount > 0 时扣余额）
      // 幂等：card_transactions 用 ref_order_id + type='扣款' 的 NOT EXISTS 守护
      // 余额不足时抛错 → 整个事务回滚 → 订单保持 '待支付'（ticket §4.8 #38）
      if (order.client_user_id && Number(order.prepaid_card_amount) > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
          [orderNo]
        )
        if (dupCheck.rows.length === 0) {
          const prepaidAmount = Number(order.prepaid_card_amount)
          // 二次校验余额（FOR UPDATE 锁，防并发）
          const cardRow = await client.query(
            `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
            [order.client_user_id]
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
            [cardId, -prepaidAmount, orderNo]
          )
          console.log(`[payNotify] 消费扣款: order=${orderNo}, card=${cardId}, amount=${prepaidAmount}`)
        } else {
          console.log(`[payNotify] 消费扣款幂等跳过: order=${orderNo}`)
        }
      }

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
      // B1 方案：'1990-1W' 档下界从 config 读取，枚举标签保留（历史 bucket id）
      if (order.client_user_id) {
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
          [order.client_user_id, tierThreshold]
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
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 JOIN product_skus sk ON sk.sku_id = si.sku_id
                 JOIN product_categories pc ON pc.category_id = sk.category_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND pc.product_kind <> '体验卡'
               ) THEN '小美客'
               WHEN EXISTS (
                 SELECT 1
                 FROM sale_orders o
                 JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                 JOIN product_skus sk ON sk.sku_id = si.sku_id
                 JOIN product_categories pc ON pc.category_id = sk.category_id
                 WHERE o.client_user_id = $1
                   AND o.status IN ('已支付', '已完成')
                   AND o.sale_order_type = '销售单'
                   AND pc.product_kind = '体验卡'
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
