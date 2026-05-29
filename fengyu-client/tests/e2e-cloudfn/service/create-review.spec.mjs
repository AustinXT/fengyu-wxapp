#!/usr/bin/env bun
/**
 * clientApi.service.createReview 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/service.js#createReview
 *
 * 实测要点（顾客评价美容师）：
 *   - PK = service_order_id（service_reviews 一单一评，重复 PG 23505 → CONFLICT）
 *   - 仅本人 + 已完成状态可评价
 *   - employee_id 取服务单 assigned_employee_id 快照
 *   - rating 必须 1-5 整数；comment 选填、上限 500、null/空兜底
 *
 * 用例（10 个）：
 *   1. happy → service_reviews 1 行（含 rating + comment）
 *   2. 重复评价 → CONFLICT
 *   3. 未完成（'待客户确认'） → INVALID_STATE
 *   4. 跨用户 → PERMISSION_DENIED
 *   5. rating 越界（0/6/3.5） → INVALID_PARAMS
 *   6. comment 超 500 → INVALID_PARAMS
 *   7. PHONE_REQUIRED：未绑定手机
 *   8. INVALID_PARAMS：缺 serviceOrderId
 *   9. comment 非 string → INVALID_PARAMS 格式不正确
 *  10. comment=null/空/纯空格 → 写入 service_reviews.comment=null
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID,
  pgQuery, getPool,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestClient, createTestStaff, ensureTestStore,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import {
  cleanupClientExtras, createTestClient2, createTestBeautician,
} from '../helpers/client-fixtures.mjs'

/**
 * 创建已支付销售单 + sale_items（最简，仅供 createReview 当前提）
 */
async function createCardOrder({ saleOrderId, clientUserId, saleItemId, storeId = TEST_STORE_ID }) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status
       )
       VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, '19999099002', $5,
               1000, 0, 1000, 1000,
               '线下'::payment_method, $6, '待分配'::allocation_status)`,
      [saleOrderId, `${NS}_市场`, storeId, clientUserId, `${NS}_顾客`, TEST_MANAGER_EMP_ID]
    )
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '默认', '疗程卡'::product_type,
               1000, 1, 1000, 1000, 1000,
               false)`,
      [saleItemId, saleOrderId, storeId, `${NS}_测试商品`]
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function createServiceOrder({
  serviceOrderId, saleItemId, clientUserId, employeeId,
  storeId = TEST_STORE_ID, status = '已完成',
}) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO service_orders (
         service_order_id, status, service_order_type, market_name, store_id,
         service_date, assigned_employee_id, client_user_id
       )
       VALUES ($1, $2::service_order_status, '售前'::service_order_type, $3, $4,
               CURRENT_DATE, $5, $6)`,
      [serviceOrderId, status, `${NS}_市场`, storeId, employeeId, clientUserId]
    )
    const itemId = `${serviceOrderId}_SI`
    await client.query(
      `INSERT INTO service_items (
         service_item_id, sale_item_id, service_order_id,
         session_used, employee_id, service_duration
       )
       VALUES ($1, $2, $3, 1, $4, 60)`,
      [itemId, saleItemId, serviceOrderId, employeeId]
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 创建 1 个"已完成"服务单挂在 TEST_CLIENT_USER_ID 名下
 * @returns {Promise<{svcId, beautician}>}
 */
async function makeCompletedServiceOrder(suffix = '') {
  await ensureTestStore()
  await createTestStaff()
  const beautician = await createTestBeautician()
  await createTestClient()

  const saleOrderId = `${NS}_O${suffix}`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC${suffix}`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    status: '已完成',
  })
  return { svcId, beautician }
}

// ─────────────── 用例 ───────────────

