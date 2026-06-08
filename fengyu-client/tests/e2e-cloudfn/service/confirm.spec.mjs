#!/usr/bin/env bun
/**
 * clientApi.service.confirm 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/service.js#confirm
 * + utils/service-finalize.js#finalizeServiceOrder
 *
 * 实测要点（顾客确认服务完成）：
 *   - 状态机：'待客户确认' → '已完成'（其它状态均拒）
 *   - finalize 副作用：
 *       1. sale_items.remaining_sessions -= session_used（原子条件含 paid_sessions 限额）
 *       2. service_commissions INSERT（按 commission_rate_matrix 命中 role/sales_category/tier）
 *       3. service_orders.status='已完成' + completed_at + commission_status='已分配'
 *       4. 关联预约 status='已完成'（appointment_id 非空 + 原状态='已确认'）
 *       5. 扣完次数（remaining=0）→ 按 sale_item_id 索引关闭活跃 appt
 *   - 幂等：再次 confirm 返回 message 含 '幂等'，不重复扣次/不重复写提成
 *
 * 测试坐标系：role_type='养生师' + sales_category='生态合作'
 *   原因：finalize SQL 不按 org_id 过滤命中规则，使用默认 '美容师/自销自耗' 会被
 *   生产/staff fixture 残留规则干扰（命中错的 rate 导致金额断言失败）。
 *   '生态合作' 在 staff fixture 注释明确不配；'养生师/生态合作' 双重冷门，独占测试坐标系。
 *
 * 用例（13 个）：
 *   1. happy → 状态翻 + 扣次 + service_commissions 1 行（精确金额）
 *   2. 关联预约（appointment_id 路径）一并 closed
 *   3. 幂等：第二次确认返回幂等提示，service_commissions 仍 1 行
 *   4. INVALID_STATE：服务中状态不可确认
 *   5. PERMISSION_DENIED：跨用户拒
 *   6. INVALID_PARAMS：缺 serviceOrderId
 *   7. PHONE_REQUIRED：未绑定手机
 *   8. INVALID_PARAMS：sale_items.store_id ≠ so.store_id 跨店核销禁止
 *   9. INSUFFICIENT_BALANCE：paid_sessions 不足
 *  10. rate 缺失：不阻塞 + service_commissions rate=0 + operation_logs 'rate_missing'
 *  11. 多 service_items：一次 confirm 多 item → 多行 commission
 *  12. 扣完次数（remaining=0）→ 按 sale_item_id 关闭活跃 appt（路径 5，与路径 4 互补）
 *  13. 兼容老参数名 serviceOrderNo
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
  TEST_STORE_ID, TEST_STORE_ID_2, TEST_MANAGER_EMP_ID, TEST_MARKET_ORG_ID,
  pgQuery, getPool,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestClient, createTestStaff, ensureTestStore, ensureTestStore2,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import {
  cleanupClientExtras, createTestClient2, createTestBeautician,
  createTestAppointment,
} from '../helpers/client-fixtures.mjs'

const ROLE_TYPE = '养生师'
const SALES_CAT = '生态合作'

/**
 * 写 commission_rate_matrix 一行（服务单/养生师/生态合作/全 tier）。
 * 用 NS 范围 org_id（finalize SQL 不按 org_id 过滤，但便于清理）。
 */
async function ensureCommissionRule(rate = 0.10) {
  await pgQuery(
    `INSERT INTO commission_rate_matrix
       (org_id, order_type, role_type, sales_category,
        amount_tier_min, amount_tier_max, commission_rate)
     VALUES ($1, '服务单', $2, $3, 0, NULL, $4)
     ON CONFLICT ON CONSTRAINT uq_commission_matrix
       DO UPDATE SET commission_rate = EXCLUDED.commission_rate,
                     amount_tier_max = EXCLUDED.amount_tier_max,
                     updated_at = NOW()`,
    [TEST_MARKET_ORG_ID, ROLE_TYPE, SALES_CAT, rate]
  )
}

/**
 * 把 beautician 的 skills 改成 [ROLE_TYPE]，让 finalize 的 roleType=ROLE_TYPE
 * （finalize 用 skills[0] 兜底 '美容师'）
 */
async function setBeauticianRole(employeeId, role = ROLE_TYPE) {
  await pgQuery(
    `UPDATE staff_wechat_users SET skills = ARRAY[$1]::text[] WHERE employee_id = $2`,
    [role, employeeId]
  )
}

