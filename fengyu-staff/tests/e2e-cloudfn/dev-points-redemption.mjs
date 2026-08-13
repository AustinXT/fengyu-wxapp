#!/usr/bin/env bun
/**
 * dev 积分抵扣全链路（显式手动运行，不纳入默认 run-all）：
 * deployed clientApi 下单/取消 + deployed staffApi 确认收款/退款。
 *
 * 前置：PG_CONNECTION_STRING 指向 dev，并注入以下两组腾讯云 API 密钥：
 *   CLIENT_TENCENTCLOUD_SECRETID / CLIENT_TENCENTCLOUD_SECRETKEY
 *   STAFF_TENCENTCLOUD_SECRETID  / STAFF_TENCENTCLOUD_SECRETKEY
 * 所有夹具使用 TE2LS 命名空间，finally 精确清理。
 */
import './setup.mjs'
import crypto from 'node:crypto'
import https from 'node:https'
import {
  NS,
  TEST_STORE_ID,
  TEST_MANAGER_OPENID,
  TEST_CLIENT_PHONE,
  pgQuery,
  closePool,
} from './setup.mjs'
import {
  ensureTestStore,
  createTestStaff,
  createTestClient,
  createTestProduct,
  createTestCoupon,
  cleanupTestData,
} from './helpers/fixtures.mjs'

const CLIENT_DEV_ENV_ID = 'cloud1-3gpht4b01ff88838'
const STAFF_DEV_ENV_ID = 'cloud1-9g3ydpg512eecc99'
const runSuffix = Date.now().toString().slice(-7)
const testUserId = `${NS}_PTS_${runSuffix}`
const testOpenid = `${NS}_PTS_OP_${runSuffix}`
const zeroUserId = `${NS}_PTS_ZERO_${runSuffix}`
const zeroOpenid = `${NS}_PTS_ZERO_OP_${runSuffix}`
const seedRefs = [`${NS}_PTS_SEED_A_${runSuffix}`, `${NS}_PTS_SEED_B_${runSuffix}`]

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected}, actual=${actual}`)
  }
}

function moneyEq(actual, expected, message) {
  if (Math.abs(Number(actual) - Number(expected)) > 0.001) {
    throw new Error(`${message}: expected=${expected}, actual=${actual}`)
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding)
}

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(new Error(`SCF 返回无法解析（HTTP ${res.statusCode}）: ${raw.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('SCF 调用超时')))
    req.end(body)
  })
}

async function invokeRemoteFunction({ envId, functionName, params, credentialPrefix }) {
  const secretId = process.env[`${credentialPrefix}_TENCENTCLOUD_SECRETID`]
  const secretKey = process.env[`${credentialPrefix}_TENCENTCLOUD_SECRETKEY`]
  if (!secretId || !secretKey) {
    throw new Error(`缺少 ${credentialPrefix}_TENCENTCLOUD_SECRETID/SECRETKEY`)
  }

  const service = 'scf'
  const host = 'scf.tencentcloudapi.com'
  const action = 'Invoke'
  const region = 'ap-shanghai'
  const version = '2018-04-16'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify({
    FunctionName: functionName,
    Namespace: envId,
    ClientContext: JSON.stringify(params),
    LogType: 'Tail',
  })
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign, 'hex')
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await requestJson({
    hostname: host,
    method: 'POST',
    path: '/',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body)

  const apiError = response?.Response?.Error
  if (apiError) {
    throw new Error(`SCF ${functionName} 调用失败: ${apiError.Code}: ${apiError.Message}`)
  }
  const result = response?.Response?.Result
  const retMsg = result?.RetMsg
  if (!retMsg) {
    throw new Error(`SCF ${functionName} 未返回 RetMsg: ${JSON.stringify(result).slice(0, 500)}`)
  }
  return JSON.parse(retMsg)
}

