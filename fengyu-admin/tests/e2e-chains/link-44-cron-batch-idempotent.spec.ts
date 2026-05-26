/**
 * 链路 44：cron 并发幂等（生日 / 升级批量）
 *
 * 主题：cron STEP 2 (refresh-member-levels) + STEP 3 (grant-birthday-benefits) 在多顾客
 *      同日触发时必须满足：
 *      - messages.idempotency_key UNIQUE 不冲突
 *      - point_transactions.external_ref UNIQUE 不冲突
 *      - user_coupons 按顾客 ON CONFLICT 防御
 *      - 二次触发同一天不重复发放
 *
 * 测试场景：
 *   1. 5 个顾客 (FY-TEST-CRON-01..05) 生日均为今天（seed-scope-fixtures.sql 已 seed）
 *   2. 模拟 cron STEP 3：为每人 INSERT messages + point_transactions + user_coupons
 *      （使用 idempotency_key='bday-{YYYY}-{userId}', external_ref='bday-points-{YYYY}-{userId}'）
 *   3. 二次触发（同样 SQL ON CONFLICT DO NOTHING）→ 行数不增加
 *   4. 验证 user_coupons.coupon_id 不冲突
 *
 * 测试策略：SQL 直接模拟 cron 的 INSERT 模式，验证 UNIQUE 约束 + ON CONFLICT 防御。
 *
 * 关键引用：
 *   - src/cron/steps/grant-birthday-benefits.ts
 *   - messages.uq_messages_idempotency_key
 *   - point_transactions.uq_point_txns_external_ref
 *   - user_coupons.coupon_id PK
 */