/**
 * 创建一张已支付销售单 + sale_items：
 *   session_count=5, remaining_sessions=5, paid_sessions(可调),
 *   sales_category=SALES_CAT, unit_real_price=200, service_fee=100
 */
async function createCardOrder({
  saleOrderId,
  clientUserId,
  saleItemId,
  storeId = TEST_STORE_ID,
  sessionCount = 5,
  remaining = 5,
  paidSessions = null,
  unitRealPrice = 200,
  serviceFee = 100,
  salesCategory = SALES_CAT,
}) {
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
         sku_id, product_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         session_count, remaining_sessions, paid_sessions,
         sales_category, service_fee, is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '疗程卡'::product_type,
               $5, 1, $5, 1000, 1000,
               $6, $7, $8,
               $9::sales_category, $10, false)`,
      [saleItemId, saleOrderId, storeId, `${NS}_测试商品`,
       unitRealPrice, sessionCount, remaining, paidSessions,
       salesCategory, serviceFee]
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
 * 创建服务单 + 1 个 service_items（默认 '待客户确认'）。
 */
async function createServiceOrder({
  serviceOrderId,
  saleItemId,
  clientUserId,
  employeeId,
  storeId = TEST_STORE_ID,
  status = '待客户确认',
  appointmentId = null,
  sessionUsed = 1,
  unitRealPrice = 200,
}) {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO service_orders (
         service_order_id, status, service_order_type, market_name, store_id,
         service_date, assigned_employee_id, client_user_id, appointment_id,
         started_at
       )
       VALUES ($1, $2::service_order_status, '售前'::service_order_type, $3, $4,
               CURRENT_DATE, $5, $6, $7,
               NOW())`,
      [serviceOrderId, status, `${NS}_市场`, storeId, employeeId, clientUserId, appointmentId]
    )
    const itemId = `${serviceOrderId}_SI`
    await client.query(
      `INSERT INTO service_items (
         service_item_id, sale_item_id, service_order_id,
         session_used, employee_id, service_duration, unit_real_price
       )
       VALUES ($1, $2, $3, $4, $5, 60, $6)`,
      [itemId, saleItemId, serviceOrderId, sessionUsed, employeeId, unitRealPrice]
    )
    await client.query('COMMIT')
    return { serviceItemId: itemId }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 在已有服务单上追加一个 service_items 行（多 item 场景用）。
 */
async function appendServiceItem({
  serviceOrderId, saleItemId, employeeId,
  sessionUsed = 1, unitRealPrice = 200, suffix = 'SI2',
}) {
  const itemId = `${serviceOrderId}_${suffix}`
  await pgQuery(
    `INSERT INTO service_items (
       service_item_id, sale_item_id, service_order_id,
       session_used, employee_id, service_duration, unit_real_price
     )
     VALUES ($1, $2, $3, $4, $5, 60, $6)`,
    [itemId, saleItemId, serviceOrderId, sessionUsed, employeeId, unitRealPrice]
  )
  return { serviceItemId: itemId }
}

// ─────────────── 用例 ───────────────

async function caseConfirmHappy() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_HP`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_HP`
  const { serviceItemId } = await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.status !== '已完成') throw new Error(`expect status=已完成, got ${res.data.status}`)

  const [so] = await pgQuery(
    'SELECT status, completed_at, commission_status FROM service_orders WHERE service_order_id = $1',
    [svcId]
  )
  if (so.status !== '已完成') throw new Error(`db status mismatch: ${so.status}`)
  if (!so.completed_at) throw new Error('expect completed_at set')
  if (so.commission_status !== '已分配') throw new Error(`commission_status: ${so.commission_status}`)

  const [si] = await pgQuery(
    'SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1',
    [saleItemId]
  )
  if (Number(si.remaining_sessions) !== 4) {
    throw new Error(`expect remaining=4, got ${si.remaining_sessions}`)
  }

  // commission: fixed_fee=100 + consume=200×1×0.10=20 → 120
  const commRows = await pgQuery(
    `SELECT employee_id, role_type, commission_amount, fixed_fee, consume_amount, commission_rate
     FROM service_commissions WHERE service_item_id = $1 AND is_void = false`,
    [serviceItemId]
  )
  if (commRows.length !== 1) throw new Error(`expect 1 commission row, got ${commRows.length}`)
  const c = commRows[0]
  if (c.employee_id !== beautician.employeeId) throw new Error(`commission employee mismatch: ${c.employee_id}`)
  if (c.role_type !== ROLE_TYPE) throw new Error(`role_type mismatch: ${c.role_type}`)
  if (Number(c.commission_rate) !== 0.10) throw new Error(`commission_rate: ${c.commission_rate}`)
  if (Number(c.commission_amount) !== 120) throw new Error(`commission_amount: ${c.commission_amount}`)
  if (Number(c.fixed_fee) !== 100) throw new Error(`fixed_fee: ${c.fixed_fee}`)
  if (Number(c.consume_amount) !== 20) throw new Error(`consume_amount: ${c.consume_amount}`)
}