async function caseReviewHappy() {
  const { svcId, beautician } = await makeCompletedServiceOrder('_HP')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', {
    serviceOrderId: svcId,
    rating: 5,
    comment: '服务很好，非常满意！',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.rating !== 5) throw new Error(`rating: ${res.data.rating}`)

  const rows = await pgQuery(
    'SELECT rating, comment, employee_id FROM service_reviews WHERE service_order_id = $1',
    [svcId]
  )
  if (rows.length !== 1) throw new Error(`expect 1 review row, got ${rows.length}`)
  if (rows[0].rating !== 5) throw new Error(`db rating mismatch: ${rows[0].rating}`)
  if (rows[0].employee_id !== beautician.employeeId) throw new Error(`employee mismatch: ${rows[0].employee_id}`)
  if (rows[0].comment !== '服务很好，非常满意！') throw new Error(`comment: ${rows[0].comment}`)
}

async function caseReviewConflict() {
  const { svcId } = await makeCompletedServiceOrder('_DUP')
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 4 })
  if (r1.code !== 0) throw new Error(`first review failed: ${r1.message}`)

  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 3 })
  if (r2.code === 0) throw new Error('expect non-zero on duplicate review')
  if (!/CONFLICT|已评价过/.test(r2.message || '')) {
    throw new Error(`expect CONFLICT, got "${r2.message}"`)
  }
}

async function caseReviewBeforeFinalize() {
  await ensureTestStore()
  await createTestStaff()
  const beautician = await createTestBeautician()
  await createTestClient()

  const saleOrderId = `${NS}_PRE`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_PRE`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    status: '待客户确认',  // 未完成
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 5 })
  if (res.code === 0) throw new Error('expect non-zero (INVALID_STATE)')
  if (!/INVALID_STATE|服务未完成/.test(res.message || '')) {
    throw new Error(`expect INVALID_STATE, got "${res.message}"`)
  }
}

async function caseReviewCrossUser() {
  await ensureTestStore()
  await createTestStaff()
  const beautician = await createTestBeautician()
  await createTestClient()
  await createTestClient2()

  const saleOrderId = `${NS}_CR`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT2_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_CR`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT2_USER_ID,
    employeeId: beautician.employeeId,
    status: '已完成',
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 5 })
  if (res.code === 0) throw new Error('expect non-zero (PERMISSION_DENIED)')
  if (!/PERMISSION_DENIED|无权评价/.test(res.message || '')) {
    throw new Error(`expect PERMISSION_DENIED, got "${res.message}"`)
  }
}

async function caseReviewRatingOutOfRange() {
  const { svcId } = await makeCompletedServiceOrder('_RT')

  let res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 0 })
  if (res.code === 0) throw new Error('expect non-zero for rating=0')
  if (!/INVALID_PARAMS|评分必须为 1-5/.test(res.message || '')) {
    throw new Error(`rating=0 expect INVALID_PARAMS, got "${res.message}"`)
  }

  res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 6 })
  if (res.code === 0) throw new Error('expect non-zero for rating=6')
  if (!/INVALID_PARAMS|评分必须为 1-5/.test(res.message || '')) {
    throw new Error(`rating=6 expect INVALID_PARAMS, got "${res.message}"`)
  }

  res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { serviceOrderId: svcId, rating: 3.5 })
  if (res.code === 0) throw new Error('expect non-zero for rating=3.5')
  if (!/INVALID_PARAMS|评分必须为 1-5/.test(res.message || '')) {
    throw new Error(`rating=3.5 expect INVALID_PARAMS, got "${res.message}"`)
  }
}