import { test, expect } from '@playwright/test'
import {
  CRON_CLIENTS,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const YEAR = new Date().getFullYear()
const TAG = `CHAIN44Y${YEAR}`

function cleanup(): void {
  // 清掉本次模拟的 messages / point_transactions / user_coupons
  for (const userId of CRON_CLIENTS) {
    const idKey = `${TAG}-bday-${YEAR}-${userId}`
    const externalRef = `${TAG}-bday-pts-${YEAR}-${userId}`
    const couponId = `${TAG}-bday-cpn-${YEAR}-${userId}`
    try { psql(`DELETE FROM messages WHERE idempotency_key='${idKey}'`) } catch {/* noop */}
    try { psql(`DELETE FROM point_transactions WHERE external_ref='${externalRef}'`) } catch {/* noop */}
    try { psql(`DELETE FROM user_coupons WHERE coupon_id='${couponId}'`) } catch {/* noop */}
  }
}

/** 模拟 grant-birthday-benefits cron STEP 3 的 INSERT，按 idempotency_key 防御 */
function simulateCronStep3Once(): number {
  // 用前后行数差计算"实际插入数"（RETURNING 在 ON CONFLICT DO NOTHING 路径下行为不直观，
  // 用 COUNT 差分更稳）
  const beforeMsg = parseInt(psql(`SELECT COUNT(*)::text FROM messages WHERE idempotency_key LIKE '${TAG}-bday-${YEAR}-%'`), 10)

  for (const userId of CRON_CLIENTS) {
    const idKey = `${TAG}-bday-${YEAR}-${userId}`
    const externalRef = `${TAG}-bday-pts-${YEAR}-${userId}`
    const couponId = `${TAG}-bday-cpn-${YEAR}-${userId}`

    // messages: 生日祝福
    psql(`
      INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', '${userId}', '生日快乐', '祝您生日快乐~', 'birthday', '${idKey}', NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)

    // point_transactions: 生日积分（不关联订单，ref_order_id=NULL）
    try {
      psql(`
        INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
        VALUES ('${userId}', '获取', 100, NULL, '${externalRef}', NOW())
        ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      `)
    } catch {/* noop */}

    // user_coupons: 生日券（coupon_id PK 防重；expire_at NOT NULL 故必带过期）
    try {
      psql(`
        INSERT INTO user_coupons (
          coupon_id, template_id, user_id, status, expire_at, created_at, updated_at
        ) VALUES (
          '${couponId}', 'FY-FIX-CT-01', '${userId}', '未使用',
          NOW() + interval '10 day', NOW(), NOW()
        )
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    } catch {/* noop */}
  }
  const afterMsg = parseInt(psql(`SELECT COUNT(*)::text FROM messages WHERE idempotency_key LIKE '${TAG}-bday-${YEAR}-%'`), 10)
  return afterMsg - beforeMsg
}

test.setTimeout(120_000)

test('链路44：cron 并发幂等（生日批量）', async () => {
  const verdicts: Verdict[] = []
  cleanup()

  // ── 第一次触发 ──
  console.log('[链路44] 第一次模拟 cron STEP 3')
  const firstInserted = simulateCronStep3Once()
  recordVerdict(verdicts, 'first_run_inserted_5_messages', firstInserted === 5,
    `inserted=${firstInserted}`)

  // 验证 5 行 messages / 5 行 point_transactions / 5 行 user_coupons
  const msgCount1 = parseInt(psql(`
    SELECT COUNT(*)::text FROM messages WHERE idempotency_key LIKE '${TAG}-bday-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'messages_count_5', msgCount1 === 5, `actual=${msgCount1}`)

  const ptCount1 = parseInt(psql(`
    SELECT COUNT(*)::text FROM point_transactions WHERE external_ref LIKE '${TAG}-bday-pts-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'point_transactions_count_5', ptCount1 === 5, `actual=${ptCount1}`)

  const couponCount1 = parseInt(psql(`
    SELECT COUNT(*)::text FROM user_coupons WHERE coupon_id LIKE '${TAG}-bday-cpn-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'user_coupons_count_5', couponCount1 === 5, `actual=${couponCount1}`)

  // ── 第二次触发（同样数据）— 应不增加任何行 ──
  console.log('[链路44] 第二次模拟 cron STEP 3（同一日）')
  const secondInserted = simulateCronStep3Once()
  recordVerdict(verdicts, 'second_run_zero_inserted', secondInserted === 0,
    `inserted=${secondInserted}（应为 0 因 ON CONFLICT DO NOTHING）`)

  const msgCount2 = parseInt(psql(`
    SELECT COUNT(*)::text FROM messages WHERE idempotency_key LIKE '${TAG}-bday-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'messages_count_still_5', msgCount2 === 5, `actual=${msgCount2}`)

  const ptCount2 = parseInt(psql(`
    SELECT COUNT(*)::text FROM point_transactions WHERE external_ref LIKE '${TAG}-bday-pts-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'point_transactions_still_5', ptCount2 === 5, `actual=${ptCount2}`)

  // ── idempotency_key 全部 UNIQUE ──
  const distinctKeys = parseInt(psql(`
    SELECT COUNT(DISTINCT idempotency_key)::text FROM messages WHERE idempotency_key LIKE '${TAG}-bday-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'all_idempotency_keys_distinct', distinctKeys === 5, `distinct=${distinctKeys}`)

  // ── external_ref 全部 UNIQUE ──
  const distinctRefs = parseInt(psql(`
    SELECT COUNT(DISTINCT external_ref)::text FROM point_transactions WHERE external_ref LIKE '${TAG}-bday-pts-${YEAR}-%'
  `), 10)
  recordVerdict(verdicts, 'all_external_refs_distinct', distinctRefs === 5, `distinct=${distinctRefs}`)

  // ── 并发模拟：手工触发两个 INSERT 相同 idempotency_key（应失败）──
  const userId = CRON_CLIENTS[0]
  const dupKey = `${TAG}-bday-${YEAR}-${userId}`
  let dupBlocked = false
  try {
    psql(`
      INSERT INTO messages (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', '${userId}', '生日快乐2', 'dup test', 'birthday', '${dupKey}', NOW())
    `)
    dupBlocked = false
  } catch {
    dupBlocked = true
  }
  recordVerdict(verdicts, 'duplicate_idempotency_key_blocked', dupBlocked,
    `uq_messages_idempotency_key 阻止重复 key`)

  cleanup()

  const overall = summarize(44, verdicts, { client_count: CRON_CLIENTS.length, year: YEAR })
  writeContext('link44', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
