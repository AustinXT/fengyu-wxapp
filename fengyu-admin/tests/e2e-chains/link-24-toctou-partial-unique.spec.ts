/**
 * 链路 24：TOCTOU partial UNIQUE 索引并发回归（ticket 2026-05-17 v2）
 *
 * 主题：migration 0029 加了 7 项 partial unique + 2 项 external_ref 幂等键列。
 *      本 spec 用纯 psql 在生产 5434/fengyu_e2e 直接验证 9 个索引的"第二次 INSERT 被拦截"行为，
 *      不走 UI、不走云函数，专注于 DB 层守卫不变量。
 *
 * 9 个被测索引：
 *   uq_sop_first_payment            (sale_order_payments)
 *   uq_so_appointment               (service_orders, appointment_id 维度)
 *   uq_so_client_active             (service_orders, client_user_id 维度)
 *   uq_appt_sale_item_active        (appointments)
 *   uq_store_unbind_pending         (store_unbind_requests)
 *   uq_card_txn_external_ref        (card_transactions.external_ref)
 *   uq_point_txn_order_user_type    (point_transactions)
 *   uq_pickup_idempotency           (pickup_records.idempotency_key)
 *   uq_user_coupons_external_ref    (user_coupons.external_ref)
 *
 * 测试方式：每个索引都
 *   1) INSERT 第一行（应成功）
 *   2) INSERT 第二行同 key（应失败 with code=23505 constraint=该索引名）
 *   3) ON CONFLICT (key) ... DO NOTHING（应静默：rowCount=0）
 *   4) 清理测试数据
 *
 * 数据库：5434/fengyu_e2e（生产业务库；migration 0029 已 apply）
 *
 * 跑法：
 *   bunx playwright test --config=fengyu-admin/tests/e2e-chains/playwright.manual.config.ts \
 *     fengyu-admin/tests/e2e-chains/link-24-toctou-partial-unique.spec.ts
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'

const PG_HOST = '47.113.202.7'
const PG_PORT = '5434'
const PG_DB = 'fengyu_e2e'
const PG_USER = 'fengyu'
const PG_PASS = 'fengyu123'

// 测试 fixture：从生产 5434 取真实 FK 引用（避免 FK 违反）
// 这些是只读引用：测试只创建 sale_orders 等子表行（用 LINK24- 前缀，便于清理）
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'     // client_wechat_users（e2e fixture）
const FIXTURE_STORE_ID = 'store-nc01'          // stores（e2e fixture）
const FIXTURE_STAFF_ID = 'FY-TEST-EMP-MR1'     // staff_wechat_users（e2e fixture）

/** 执行 psql，返回 stdout（去尾空白）；失败抛 Error（含 stderr 第一行） */
function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=${PG_PASS} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_DB} -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${(err.stderr ?? err.message ?? '').split('\n')[0]}`)
  }
}

/** 期望 SQL 抛 23505；返回错误对象 */
function expectUniqueViolation(sql: string, expectedConstraint: string): { ok: boolean; msg: string } {
  try {
    psql(sql)
    return { ok: false, msg: 'second INSERT unexpectedly succeeded' }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('duplicate key value') && msg.includes(expectedConstraint)) {
      return { ok: true, msg }
    }
    return { ok: false, msg }
  }
}

// 通用单条 SQL 容错（清理用，不抛）
function safe(sql: string): void {
  try { psql(sql) } catch { /* noop */ }
}

test.setTimeout(120_000)

test('链路 24：9 个 partial unique 索引并发拦截行为', async () => {
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; detail?: string }> = []

  // ════════════════════════════════════════════════════════════════
  // 1. uq_sop_first_payment — 同销售单同时只能有 1 笔 '首次支付' '已支付'
  // ════════════════════════════════════════════════════════════════
  const tSoid = `LINK24-${Date.now()}-SOP`
  try {
    // 准备：先插入一条 sale_orders（最小列）
    safe(`INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, sale_order_type, status, total_amount, payment_method, received, prepaid_card_amount, refunded_amount, payable_amount, client_user_id) VALUES ('${tSoid}', 'TEST', '${FIXTURE_STORE_ID}', NOW(), '销售单', '已支付', 100, '线下', 100, 0, 0, 100, '${FIXTURE_USER_ID}')`)

    // 第一笔 INSERT
    psql(`INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at) VALUES ('${tSoid}', '首次支付', 50, '线下', '已支付', 'staff', NOW(), NOW())`)
    // 第二笔同维度 INSERT → 应 23505 uq_sop_first_payment
    const r = expectUniqueViolation(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at) VALUES ('${tSoid}', '首次支付', 50, '线下', '已支付', 'staff', NOW(), NOW())`,
      'uq_sop_first_payment',
    )
    verdicts.push({ check: 'uq_sop_first_payment 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })

    // ON CONFLICT DO NOTHING 应静默
    const conflict = psql(`INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at) VALUES ('${tSoid}', '首次支付', 50, '线下', '已支付', 'staff', NOW(), NOW()) ON CONFLICT (sale_order_id) WHERE change_type = '首次支付' AND status = '已支付' DO NOTHING RETURNING id`)
    // psql -At 不抑制状态行；DO NOTHING 命中时输出 "INSERT 0 0"（0 行真正插入）；命中行 RETURNING 输出为空，状态行 "INSERT 0 0" 仍存在
verdicts.push({ check: 'uq_sop_first_payment ON CONFLICT DO NOTHING', verdict: conflict.includes('INSERT 0 0') ? 'PASS' : 'FAIL', detail: `output='${conflict}'` })
  } finally {
    safe(`DELETE FROM sale_order_payments WHERE sale_order_id = '${tSoid}'`)
    safe(`DELETE FROM sale_orders WHERE sale_order_id = '${tSoid}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 2. uq_so_appointment — 同 appointment_id 只能关联 1 张 service_order
  // ════════════════════════════════════════════════════════════════
  const tApptId = `LINK24-${Date.now()}-APPT-A`
  const tSo1 = `LINK24-${Date.now()}-SO1`
  const tSo2 = `LINK24-${Date.now()}-SO2`
  try {
    safe(`INSERT INTO appointments (appointment_id, status, store_id, client_user_id, client_name, employee_id, employee_name, appointment_time) VALUES ('${tApptId}', '已确认', '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', 'TEST', '${FIXTURE_STAFF_ID}', 'TEST', NOW())`)

    psql(`INSERT INTO service_orders (service_order_id, status, service_order_type, market_name, store_id, service_date, assigned_employee_id, appointment_id, client_user_id) VALUES ('${tSo1}', '待服务', '售前', 'TEST', '${FIXTURE_STORE_ID}', CURRENT_DATE, '${FIXTURE_STAFF_ID}', '${tApptId}', '${FIXTURE_USER_ID}')`)
    const r = expectUniqueViolation(
      `INSERT INTO service_orders (service_order_id, status, service_order_type, market_name, store_id, service_date, assigned_employee_id, appointment_id, client_user_id) VALUES ('${tSo2}', '待服务', '售前', 'TEST', '${FIXTURE_STORE_ID}', CURRENT_DATE, '${FIXTURE_STAFF_ID}', '${tApptId}', '${FIXTURE_USER_ID}')`,
      'uq_so_appointment',
    )
    verdicts.push({ check: 'uq_so_appointment 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })
  } finally {
    safe(`DELETE FROM service_orders WHERE service_order_id IN ('${tSo1}', '${tSo2}')`)
    safe(`DELETE FROM appointments WHERE appointment_id = '${tApptId}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 3. uq_so_client_active — 同顾客同时只能有 1 张活跃服务单（待服务/服务中）
  // ════════════════════════════════════════════════════════════════
  const tSoA = `LINK24-${Date.now()}-CLI-A`
  const tSoB = `LINK24-${Date.now()}-CLI-B`
  // 用一个独立测试顾客，避免污染 FIXTURE_USER_ID 状态
  const tCli = `LINK24-CLI-${Date.now()}`
  try {
    safe(`INSERT INTO client_wechat_users (user_id, openid) VALUES ('${tCli}', 'openid-link24-${Date.now()}')`)
    psql(`INSERT INTO service_orders (service_order_id, status, service_order_type, market_name, store_id, service_date, assigned_employee_id, client_user_id) VALUES ('${tSoA}', '待服务', '售前', 'TEST', '${FIXTURE_STORE_ID}', CURRENT_DATE, '${FIXTURE_STAFF_ID}', '${tCli}')`)
    const r = expectUniqueViolation(
      `INSERT INTO service_orders (service_order_id, status, service_order_type, market_name, store_id, service_date, assigned_employee_id, client_user_id) VALUES ('${tSoB}', '服务中', '售前', 'TEST', '${FIXTURE_STORE_ID}', CURRENT_DATE, '${FIXTURE_STAFF_ID}', '${tCli}')`,
      'uq_so_client_active',
    )
    verdicts.push({ check: 'uq_so_client_active 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })

    // 终态行不参与索引：把 A 状态改为 '已完成'，B 应可以插
    psql(`UPDATE service_orders SET status = '已完成', completed_at = NOW() WHERE service_order_id = '${tSoA}'`)
    psql(`INSERT INTO service_orders (service_order_id, status, service_order_type, market_name, store_id, service_date, assigned_employee_id, client_user_id) VALUES ('${tSoB}', '待服务', '售前', 'TEST', '${FIXTURE_STORE_ID}', CURRENT_DATE, '${FIXTURE_STAFF_ID}', '${tCli}')`)
    verdicts.push({ check: 'uq_so_client_active 终态自动释放', verdict: 'PASS', detail: '已完成后第二次 INSERT 成功' })
  } catch (e) {
    verdicts.push({ check: 'uq_so_client_active 终态自动释放', verdict: 'FAIL', detail: (e as Error).message.slice(0, 200) })
  } finally {
    safe(`DELETE FROM service_orders WHERE service_order_id IN ('${tSoA}', '${tSoB}')`)
    safe(`DELETE FROM client_wechat_users WHERE user_id = '${tCli}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 4. uq_appt_sale_item_active — 同 sale_item 同时只能有 1 个活跃预约
  // ════════════════════════════════════════════════════════════════
  // 需要 sale_item，建一个最小订单 + 明细
  const tApptSoid = `LINK24-${Date.now()}-APPT-SO`
  const tApptSiid = `LINK24-${Date.now()}-APPT-SI`
  const tAppt1 = `LINK24-${Date.now()}-APP1`
  const tAppt2 = `LINK24-${Date.now()}-APP2`
  try {
    safe(`INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, sale_order_type, status, total_amount, payment_method, received, prepaid_card_amount, refunded_amount, payable_amount, client_user_id) VALUES ('${tApptSoid}', 'TEST', '${FIXTURE_STORE_ID}', NOW(), '销售单', '已支付', 100, '线下', 100, 0, 0, 100, '${FIXTURE_USER_ID}')`)
    safe(`INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction, product_name, product_type, unit_price, quantity, unit_real_price, sale_amount, received) VALUES ('${tApptSiid}', '${tApptSoid}', '${FIXTURE_STORE_ID}', '购买', 'TEST', '疗程卡', 100, 1, 100, 100, 100)`)

    psql(`INSERT INTO appointments (appointment_id, status, store_id, client_user_id, client_name, employee_id, employee_name, appointment_time, sale_item_id) VALUES ('${tAppt1}', '待确认', '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', 'TEST', '${FIXTURE_STAFF_ID}', 'TEST', NOW(), '${tApptSiid}')`)
    const r = expectUniqueViolation(
      `INSERT INTO appointments (appointment_id, status, store_id, client_user_id, client_name, employee_id, employee_name, appointment_time, sale_item_id) VALUES ('${tAppt2}', '待确认', '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', 'TEST', '${FIXTURE_STAFF_ID}', 'TEST', NOW(), '${tApptSiid}')`,
      'uq_appt_sale_item_active',
    )
    verdicts.push({ check: 'uq_appt_sale_item_active 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })
  } finally {
    safe(`DELETE FROM appointments WHERE appointment_id IN ('${tAppt1}', '${tAppt2}')`)
    safe(`DELETE FROM sale_items WHERE sale_item_id = '${tApptSiid}'`)
    safe(`DELETE FROM sale_orders WHERE sale_order_id = '${tApptSoid}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 5. uq_store_unbind_pending — 同顾客同时只能有 1 条待处理解绑
  // ════════════════════════════════════════════════════════════════
  const tCliUb = `LINK24-UB-${Date.now()}`
  const tReq1 = `LINK24-${Date.now()}-REQ1`
  const tReq2 = `LINK24-${Date.now()}-REQ2`
  try {
    safe(`INSERT INTO client_wechat_users (user_id, openid) VALUES ('${tCliUb}', 'openid-ub-${Date.now()}')`)
    psql(`INSERT INTO store_unbind_requests (request_id, user_id, from_store_id, status) VALUES ('${tReq1}', '${tCliUb}', '${FIXTURE_STORE_ID}', '待处理')`)
    const r = expectUniqueViolation(
      `INSERT INTO store_unbind_requests (request_id, user_id, from_store_id, status) VALUES ('${tReq2}', '${tCliUb}', '${FIXTURE_STORE_ID}', '待处理')`,
      'uq_store_unbind_pending',
    )
    verdicts.push({ check: 'uq_store_unbind_pending 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })
  } finally {
    safe(`DELETE FROM store_unbind_requests WHERE request_id IN ('${tReq1}', '${tReq2}')`)
    safe(`DELETE FROM client_wechat_users WHERE user_id = '${tCliUb}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 6. uq_card_txn_external_ref — external_ref 全局唯一
  // ════════════════════════════════════════════════════════════════
  const tCardId = `LINK24-CARD-${Date.now()}`
  const tExtRef = `link24-ext-${Date.now()}`
  try {
    safe(`INSERT INTO prepaid_cards (card_id, user_id, balance) VALUES ('${tCardId}', '${FIXTURE_USER_ID}', 0) ON CONFLICT (user_id) DO NOTHING`)
    // 取该用户实际的 card_id（ON CONFLICT 时 INSERT 不返回）
    const cardId = psql(`SELECT card_id FROM prepaid_cards WHERE user_id = '${FIXTURE_USER_ID}' LIMIT 1`)
    psql(`INSERT INTO card_transactions (card_id, type, amount, external_ref) VALUES ('${cardId}', '充值', 100, '${tExtRef}')`)
    const r = expectUniqueViolation(
      `INSERT INTO card_transactions (card_id, type, amount, external_ref) VALUES ('${cardId}', '充值', 100, '${tExtRef}')`,
      'uq_card_txn_external_ref',
    )
    verdicts.push({ check: 'uq_card_txn_external_ref 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })

    // ON CONFLICT DO NOTHING 静默
    const conflict = psql(`INSERT INTO card_transactions (card_id, type, amount, external_ref) VALUES ('${cardId}', '充值', 100, '${tExtRef}') ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING RETURNING id`)
    verdicts.push({ check: 'uq_card_txn_external_ref ON CONFLICT 静默', verdict: conflict.includes('INSERT 0 0') ? 'PASS' : 'FAIL', detail: `output='${conflict}'` })
  } finally {
    safe(`DELETE FROM card_transactions WHERE external_ref = '${tExtRef}'`)
    // 不清理 prepaid_cards (FIXTURE_USER_ID 是固定顾客)
  }

  // ════════════════════════════════════════════════════════════════
  // 7. uq_point_txn_order_user_type — 同(user, ref_order, type) 只能 1 行
  // ════════════════════════════════════════════════════════════════
  const tPtSoid = `LINK24-${Date.now()}-PT-SO`
  try {
    safe(`INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, sale_order_type, status, total_amount, payment_method, received, prepaid_card_amount, refunded_amount, payable_amount, client_user_id) VALUES ('${tPtSoid}', 'TEST', '${FIXTURE_STORE_ID}', NOW(), '销售单', '已支付', 100, '线下', 100, 0, 0, 100, '${FIXTURE_USER_ID}')`)
    psql(`INSERT INTO point_transactions (user_id, type, amount, ref_order_id) VALUES ('${FIXTURE_USER_ID}', '消费赠送', 100, '${tPtSoid}')`)
    const r = expectUniqueViolation(
      `INSERT INTO point_transactions (user_id, type, amount, ref_order_id) VALUES ('${FIXTURE_USER_ID}', '消费赠送', 100, '${tPtSoid}')`,
      'uq_point_txn_order_user_type',
    )
    verdicts.push({ check: 'uq_point_txn_order_user_type 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })

    // 不同 type 应可以插（partial 不覆盖其他 type 组合）
    psql(`INSERT INTO point_transactions (user_id, type, amount, ref_order_id) VALUES ('${FIXTURE_USER_ID}', '消费冲销', -100, '${tPtSoid}')`)
    verdicts.push({ check: 'uq_point_txn_order_user_type 不同 type 不冲突', verdict: 'PASS' })
  } catch (e) {
    verdicts.push({ check: 'uq_point_txn_order_user_type 不同 type 不冲突', verdict: 'FAIL', detail: (e as Error).message.slice(0, 200) })
  } finally {
    safe(`DELETE FROM point_transactions WHERE ref_order_id = '${tPtSoid}'`)
    safe(`DELETE FROM sale_orders WHERE sale_order_id = '${tPtSoid}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 8. uq_pickup_idempotency — 同 (sale_item_id, idempotency_key) 只能 1 行
  // ════════════════════════════════════════════════════════════════
  const tPickSoid = `LINK24-${Date.now()}-PK-SO`
  const tPickSiid = `LINK24-${Date.now()}-PK-SI`
  const tIdemKey = `pickup-link24-${Date.now()}`
  try {
    safe(`INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime, sale_order_type, status, total_amount, payment_method, received, prepaid_card_amount, refunded_amount, payable_amount, client_user_id) VALUES ('${tPickSoid}', 'TEST', '${FIXTURE_STORE_ID}', NOW(), '销售单', '已支付', 100, '线下', 100, 0, 0, 100, '${FIXTURE_USER_ID}')`)
    safe(`INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction, product_name, product_type, unit_price, quantity, unit_real_price, sale_amount, received) VALUES ('${tPickSiid}', '${tPickSoid}', '${FIXTURE_STORE_ID}', '购买', 'TEST', '家居产品', 100, 10, 100, 100, 100)`)

    psql(`INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, idempotency_key) VALUES ('${tPickSiid}', 1, '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', '${FIXTURE_STAFF_ID}', '${tIdemKey}')`)
    const r = expectUniqueViolation(
      `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, idempotency_key) VALUES ('${tPickSiid}', 1, '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', '${FIXTURE_STAFF_ID}', '${tIdemKey}')`,
      'uq_pickup_idempotency',
    )
    verdicts.push({ check: 'uq_pickup_idempotency 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })

    // idempotency_key=NULL 时不参与索引：可重复
    psql(`INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, idempotency_key) VALUES ('${tPickSiid}', 1, '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', '${FIXTURE_STAFF_ID}', NULL)`)
    psql(`INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, idempotency_key) VALUES ('${tPickSiid}', 1, '${FIXTURE_STORE_ID}', '${FIXTURE_USER_ID}', '${FIXTURE_STAFF_ID}', NULL)`)
    verdicts.push({ check: 'uq_pickup_idempotency NULL 可重复', verdict: 'PASS' })
  } catch (e) {
    verdicts.push({ check: 'uq_pickup_idempotency NULL 可重复', verdict: 'FAIL', detail: (e as Error).message.slice(0, 200) })
  } finally {
    safe(`DELETE FROM pickup_records WHERE sale_item_id = '${tPickSiid}'`)
    safe(`DELETE FROM sale_items WHERE sale_item_id = '${tPickSiid}'`)
    safe(`DELETE FROM sale_orders WHERE sale_order_id = '${tPickSoid}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 9. uq_user_coupons_external_ref — external_ref 全局唯一
  // ════════════════════════════════════════════════════════════════
  const tTplId = `link24-tpl-${Date.now()}`
  const tCpn1 = `link24-cpn1-${Date.now()}`
  const tCpn2 = `link24-cpn2-${Date.now()}`
  const tCpnExt = `link24-cpn-ext-${Date.now()}`
  try {
    // 最小 coupon_templates 行
    safe(`INSERT INTO coupon_templates (template_id, name, coupon_type, discount_value, min_spend, validity_mode, valid_days) VALUES ('${tTplId}', 'TEST', '现金券', 10, 0, 'days', 30)`)
    const expireAt = new Date(Date.now() + 30 * 86400000).toISOString()
    psql(`INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, external_ref) VALUES ('${tCpn1}', '${tTplId}', '${FIXTURE_USER_ID}', '未使用', '${expireAt}', '${tCpnExt}')`)
    const r = expectUniqueViolation(
      `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at, external_ref) VALUES ('${tCpn2}', '${tTplId}', '${FIXTURE_USER_ID}', '未使用', '${expireAt}', '${tCpnExt}')`,
      'uq_user_coupons_external_ref',
    )
    verdicts.push({ check: 'uq_user_coupons_external_ref 第二次拦截', verdict: r.ok ? 'PASS' : 'FAIL', detail: r.msg.slice(0, 200) })
  } finally {
    safe(`DELETE FROM user_coupons WHERE coupon_id IN ('${tCpn1}', '${tCpn2}')`)
    safe(`DELETE FROM coupon_templates WHERE template_id = '${tTplId}'`)
  }

  // ════════════════════════════════════════════════════════════════
  // 输出汇总
  // ════════════════════════════════════════════════════════════════
  console.log('\n=== 链路 24 验证结果 ===')
  for (const v of verdicts) {
    console.log(`  [${v.verdict}] ${v.check}${v.detail ? ' — ' + v.detail : ''}`)
  }
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')
  console.log(`\n总计: ${verdicts.length} 项，PASS ${verdicts.length - failed.length}，FAIL ${failed.length}`)

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