async function invokeRemoteClient(action, payload = {}, openid = testOpenid) {
  return invokeRemoteFunction({
    envId: CLIENT_DEV_ENV_ID,
    functionName: 'clientApi',
    credentialPrefix: 'CLIENT',
    params: { action, payload: { _testOpenid: openid, ...payload } },
  })
}

async function invokeRemoteStaff(action, payload = {}) {
  return invokeRemoteFunction({
    envId: STAFF_DEV_ENV_ID,
    functionName: 'staffApi',
    credentialPrefix: 'STAFF',
    params: { action, payload },
  })
}

async function seedPoints() {
  const txIds = []
  for (let i = 0; i < 2; i++) {
    const amount = i === 0 ? 2000 : 3000
    const rows = await pgQuery(
      `INSERT INTO point_transactions
         (user_id, type, amount, external_ref, created_at)
       VALUES ($1, '等级升级奖励', $2, $3, NOW())
       RETURNING id`,
      [testUserId, amount, seedRefs[i]],
    )
    txIds.push(Number(rows[0].id))
    await pgQuery(
      `INSERT INTO point_batches
         (user_id, source_transaction_id, source_type, original_amount,
          remaining_amount, earned_at, expire_at, created_at, updated_at)
       VALUES ($1, $2, '等级升级奖励', $3, $3, NOW(),
               NOW() + ($4::int * INTERVAL '1 day'), NOW(), NOW())`,
      [testUserId, txIds[i], amount, i === 0 ? 20 : 365],
    )
  }
  await pgQuery(
    `UPDATE client_wechat_users SET points_balance = 5000, points_updated_at = NOW()
      WHERE user_id = $1`,
    [testUserId],
  )
  return txIds
}

async function pointState() {
  const rows = await pgQuery(
    `SELECT
       (SELECT points_balance::bigint FROM client_wechat_users WHERE user_id=$1) AS cached,
       (SELECT COALESCE(SUM(remaining_amount),0)::bigint FROM point_batches
         WHERE user_id=$1 AND remaining_amount>0 AND expire_at>NOW()) AS batches,
       (SELECT COALESCE(SUM(amount),0)::bigint FROM point_transactions WHERE user_id=$1) AS tx_net`,
    [testUserId],
  )
  return {
    cached: Number(rows[0].cached),
    batches: Number(rows[0].batches),
    txNet: Number(rows[0].tx_net),
  }
}

async function assertPointState(expected, label) {
  const state = await pointState()
  eq(state.cached, expected, `${label} cache`)
  eq(state.batches, expected, `${label} batches`)
  eq(state.txNet, expected, `${label} transactions`)
}

async function globalSnapshot() {
  const rows = await pgQuery(
    `SELECT
       (SELECT COUNT(*)::int FROM client_wechat_users) AS users,
       (SELECT COUNT(*)::int FROM point_transactions) AS txns,
       (SELECT COUNT(*)::int FROM point_batches) AS batches,
       (SELECT COUNT(*)::int FROM sale_orders WHERE COALESCE(points_used,0)>0) AS points_orders,
       (SELECT COUNT(*)::int FROM operation_logs WHERE action='points.settleFailed') AS settle_failed`,
  )
  return rows[0]
}

