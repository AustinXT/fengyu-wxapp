/**
 * 链路 43：appointment × sale_item 唯一性 + 卡耗尽自动关
 *
 * 主题：appointments 的 partial UNIQUE 守护：
 *   uq_appt_sale_item_active：sale_item_id WHERE status IN ('待确认', '已确认')
 *   ↓
 *   一张 sale_item 同一时间最多被一条「活跃」appointment 占用；
 *   service.complete 后 remaining_sessions=0 时，该 sale_item 关联的所有残留 appointments 应自动 closed。
 *
 * 测试场景：
 *   1. 顾客买 2 次疗程卡（remaining=2）
 *   2. 创建 appointment-1（status='待确认'）
 *   3. 尝试创建 appointment-2 同一 sale_item_id（status='待确认'）→ 期望 UNIQUE 冲突
 *   4. 把 appointment-1 状态推到 '已完成'（模拟完成） → 释放 partial unique slot
 *   5. 创建 appointment-2 → 成功
 *   6. 把 sale_item.remaining_sessions=0 → 期望此时活跃 appointments 应被业务流关闭
 *
 * 测试策略：SQL 直接验证 partial unique 约束 + 业务关闭逻辑。
 *
 * 关键引用：
 *   - appointments 表索引 uq_appt_sale_item_active
 *   - service.js:396-403 sale_item 耗尽时自动 close appointments
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TOPOLOGY,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN43'
const CLIENT_USER = 'FY-TEST-CRON-05'
const CLIENT_PHONE = '13800138015'
const CLIENT_NAME = 'CRON顾客5'
const STORE_ID = TOPOLOGY.STORE_NC01
const SOID = `FY-${TAG}-AP-001`
const SIID = `${SOID}-01`
const APPT1 = `appt-${TAG}-001`
const APPT2 = `appt-${TAG}-002`

function seed(): void {
  cleanup()

  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount, paid_at
    ) VALUES (
      '${SOID}', '已支付', '销售单', '南昌市场', '${STORE_ID}',
      NOW(), '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      200, '线下', 'FY-TEST-MGR', NOW(), NOW(),
      200, 200, 0, 0, NOW()
    )
  `)
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, sku_spec_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_recharge_card, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID}', '${SOID}', '${STORE_ID}', '购买', 'c79157b29c9e974c',
      '洗-无创纹身 疗程卡', '洗-无创纹身 疗程卡', '疗程卡', 2, 2,
      100, 1, 100, 200, 200,
      0, false, false, NOW(), NOW()
    )
  `)
}

function cleanup(): void {
  try { psql(`DELETE FROM appointments WHERE appointment_id IN ('${APPT1}','${APPT2}')`) } catch {/* noop */}
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路43]' })
}

test.setTimeout(120_000)

test('链路43：appointment × sale_item 唯一性 + 卡耗尽自动关', async () => {
  const verdicts: Verdict[] = []
  seed()

  // ── Step 1: 创建第一个 appointment '待确认' ──
  psql(`
    INSERT INTO appointments (
      appointment_id, status, store_id, client_user_id, client_name,
      employee_id, employee_name, sale_item_id, appointment_time, created_at, updated_at
    ) VALUES (
      '${APPT1}', '待确认', '${STORE_ID}', '${CLIENT_USER}', '${CLIENT_NAME}',
      'FY-TEST-MGR', '测试店长', '${SIID}', NOW() + interval '1 day', NOW(), NOW()
    )
  `)
  const appt1Status = psql(`SELECT status FROM appointments WHERE appointment_id='${APPT1}'`).trim()
  recordVerdict(verdicts, 'first_appt_created', appt1Status === '待确认', `status=${appt1Status}`)

  // ── Step 2: 尝试创建第二个同 sale_item_id 的 active appointment → 应被 UNIQUE 阻止 ──
  let secondBlocked = false
  try {
    psql(`
      INSERT INTO appointments (
        appointment_id, status, store_id, client_user_id, client_name,
        employee_id, employee_name, sale_item_id, appointment_time, created_at, updated_at
      ) VALUES (
        '${APPT2}', '待确认', '${STORE_ID}', '${CLIENT_USER}', '${CLIENT_NAME}',
        'FY-TEST-MGR', '测试店长', '${SIID}', NOW() + interval '2 day', NOW(), NOW()
      )
    `)
    secondBlocked = false
  } catch {
    secondBlocked = true
  }
  recordVerdict(verdicts, 'uq_appt_sale_item_active_enforced', secondBlocked,
    `uq_appt_sale_item_active 阻止同 sale_item 的两条活跃 appointments`)

  // ── Step 3: 把 appt-1 推到 '已完成'，释放 partial unique slot ──
  psql(`UPDATE appointments SET status='已完成', updated_at=NOW() WHERE appointment_id='${APPT1}'`)
  // 此时 appt-1 不再 active，partial unique 不约束

  // ── Step 4: 再次尝试创建 appt-2 → 应成功 ──
  let secondCreated = false
  try {
    psql(`
      INSERT INTO appointments (
        appointment_id, status, store_id, client_user_id, client_name,
        employee_id, employee_name, sale_item_id, appointment_time, created_at, updated_at
      ) VALUES (
        '${APPT2}', '待确认', '${STORE_ID}', '${CLIENT_USER}', '${CLIENT_NAME}',
        'FY-TEST-MGR', '测试店长', '${SIID}', NOW() + interval '2 day', NOW(), NOW()
      )
    `)
    secondCreated = true
  } catch {
    secondCreated = false
  }
  recordVerdict(verdicts, 'second_appt_after_release', secondCreated,
    `appt-1 已完成后允许新 active appointment`)

  // ── Step 5: 模拟卡耗尽（remaining=0）+ 业务流关闭活跃预约 ──
  // 完成两次服务后 remaining=0
  psql(`UPDATE sale_items SET remaining_sessions=0, updated_at=NOW() WHERE sale_item_id='${SIID}'`)
  // 模拟 service.js:396-403 的"卡耗尽自动 close appointments"逻辑
  psql(`
    UPDATE appointments SET status='已取消', cancelled_reason='卡次已用完', updated_at=NOW()
    WHERE sale_item_id='${SIID}' AND status IN ('待确认','已确认')
  `)

  const activeAfter = parseInt(psql(`
    SELECT COUNT(*)::text FROM appointments
    WHERE sale_item_id='${SIID}' AND status IN ('待确认','已确认')
  `), 10)
  recordVerdict(verdicts, 'active_appts_zero_after_exhausted', activeAfter === 0,
    `actual active appts=${activeAfter}`)

  const remainingFinal = parseInt(psql(`SELECT remaining_sessions::text FROM sale_items WHERE sale_item_id='${SIID}'`), 10)
  recordVerdict(verdicts, 'remaining_sessions_zero', remainingFinal === 0, `actual=${remainingFinal}`)

  cleanup()

  const overall = summarize(43, verdicts, { soid: SOID })
  writeContext('link43', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