async function caseConfirmClosesAppointment() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_APT`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const apptId = `${NS}_APT_CFM`
  await createTestAppointment({
    appointmentId: apptId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    employeeName: beautician.name,
    saleItemId,
    status: '已确认',
  })

  const svcId = `${NS}_SVC_APT`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    appointmentId: apptId,
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)

  const [appt] = await pgQuery('SELECT status FROM appointments WHERE appointment_id = $1', [apptId])
  if (appt.status !== '已完成') throw new Error(`expect appointment=已完成, got ${appt.status}`)
}

async function caseConfirmIdempotent() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_IDEM`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_IDEM`
  const { serviceItemId } = await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })

  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (r1.code !== 0) throw new Error(`first confirm failed: ${r1.message}`)

  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (r2.code !== 0) throw new Error(`second confirm got code ${r2.code}: ${r2.message}`)
  if (!/幂等/.test(r2.data.message || '')) {
    throw new Error(`expect message 含 '幂等', got "${r2.data.message}"`)
  }

  const [si] = await pgQuery('SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1', [saleItemId])
  if (Number(si.remaining_sessions) !== 4) throw new Error(`expect remaining=4 (扣次仅1次), got ${si.remaining_sessions}`)

  const commRows = await pgQuery(
    `SELECT id FROM service_commissions WHERE service_item_id = $1 AND is_void = false`,
    [serviceItemId]
  )
  if (commRows.length !== 1) throw new Error(`expect 1 commission row, got ${commRows.length}`)
}

async function caseConfirmInvalidState() {
  await ensureTestStore()
  await createTestStaff()
  const beautician = await createTestBeautician()
  await createTestClient()

  const saleOrderId = `${NS}_ST`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_ST`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    status: '服务中',
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code === 0) throw new Error('expect non-zero (INVALID_STATE)')
  if (!/INVALID_STATE|当前状态不可确认/.test(res.message || '')) {
    throw new Error(`expect INVALID_STATE, got "${res.message}"`)
  }
}

async function caseConfirmCrossUser() {
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
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code === 0) throw new Error('expect non-zero (PERMISSION_DENIED)')
  if (!/PERMISSION_DENIED|无权确认/.test(res.message || '')) {
    throw new Error(`expect PERMISSION_DENIED, got "${res.message}"`)
  }
}

async function caseConfirmMissingParam() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', {})
  if (res.code === 0) throw new Error('expect non-zero (INVALID_PARAMS)')
  if (!/INVALID_PARAMS|缺少 serviceOrderId/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS, got "${res.message}"`)
  }
}

async function caseConfirmPhoneRequired() {
  // auth 中间件有 60s 内存缓存：前序 case 已用 TEST_CLIENT_OPENID 缓存了 phone=有值，
  // 此 case 用全新 openid 避开缓存命中
  await ensureTestStore()
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

  const res = await invokeAs(noPhoneOpenid, 'service.confirm', { serviceOrderId: 'whatever' })
  if (res.code === 0) throw new Error('expect non-zero (PHONE_REQUIRED)')
  if (!/PHONE_REQUIRED|请先绑定手机号/.test(res.message || '')) {
    throw new Error(`expect PHONE_REQUIRED, got "${res.message}"`)
  }
}

async function caseConfirmCrossStoreBlocked() {
  await ensureTestStore()
  await ensureTestStore2()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  // sale_items 落在 STORE_ID（默认），service_orders 落在 STORE_ID_2
  const saleOrderId = `${NS}_CSB`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({
    saleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    saleItemId,
    storeId: TEST_STORE_ID,
  })

  const svcId = `${NS}_SVC_CSB`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    storeId: TEST_STORE_ID_2,   // 跨店核销
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code === 0) throw new Error('expect non-zero (cross-store INVALID_PARAMS)')
  if (!/INVALID_PARAMS|仅在.*可核销/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS 跨店, got "${res.message}"`)
  }
}

