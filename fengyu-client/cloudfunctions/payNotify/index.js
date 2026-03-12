/**
 * payNotify - 微信支付回调云函数
 *
 * 处理微信支付异步通知，更新订单状态。
 * 当前为 mock 结构，接入真实商户号后替换签名验证和解密逻辑。
 *
 * 接入真实微信支付时需要：
 * 1. 配置环境变量：MCH_ID, API_V3_KEY, CERT_SERIAL_NO
 * 2. 上传商户证书
 * 3. 替换 TODO 标记处的 mock 实现
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

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
 * 微信支付回调会以 HTTP 方式调用此函数
 */
exports.main = async (event) => {
  console.log('[payNotify] received event:', JSON.stringify(event))

  try {
    // TODO: 真实接入时，解析微信支付回调 XML/JSON 数据
    // const { resource } = event
    // 1. 使用 APIv3 密钥解密 resource.ciphertext
    // 2. 获取 transaction_id, out_trade_no(orderNo), trade_state

    // ========== Mock 模式：手动触发测试 ==========
    const { orderNo, transactionId } = event
    if (!orderNo) {
      return { code: 'FAIL', message: '缺少 orderNo' }
    }

    const pg = getPg()

    // 幂等检查：订单是否已支付
    const orderResult = await pg.query(
      'SELECT status, payment_method, wechat_transaction_id, preferred_employee_id FROM orders WHERE order_no = $1',
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
        `UPDATE orders
         SET status = '已支付', paid_at = $1, wechat_transaction_id = $2, updated_at = $1
         WHERE order_no = $3 AND status = '待支付'`,
        [now, txnId, orderNo]
      )

      // 2. 设置单品到期日（paid_at + 1 year）
      await client.query(
        `UPDATE order_items oi
         SET expire_date = ($1::date + interval '1 year')::date
         FROM product_spu_sku_map m
         WHERE oi.order_no = $2
           AND oi.sku_id = m.sku_id
           AND m.product_type = '单品'
           AND oi.expire_date IS NULL`,
        [now, orderNo]
      )

      // 3. 自动创建业绩分配（如有指定美容师）
      if (order.preferred_employee_id) {
        // 计算订单总金额
        const totalResult = await client.query(
          'SELECT COALESCE(SUM(receivable), 0) AS total FROM order_items WHERE order_no = $1',
          [orderNo]
        )
        const totalAmount = totalResult.rows[0].total

        // 插入默认分配（100% 给指定美容师）
        await client.query(
          `INSERT INTO revenue_allocations (order_no, employee_id, allocation_ratio, total_amount, created_at, updated_at)
           VALUES ($1, $2, 1.00, $3, $4, $4)
           ON CONFLICT (order_no, employee_id) DO NOTHING`,
          [orderNo, order.preferred_employee_id, totalAmount, now]
        )
      }

      await client.query('COMMIT')
      console.log('[payNotify] 订单支付成功:', orderNo)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // 返回成功响应给微信支付平台
    return { code: 'SUCCESS', message: '成功' }
  } catch (err) {
    console.error('[payNotify] Error:', err)
    return { code: 'FAIL', message: err.message }
  }
}