async function caseReviewCommentTooLong() {
  const { svcId } = await makeCompletedServiceOrder('_LONG')
  const longComment = 'x'.repeat(501)
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', {
    serviceOrderId: svcId, rating: 5, comment: longComment,
  })
  if (res.code === 0) throw new Error('expect non-zero on long comment')
  if (!/INVALID_PARAMS|超过 500/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS on long comment, got "${res.message}"`)
  }
}

async function caseReviewPhoneRequired() {
  // auth 中间件 60s 内存缓存：前序 case 已缓存 TEST_CLIENT_OPENID 的 phone=有值，
  // 用全新 openid（cache 未命中）+ 该用户绑定 phone=NULL
  await ensureTestStore()
  await createTestStaff()
  const beautician = await createTestBeautician()

  const noPhoneOpenid = `${NS}_NOPHONE_OPENID`
  const noPhoneUserId = `${NS}_NOPHONE_USER`
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, NULL, $3, '女', $4, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE SET phone = NULL, openid = EXCLUDED.openid`,
    [noPhoneUserId, noPhoneOpenid, `${NS}_无手机用户`, TEST_STORE_ID]
  )

  const saleOrderId = `${NS}_PR`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: noPhoneUserId, saleItemId })

  const svcId = `${NS}_SVC_PR`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: noPhoneUserId,
    employeeId: beautician.employeeId,
    status: '已完成',
  })

  const res = await invokeAs(noPhoneOpenid, 'service.createReview', { serviceOrderId: svcId, rating: 5 })
  if (res.code === 0) throw new Error('expect non-zero (PHONE_REQUIRED)')
  if (!/PHONE_REQUIRED|请先绑定手机号/.test(res.message || '')) {
    throw new Error(`expect PHONE_REQUIRED, got "${res.message}"`)
  }
}

async function caseReviewMissingParam() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', { rating: 5 })
  if (res.code === 0) throw new Error('expect non-zero (INVALID_PARAMS)')
  if (!/INVALID_PARAMS|缺少 serviceOrderId/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS, got "${res.message}"`)
  }
}

async function caseReviewCommentNonString() {
  const { svcId } = await makeCompletedServiceOrder('_NS')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', {
    serviceOrderId: svcId,
    rating: 5,
    comment: { malformed: true },  // 非 string
  })
  if (res.code === 0) throw new Error('expect non-zero on non-string comment')
  if (!/INVALID_PARAMS|格式不正确/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS 格式不正确, got "${res.message}"`)
  }
}

async function caseReviewCommentNullOrEmpty() {
  // 三个独立服务单：comment=null / '' / '   '，每次预期 service_reviews.comment=null
  const variants = [
    { suffix: '_NL', comment: null },
    { suffix: '_EM', comment: '' },
    { suffix: '_WS', comment: '   ' },
  ]
  for (const { suffix, comment } of variants) {
    const { svcId } = await makeCompletedServiceOrder(suffix)
    const res = await invokeAs(TEST_CLIENT_OPENID, 'service.createReview', {
      serviceOrderId: svcId, rating: 4, comment,
    })
    if (res.code !== 0) throw new Error(`expect code=0 for ${JSON.stringify(comment)}: ${res.message}`)

    const [row] = await pgQuery(
      'SELECT comment FROM service_reviews WHERE service_order_id = $1',
      [svcId]
    )
    if (!row) throw new Error(`expect review row for ${JSON.stringify(comment)}`)
    if (row.comment !== null) {
      throw new Error(`expect comment=null for input ${JSON.stringify(comment)}, got ${JSON.stringify(row.comment)}`)
    }
  }
}

const CASES = [
  ['happy → service_reviews 1 行', caseReviewHappy],
  ['二次评价 → CONFLICT', caseReviewConflict],
  ['未完成（待客户确认） → INVALID_STATE', caseReviewBeforeFinalize],
  ['跨用户 → PERMISSION_DENIED', caseReviewCrossUser],
  ['rating 越界（0/6/3.5） → INVALID_PARAMS', caseReviewRatingOutOfRange],
  ['comment 超 500 → INVALID_PARAMS', caseReviewCommentTooLong],
  ['未绑定手机号 → PHONE_REQUIRED', caseReviewPhoneRequired],
  ['缺 serviceOrderId → INVALID_PARAMS', caseReviewMissingParam],
  ['comment 非 string → INVALID_PARAMS 格式不正确', caseReviewCommentNonString],
  ['comment=null/空/纯空格 → 入库 comment=null', caseReviewCommentNullOrEmpty],
]

async function cleanupReviewArtifacts() {
  const like = `${NS}%`
  try { await pgQuery(`DELETE FROM service_reviews WHERE service_order_id LIKE $1`, [like]) } catch { /* noop */ }
}

let pass = 0, fail = 0
console.log(`[service/create-review.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupReviewArtifacts()
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupReviewArtifacts()
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[service/create-review.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