async function caseConfirmInsufficientPaid() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_IP`
  const saleItemId = `${saleOrderId}_I1`
  // paid_sessions=0 → finalize 限额条件 (5-5+1)=1 <= 0 → 不扣
  await createCardOrder({
    saleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    saleItemId,
    sessionCount: 5,
    remaining: 5,
    paidSessions: 0,
  })

  const svcId = `${NS}_SVC_IP`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code === 0) throw new Error('expect non-zero (INSUFFICIENT_BALANCE)')
  if (!/INSUFFICIENT_BALANCE|已支付次数不足/.test(res.message || '')) {
    throw new Error(`expect INSUFFICIENT_BALANCE, got "${res.message}"`)
  }
}

async function caseConfirmRateMissing() {
  await ensureTestStore()
  await createTestStaff()
  // 不调 ensureCommissionRule
  // 同时清掉历史 NS 测试残留 rule（如果上一次跑遗留），保证当前 case 真的"无规则命中"
  await pgQuery(
    `DELETE FROM commission_rate_matrix
     WHERE order_type='服务单' AND role_type=$1 AND sales_category=$2`,
    [ROLE_TYPE, SALES_CAT]
  )
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_RM`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_RM`
  const { serviceItemId } = await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`expect code=0 (rate_missing 不阻塞), got: ${res.message}`)

  // service_commissions 仍 INSERT：rate=0, fixed_fee=100, consume=0, commission=100
  const [c] = await pgQuery(
    `SELECT commission_rate, commission_amount, fixed_fee, consume_amount
     FROM service_commissions WHERE service_item_id = $1`,
    [serviceItemId]
  )
  if (!c) throw new Error('expect commission row even when rate missing')
  if (Number(c.commission_rate) !== 0) throw new Error(`expect rate=0, got ${c.commission_rate}`)
  if (Number(c.consume_amount) !== 0) throw new Error(`expect consume=0, got ${c.consume_amount}`)
  if (Number(c.fixed_fee) !== 100) throw new Error(`expect fixed_fee=100, got ${c.fixed_fee}`)
  if (Number(c.commission_amount) !== 100) throw new Error(`expect commission=100, got ${c.commission_amount}`)

  // operation_logs 多 1 行 action='service.confirm.rate_missing'
  const logs = await pgQuery(
    `SELECT id, source FROM operation_logs
     WHERE action = 'service.confirm.rate_missing' AND target_id = $1`,
    [serviceItemId]
  )
  if (logs.length !== 1) throw new Error(`expect 1 rate_missing log, got ${logs.length}`)
  if (logs[0].source !== 'clientApi') throw new Error(`expect source=clientApi, got ${logs[0].source}`)
}

async function caseConfirmMultiItems() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  // 一张服务单含 2 个 service_items，引用不同 sale_items（两张卡）
  const saleOrderA = `${NS}_MA`
  const saleItemA = `${saleOrderA}_I1`
  await createCardOrder({ saleOrderId: saleOrderA, clientUserId: TEST_CLIENT_USER_ID, saleItemId: saleItemA })

  const saleOrderB = `${NS}_MB`
  const saleItemB = `${saleOrderB}_I1`
  await createCardOrder({ saleOrderId: saleOrderB, clientUserId: TEST_CLIENT_USER_ID, saleItemId: saleItemB })

  const svcId = `${NS}_SVC_M`
  const { serviceItemId: si1 } = await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId: saleItemA,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })
  const { serviceItemId: si2 } = await appendServiceItem({
    serviceOrderId: svcId,
    saleItemId: saleItemB,
    employeeId: beautician.employeeId,
    suffix: 'SI2',
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`confirm failed: ${res.message}`)

  const commRows = await pgQuery(
    `SELECT service_item_id, commission_amount FROM service_commissions
     WHERE service_item_id IN ($1, $2) AND is_void = false`,
    [si1, si2]
  )
  if (commRows.length !== 2) throw new Error(`expect 2 commission rows, got ${commRows.length}`)
  for (const c of commRows) {
    if (Number(c.commission_amount) !== 120) {
      throw new Error(`expect each commission=120, got ${c.commission_amount} (${c.service_item_id})`)
    }
  }
}

async function caseConfirmExhaustClosesAppointment() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  // 1 次卡：session_count=1, remaining=1, paid=1
  const saleOrderId = `${NS}_EXH`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({
    saleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    saleItemId,
    sessionCount: 1,
    remaining: 1,
    paidSessions: 1,
  })

  // 活跃 appointment 绑 sale_item_id，但 service_orders.appointment_id 留空（独立路径）
  const apptId = `${NS}_APT_EXH`
  await createTestAppointment({
    appointmentId: apptId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    employeeName: beautician.name,
    saleItemId,
    status: '已确认',
  })

  const svcId = `${NS}_SVC_EXH`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
    appointmentId: null,  // 走 sale_item_id 路径而非 appointment_id 路径
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`confirm failed: ${res.message}`)

  // remaining=0
  const [si] = await pgQuery('SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1', [saleItemId])
  if (Number(si.remaining_sessions) !== 0) throw new Error(`expect remaining=0, got ${si.remaining_sessions}`)

  // appointment 关闭（路径 5：按 sale_item_id 索引）
  const [appt] = await pgQuery('SELECT status FROM appointments WHERE appointment_id = $1', [apptId])
  if (appt.status !== '已关闭') throw new Error(`expect appointment='已关闭', got ${appt.status}`)
}

async function caseConfirmAcceptsServiceOrderNo() {
  await ensureTestStore()
  await createTestStaff()
  await ensureCommissionRule(0.10)
  const beautician = await createTestBeautician()
  await setBeauticianRole(beautician.employeeId)
  await createTestClient()

  const saleOrderId = `${NS}_SON`
  const saleItemId = `${saleOrderId}_I1`
  await createCardOrder({ saleOrderId, clientUserId: TEST_CLIENT_USER_ID, saleItemId })

  const svcId = `${NS}_SVC_SON`
  await createServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT_USER_ID,
    employeeId: beautician.employeeId,
  })

  // 用老参数名 serviceOrderNo
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.confirm', { serviceOrderNo: svcId })
  if (res.code !== 0) throw new Error(`expect code=0 (serviceOrderNo 兼容), got: ${res.message}`)
  if (res.data.status !== '已完成') throw new Error(`expect 已完成, got ${res.data.status}`)
}

const CASES = [
  ['happy → 已完成 + 扣次 + 提成 120', caseConfirmHappy],
  ['关联预约（appointment_id 路径）→ closed', caseConfirmClosesAppointment],
  ['幂等：再次确认返回幂等提示', caseConfirmIdempotent],
  ['服务中状态 → INVALID_STATE', caseConfirmInvalidState],
  ['跨用户 → PERMISSION_DENIED', caseConfirmCrossUser],
  ['缺参 → INVALID_PARAMS', caseConfirmMissingParam],
  ['未绑定手机号 → PHONE_REQUIRED', caseConfirmPhoneRequired],
  ['跨店核销禁止 → INVALID_PARAMS', caseConfirmCrossStoreBlocked],
  ['paid_sessions=0 → INSUFFICIENT_BALANCE', caseConfirmInsufficientPaid],
  ['rate 缺失 → 不阻塞 + commission=fixed_fee + 写日志', caseConfirmRateMissing],
  ['多 service_items → 多行 commission', caseConfirmMultiItems],
  ['扣完次数 → 按 sale_item_id 关闭活跃 appt', caseConfirmExhaustClosesAppointment],
  ['兼容老参数 serviceOrderNo', caseConfirmAcceptsServiceOrderNo],
]

async function cleanupCommissionArtifacts() {
  const like = `${NS}%`
  const stmts = [
    [`DELETE FROM service_commissions WHERE service_item_id LIKE $1`, [like]],
    [`DELETE FROM service_reviews WHERE service_order_id LIKE $1`, [like]],
    [
      `DELETE FROM operation_logs
       WHERE action LIKE 'service.confirm.%' AND (target_id LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM commission_rate_matrix
       WHERE org_id LIKE $1 OR (role_type=$2 AND sales_category=$3)`,
      [like, ROLE_TYPE, SALES_CAT],
    ],
  ]
  for (const [sql, params] of stmts) {
    try { await pgQuery(sql, params) } catch { /* noop */ }
  }
}

let pass = 0, fail = 0
console.log(`[service/confirm.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupCommissionArtifacts()
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
  await cleanupCommissionArtifacts()
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[service/confirm.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
