// 私有PG子进程：真实payNotify.main，隔离渠道配置替身和函数内连接池。
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const path = require('node:path')
const callbackRequire = createRequire(path.resolve(__dirname, '../../../fengyu-client/cloudfunctions/payNotify/index.js'))
const url = new URL(process.env.PG_CONNECTION_STRING)
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/verify' && !url.search)
process.env.PAYNOTIFY_ENABLED = 'true'
process.env.WX_SHIPPING_ENABLED = 'false'
const configPath = callbackRequire.resolve('./utils/lakala-config')
callbackRequire.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { isReady: () => true } }
const { main } = callbackRequire('./index')
const { Client } = callbackRequire('pg')
const client = new Client({ connectionString: process.env.PG_CONNECTION_STRING })
;(async () => {
  await client.connect()
  const orderId = process.argv[2]
  for (const [index, amount] of [300, 200].entries()) {
    const orderNo = `${orderId}_${1000000000 + index}`
    await client.query('UPDATE sale_orders SET lakala_out_order_no=$2,first_payment_amount=$3 WHERE sale_order_id=$1', [orderId, orderNo, amount])
    const event = { orderNo, transactionId: `${orderId}-txn-${index}`, payAmount: amount }
    const response = await main(event)
    assert.equal(response.code, 'SUCCESS', JSON.stringify(response))
    const before = (await client.query('SELECT COUNT(*) AS n FROM sale_order_payments WHERE sale_order_id=$1', [orderId])).rows[0].n
    const repeated = await main(event)
    assert.equal(repeated.code, 'SUCCESS', JSON.stringify(repeated))
    assert.equal((await client.query('SELECT COUNT(*) AS n FROM sale_order_payments WHERE sale_order_id=$1', [orderId])).rows[0].n, before)
    const customer = (await client.query("SELECT customer_type,bound_employee_id FROM client_wechat_users WHERE user_id='CUSTOMER-1'")).rows[0]
    assert.equal(customer.customer_type, index === 0 ? '小美客' : '会员客')
    assert.equal(customer.bound_employee_id, null)
  }
  await client.end()
  process.exit(0)
})().catch(async error => { console.error(error); await client.end(); process.exit(1) })