async function assertGlobalIntegrity() {
  const rows = await pgQuery(
    `WITH active AS (
       SELECT user_id, COALESCE(SUM(remaining_amount),0)::bigint balance
         FROM point_batches
        WHERE remaining_amount>0 AND expire_at>NOW()
        GROUP BY user_id
     ), tx AS (
       SELECT user_id, COALESCE(SUM(amount),0)::bigint balance
         FROM point_transactions GROUP BY user_id
     )
     SELECT
       (SELECT COUNT(*)::int FROM client_wechat_users u LEFT JOIN active a ON a.user_id=u.user_id
         WHERE u.points_balance::bigint<>COALESCE(a.balance,0)) AS cache_batch,
       (SELECT COUNT(*)::int FROM client_wechat_users u LEFT JOIN tx t ON t.user_id=u.user_id
         WHERE u.points_balance::bigint<>COALESCE(t.balance,0)) AS cache_tx,
       (SELECT COUNT(*)::int FROM point_batches
         WHERE remaining_amount<0 OR remaining_amount>original_amount) AS invalid_batches,
       (SELECT COUNT(*)::int FROM point_batches
         WHERE remaining_amount>0 AND expire_at<=NOW()) AS expired_unprocessed`,
  )
  const r = rows[0]
  eq(r.cache_batch, 0, '全局 cache vs batches')
  eq(r.cache_tx, 0, '全局 cache vs transactions')
  eq(r.invalid_batches, 0, '全局非法批次')
  eq(r.expired_unprocessed, 0, '全局过期未处理批次')
}

async function cancelRemoteOrder(saleOrderId) {
  const result = await invokeRemoteClient('order.cancel', { saleOrderId })
  eq(result.code, 0, `取消订单 ${saleOrderId}`)
}

async function main() {
  const observedDefects = []
  const baseline = await globalSnapshot()
  console.log(`[dev-points-redemption] baseline=${JSON.stringify(baseline)}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient({
    userId: testUserId,
    openid: testOpenid,
    phone: TEST_CLIENT_PHONE,
    pointsBalance: 0,
  })
  const { skuId } = await createTestProduct({
    suffix: `PTS${runSuffix}`,
    price: 1000,
    sessionCount: 10,
    salesCategory: '他销自耗',
  })
  const { couponId } = await createTestCoupon({
    templateId: `${NS}_PTS_CTPL_${runSuffix}`,
    couponId: `${NS}_PTS_CPN_${runSuffix}`,
    userId: testUserId,
    discountValue: 100,
    minSpend: 1000,
  })
  const seedTxIds = await seedPoints()
  await assertPointState(5000, '种子积分')
  console.log('  ✅ 隔离顾客 + 两批积分（2000/3000）已建立')

  // 独立顾客验证零应付：1000 - 970 券 - 30 积分 = 0，创建即结清且不赠消费积分。
  await createTestClient({
    userId: zeroUserId,
    openid: zeroOpenid,
    phone: '19999098003',
    pointsBalance: 3000,
  })
  const zeroSeed = await pgQuery(
    `INSERT INTO point_transactions
       (user_id,type,amount,external_ref,created_at)
     VALUES ($1,'等级升级奖励',3000,$2,NOW()) RETURNING id`,
    [zeroUserId, `${NS}_PTS_ZERO_SEED_${runSuffix}`],
  )
  await pgQuery(
    `INSERT INTO point_batches
       (user_id,source_transaction_id,source_type,original_amount,remaining_amount,earned_at,expire_at)
     VALUES ($1,$2,'等级升级奖励',3000,3000,NOW(),NOW()+INTERVAL '365 days')`,
    [zeroUserId, zeroSeed[0].id],
  )
  const zeroCoupon = await createTestCoupon({
    templateId: `${NS}_PTS_ZERO_CTPL_${runSuffix}`,
    couponId: `${NS}_PTS_ZERO_CPN_${runSuffix}`,
    userId: zeroUserId,
    discountValue: 970,
    minSpend: 1000,
  })
  const zeroOrder = await invokeRemoteClient('order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    couponId: zeroCoupon.couponId,
    usePoints: true,
    pointsUsed: 3000,
  }, zeroOpenid)
  eq(zeroOrder.code, 0, `零应付积分订单: ${zeroOrder.message}`)
  eq(zeroOrder.data.status, '已支付', '零应付状态')
  eq(zeroOrder.data.reason, 'points_full', '零应付原因')
  moneyEq(zeroOrder.data.totalAmount, 0, '零应付总额')
  const zeroState = await pgQuery(
    `SELECT so.status,so.received,so.points_used,so.points_discount,
            (SELECT COUNT(*) FROM point_transactions pt
              WHERE pt.ref_order_id=so.sale_order_id AND pt.type='消费赠送') AS reward_count,
            (SELECT points_balance FROM client_wechat_users WHERE user_id=$2) AS balance
       FROM sale_orders so WHERE so.sale_order_id=$1`,
    [zeroOrder.data.saleOrderId, zeroUserId],
  )
  eq(zeroState[0].status, '已支付', 'PG 零应付状态')
  moneyEq(zeroState[0].received, 0, 'PG 零应付实收')
  eq(Number(zeroState[0].points_used), 3000, 'PG 零应付积分')
  eq(Number(zeroState[0].reward_count), 0, '零实收不赠积分')
  eq(Number(zeroState[0].balance), 0, '零应付顾客剩余积分')
  console.log('  ✅ 零应付积分订单：创建即已支付、实收0、赠送积分0')

  const balance = await invokeRemoteClient('points.balance')
  eq(balance.code, 0, 'deployed points.balance code')
  eq(Number(balance.data.balance), 5000, 'deployed points.balance')
  eq(Number(balance.data.expiringSoonPoints), 2000, '20 天内到期积分')
  moneyEq(balance.data.pointsToYuanRate, 0.01, '积分兑换比例')
  moneyEq(balance.data.pointsDeductionMaxRate, 0.03, '积分抵扣上限')
  console.log('  ✅ deployed points.balance：余额/临期/0.01/3% 正确')

  const unregisteredBalance = await invokeRemoteClient(
    'points.balance',
    {},
    `${NS}_PTS_UNREGISTERED_${runSuffix}`,
  )
  eq(unregisteredBalance.code, -403, '未注册 OPENID balance code')
  eq(unregisteredBalance.errorType, 'PHONE_REQUIRED', '未注册 OPENID balance errorType')
  for (const invalidPayload of [
    { page: 0, pageSize: 20 },
    { page: 1, pageSize: -1 },
    { page: 1, pageSize: 1000 },
  ]) {
    const invalidHistory = await invokeRemoteClient('points.history', invalidPayload)
    eq(invalidHistory.code, -400, `history 非法分页 code ${JSON.stringify(invalidPayload)}`)
    eq(invalidHistory.errorType, 'INVALID_PARAMS', `history 非法分页 errorType ${JSON.stringify(invalidPayload)}`)
  }
  console.log('  ✅ deployed 积分接口守卫：未注册需绑定手机，非法分页返回 INVALID_PARAMS')

  // 客户端：1000 - 100 券 - 30 积分 = 870。
  const create = await invokeRemoteClient('order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    couponId,
    usePoints: true,
    pointsUsed: 3000,
  })
  eq(create.code, 0, `deployed order.create: ${create.message}`)
  const firstOrderId = create.data.saleOrderId
  moneyEq(create.data.totalAmount, 870, '券+积分后订单金额')
  eq(Number(create.data.pointsUsed), 3000, '订单使用积分')
  moneyEq(create.data.pointsDiscount, 30, '订单积分抵扣金额')
  eq(create.data.status, '待支付', '积分订单初始状态')

  const firstOrder = await pgQuery(
    `SELECT status,total_amount,payable_amount,received,points_used,points_discount,coupon_discount
       FROM sale_orders WHERE sale_order_id=$1`, [firstOrderId],
  )
  eq(firstOrder.length, 1, '积分订单落库行数')
  moneyEq(firstOrder[0].total_amount, 870, 'PG total_amount')
  moneyEq(firstOrder[0].payable_amount, 870, 'PG payable_amount')
  moneyEq(firstOrder[0].received, 0, 'PG 待支付 received')
  eq(Number(firstOrder[0].points_used), 3000, 'PG points_used')
  moneyEq(firstOrder[0].coupon_discount, 100, 'PG coupon_discount')
  const seedBatches = await pgQuery(
    `SELECT source_transaction_id,remaining_amount FROM point_batches
      WHERE source_transaction_id=ANY($1::bigint[]) ORDER BY expire_at`, [seedTxIds],
  )
  eq(Number(seedBatches[0].remaining_amount), 0, 'FIFO 第一批清零')
  eq(Number(seedBatches[1].remaining_amount), 2000, 'FIFO 第二批剩余')
  await assertPointState(2000, '客户端积分下单后')
  console.log(`  ✅ deployed 客户端积分下单：order=${firstOrderId}，券100 + 积分3000，FIFO 正确`)

  // 员工线下确认：实际结算 870 → floor(870/100)=8。
  const confirmed = await invokeRemoteStaff('order.confirmOffline', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: firstOrderId,
  })
  eq(confirmed.code, 0, `staff confirmOffline: ${confirmed.message}`)
  const paid = await pgQuery(
    `SELECT status,received FROM sale_orders WHERE sale_order_id=$1`, [firstOrderId],
  )
  eq(paid[0].status, '已支付', '线下确认后状态')
  moneyEq(paid[0].received, 870, '线下确认后实收')
  const reward = await pgQuery(
    `SELECT amount FROM point_transactions WHERE ref_order_id=$1 AND type='消费赠送'`, [firstOrderId],
  )
  eq(reward.length, 1, '消费赠送流水数')
  eq(Number(reward[0].amount), 8, '按实际结算赠送积分')
  await assertPointState(2008, '线下确认后')
  const duplicateConfirm = await invokeRemoteStaff('order.confirmOffline', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: firstOrderId,
  })
  check(duplicateConfirm.code !== 0, '重复确认收款必须失败')
  console.log('  ✅ 线下确认赠送 8 分，重复确认未重复赠送')

  // 全额退款：冲销赠送的 8 分，但不返还已抵扣的 3000 分。
  const itemRows = await pgQuery(
    `SELECT sale_item_id,session_count FROM sale_items WHERE sale_order_id=$1`, [firstOrderId],
  )
  const refund = await invokeRemoteStaff('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: firstOrderId,
    items: [{ saleItemId: itemRows[0].sale_item_id, refundQuantity: Number(itemRows[0].session_count) }],
    refundReason: `${NS}_积分订单全退`,
  })
  eq(refund.code, 0, `createRefund: ${refund.message}`)
  const approved = await invokeRemoteStaff('order.approveRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId: refund.data.paymentId,
    auditRemark: `${NS}_积分退款审批`,
  })
  let expectedBalance
  if (approved.code === 0) {
    const refundState = await pgQuery(
      `SELECT status,refunded_amount FROM sale_orders WHERE sale_order_id=$1`, [firstOrderId],
    )
    eq(refundState[0].status, '已退款', '全退后订单状态')
    moneyEq(refundState[0].refunded_amount, 870, '全退金额')
    const pointFlows = await pgQuery(
      `SELECT type,amount FROM point_transactions WHERE ref_order_id=$1 ORDER BY id`, [firstOrderId],
    )
    eq(pointFlows.filter(x => x.type === '消费冲销').reduce((s, x) => s + Number(x.amount), 0), -8, '退款冲销积分')
    eq(pointFlows.filter(x => x.type === '消费抵扣退回').length, 0, '已支付退款不返抵扣积分')
    await assertPointState(2000, '全额退款后')
    const coupon = await pgQuery(`SELECT status FROM user_coupons WHERE coupon_id=$1`, [couponId])
    eq(coupon[0].status, '未使用', '整单全退返券')
    expectedBalance = 2000
    console.log('  ✅ 全额退款冲销赠送积分，已抵扣积分不返还，优惠券恢复')
  } else {
    observedDefects.push(`整单退款审批失败: code=${approved.code}, errorType=${approved.errorType}, message=${approved.message}`)
    const rejected = await invokeRemoteStaff('order.rejectRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId: refund.data.paymentId,
      auditRemark: `${NS}_测试失败后作废退款申请`,
    })
    eq(rejected.code, 0, `失败退款申请作废: ${rejected.message}`)
    await assertPointState(2008, '退款审批失败回滚后')
    expectedBalance = 2008
    console.log('  ❌ 已确认缺陷：整单退款审批绑定参数错误；事务已回滚，测试退款申请已作废')
  }

  // 待支付取消：1000 分抵 ¥10，取消后只返一次。
  const cancelCreate = await invokeRemoteClient('order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    usePoints: true,
    pointsUsed: 1000,
  })
  eq(cancelCreate.code, 0, `取消用例创建: ${cancelCreate.message}`)
  const cancelOrderId = cancelCreate.data.saleOrderId
  await assertPointState(expectedBalance - 1000, '取消前扣分')
  await cancelRemoteOrder(cancelOrderId)
  await assertPointState(expectedBalance, '取消返分后')
  const returned = await pgQuery(
    `SELECT COUNT(*)::int n,COALESCE(SUM(amount),0)::bigint amount
       FROM point_transactions WHERE ref_order_id=$1 AND type='消费抵扣退回'`, [cancelOrderId],
  )
  eq(returned[0].n, 1, '取消返还流水数')
  eq(Number(returned[0].amount), 1000, '取消返还积分')
  const cancelAgain = await invokeRemoteClient('order.cancel', { saleOrderId: cancelOrderId })
  check(cancelAgain.code !== 0, '重复取消必须失败')
  const returnedAgain = await pgQuery(
    `SELECT COUNT(*)::int n FROM point_transactions WHERE ref_order_id=$1 AND type='消费抵扣退回'`, [cancelOrderId],
  )
  eq(returnedAgain[0].n, 1, '重复取消不得重复返分')
  console.log('  ✅ 待支付取消返分幂等')

  // 缓存伪高：预检查可过，但事务按批次余额拒绝并完整回滚。
  await pgQuery(`UPDATE client_wechat_users SET points_balance=5000 WHERE user_id=$1`, [testUserId])
  const beforeFailed = await pgQuery(
    `SELECT COUNT(*)::int n FROM sale_orders WHERE client_user_id=$1`, [testUserId],
  )
  const stale = await invokeRemoteClient('order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    usePoints: true,
    pointsUsed: 3000,
  })
  eq(stale.errorType, 'INSUFFICIENT_BALANCE', '缓存伪高错误类型')
  const afterFailed = await pgQuery(
    `SELECT COUNT(*)::int n FROM sale_orders WHERE client_user_id=$1`, [testUserId],
  )
  eq(afterFailed[0].n, beforeFailed[0].n, '积分不足事务不得留订单')
  await pgQuery(
    `UPDATE client_wechat_users c SET points_balance=(
       SELECT COALESCE(SUM(remaining_amount),0) FROM point_batches
        WHERE user_id=c.user_id AND remaining_amount>0 AND expire_at>NOW()
     ) WHERE user_id=$1`, [testUserId],
  )
  await assertPointState(expectedBalance, '缓存修复后')
  console.log('  ✅ 缓存伪高仍由批次真余额拦截，事务无残留')

  // 并发使用 2000 分：只能成功一单、只有一笔扣分。
  const concurrentPayload = {
    storeId: TEST_STORE_ID,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    usePoints: true,
    pointsUsed: 2000,
  }
  const concurrent = await Promise.all([
    invokeRemoteClient('order.create', concurrentPayload),
    invokeRemoteClient('order.create', concurrentPayload),
  ])
  const successes = concurrent.filter(x => x.code === 0)
  eq(successes.length, 1, '并发创建成功数')
  const pending = await pgQuery(
    `SELECT sale_order_id FROM sale_orders
      WHERE client_user_id=$1 AND status='待支付' AND opened_by IS NULL`, [testUserId],
  )
  eq(pending.length, 1, '并发待支付订单数')
  const pendingId = successes[0].data.saleOrderId
  eq(pending[0].sale_order_id, pendingId, '并发胜出订单')
  const deductions = await pgQuery(
    `SELECT COUNT(*)::int n,COALESCE(SUM(amount),0)::bigint amount
       FROM point_transactions WHERE ref_order_id=$1 AND type='消费抵扣'`, [pendingId],
  )
  eq(deductions[0].n, 1, '并发扣分流水数')
  eq(Number(deductions[0].amount), -2000, '并发扣分金额')
  await cancelRemoteOrder(pendingId)
  await assertPointState(expectedBalance, '并发胜出单取消后')
  console.log('  ✅ 并发下单未超扣：1 成功 / 1 失败 / 1 笔扣分')

  // 员工端非销售单拒绝积分；销售单正常扣分并线下确认。
  const rejectedInternal = await invokeRemoteStaff('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_积分顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '内部单',
    usePoints: true,
    pointsUsed: 1000,
  })
  eq(rejectedInternal.errorType, 'INVALID_PARAMS', '非销售单积分拦截')
  const staffCreate = await invokeRemoteStaff('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_积分顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '销售单',
    usePoints: true,
    pointsUsed: 1000,
  })
  eq(staffCreate.code, 0, `staff points order.create: ${staffCreate.message}`)
  eq(Number(staffCreate.data.pointsUsed), 1000, 'staff pointsUsed')
  moneyEq(staffCreate.data.pointsDiscount, 10, 'staff pointsDiscount')
  moneyEq(staffCreate.data.totalAmount, 990, 'staff 积分后总额')
  await assertPointState(expectedBalance - 1000, '员工积分开单后')
  const staffPaid = await invokeRemoteStaff('order.confirmOffline', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: staffCreate.data.saleOrderId,
  })
  eq(staffPaid.code, 0, `staff points confirmOffline: ${staffPaid.message}`)
  const staffReward = await pgQuery(
    `SELECT amount FROM point_transactions
      WHERE ref_order_id=$1 AND type='消费赠送'`, [staffCreate.data.saleOrderId],
  )
  eq(Number(staffReward[0].amount), 9, 'staff 实收 990 赠送积分')
  await assertPointState(expectedBalance - 991, '员工线下确认后')
  console.log('  ✅ staff 积分开单 + 线下确认：抵扣1000，实收990，赠送9')

  await assertGlobalIntegrity()
  console.log('  ✅ 测试中全局积分三账一致')
  if (observedDefects.length > 0) {
    throw new Error(`业务缺陷 ${observedDefects.length} 项：${observedDefects.join('；')}`)
  }
}

let ok = false
try {
  await main()
  ok = true
} catch (error) {
  console.error(`[dev-points-redemption] FAIL: ${error.message}`)
  if (process.env.E2E_DEBUG) console.error(error.stack)
} finally {
  try {
    await cleanupTestData(NS)
    const residue = await pgQuery(
      `SELECT
         (SELECT COUNT(*)::int FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1) AS users,
         (SELECT COUNT(*)::int FROM point_transactions WHERE user_id LIKE $1 OR external_ref LIKE $1) AS txns,
         (SELECT COUNT(*)::int FROM point_batches WHERE user_id LIKE $1) AS batches,
         (SELECT COUNT(*)::int FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1 OR store_id LIKE $1) AS orders`,
      [`${NS}%`],
    )
    const r = residue[0]
    if (r.users || r.txns || r.batches || r.orders) {
      throw new Error(`清理残留: ${JSON.stringify(r)}`)
    }
    await assertGlobalIntegrity()
    console.log('[dev-points-redemption] cleanup/residue/integrity PASS')
  } catch (cleanupError) {
    ok = false
    console.error(`[dev-points-redemption] CLEANUP FAIL: ${cleanupError.message}`)
  }
  await closePool()
}

console.log(`[dev-points-redemption] ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
