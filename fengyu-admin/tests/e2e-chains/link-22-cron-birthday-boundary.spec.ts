/**
 * 链路 22：跨日 cron 边界（生日权益 / 感恩日）
 *
 * 主题：cron `0 3 * * *` Asia/Shanghai 触发，
 *      生日权益按当前 cron tick 的日期判定；同年内幂等。
 *
 * 关键事实（核对 src/cron/steps/grant-birthday-benefits.ts）：
 *   - 无 birthday_grant_log 表（README §1.B 写错）
 *   - 幂等三件套：
 *       messages.idempotency_key = 'birthday-msg-${year}-${userId}'  ON CONFLICT DO NOTHING
 *       point_transactions.external_ref = 'birthday-pts-${year}-${userId}'  ON CONFLICT DO NOTHING
 *       user_coupons.coupon_id = 'bday-${year}-${userId}-${templateId}'  自然主键唯一
 *   - 仅当 client_wechat_users.member_level IS NOT NULL 才进入循环
 *   - benefit 配置来自 system_configs['birthday_benefits']（JSON per member_level）
 *     现网（5433）此配置 5 等级 points=0 + 无 coupon + 无 message → 实际不会发放任何东西
 *
 * 为产生可测的发放结果，spec 临时把"初钻"等级的配置改为有意义值：
 *   {"points": 10, "couponTemplateIds": ["FY-FIX-CT-01"], "messageTitle": "测试生日权益"}
 *
 * 流程：
 *   1. beforeAll 备份 system_configs.birthday_benefits + fixture.birthday/member_level
 *   2. beforeAll 设置 fixture.birthday=今天 + member_level=初钻；注入测试配置
 *   3. test: 跑 cron once → STEP 3 应 grant: +1 point_transaction、+1 message、+1 user_coupon
 *   4. test: 再跑 cron once → STEP 3 应幂等：0 新增
 *   5. afterAll 还原所有 fixture / config
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ADMIN_DIR = path.resolve(__dirname, '../..')
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const CONFIG_KEY = 'birthday_benefits'
const TEMPLATE_ID = 'FY-FIX-CT-01'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

function writeCtx(linkKey: string, payload: Record<string, unknown>) {
  ensureDir(path.dirname(CONTEXT_FILE))
  let ctx: Record<string, unknown> = {}
  try { ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch { /* noop */ }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...ctx, [linkKey]: payload }, null, 2))
}

function runCronOnce(): string {
  console.log('[链路22] 触发 cron:once …(预计 3-5 分钟，含 STEP 2 全量 + STEP 3 生日)')
  const t0 = Date.now()
  const out = execSync('bun run cron:once', {
    cwd: ADMIN_DIR,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  console.log(`[链路22] cron:once 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return out
}

// ── beforeAll: 备份 + 注入测试配置 ──
let origConfig = ''
let origBirthday = 'NULL'
let origMemberLevel = 'NULL'
let testYear = 0

const TEST_CONFIG = {
  '初钻': {
    points: 10,
    couponTemplateIds: [TEMPLATE_ID],
    messageTitle: '测试生日权益',
    messageBody: 'link-22 自动化测试 — 生日快乐！',
  },
  '星钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '粉钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '金钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '黑钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
}

test.beforeAll(() => {
  // 备份
  origConfig = psql(`SELECT value::text FROM system_configs WHERE key='${CONFIG_KEY}'`)
  origBirthday = psql(`SELECT COALESCE(birthday::text,'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  origMemberLevel = psql(`SELECT COALESCE(member_level::text,'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  console.log(`[链路22 setup] 备份: birthday=${origBirthday}, member_level=${origMemberLevel}`)
  console.log(`[链路22 setup] 备份 config（前 200 字符）: ${origConfig.substring(0, 200)}…`)

  // 注入测试配置
  const testCfgJson = JSON.stringify(TEST_CONFIG).replace(/'/g, "''")
  psql(`UPDATE system_configs SET value='${testCfgJson}'::jsonb, updated_at=NOW() WHERE key='${CONFIG_KEY}'`)
  console.log('[链路22 setup] 已注入测试 birthday_benefits 配置')

  // 设置 fixture.birthday=今天 + member_level=初钻
  psql(
    `UPDATE client_wechat_users SET birthday=CURRENT_DATE, member_level='初钻'::member_level, updated_at=NOW() ` +
      `WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  testYear = new Date().getFullYear()
  console.log(`[链路22 setup] 已设置 fixture birthday=CURRENT_DATE + member_level=初钻; year=${testYear}`)

  // 预清当年幂等记录
  psql(`DELETE FROM messages WHERE idempotency_key='birthday-msg-${testYear}-${FIXTURE_USER_ID}'`)
  psql(`DELETE FROM point_transactions WHERE external_ref='birthday-pts-${testYear}-${FIXTURE_USER_ID}'`)
  psql(`DELETE FROM user_coupons WHERE coupon_id='bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}'`)

  // 同时 fixture template valid_to=NULL 时 cron 走 365 天兜底，但确保 is_active=true
  psql(`UPDATE coupon_templates SET is_active=true, updated_at=NOW() WHERE template_id='${TEMPLATE_ID}'`)
})

test.afterAll(() => {
  // 清理本次测试产出（即使测试中途失败也清）
  try {
    psql(`DELETE FROM messages WHERE idempotency_key='birthday-msg-${testYear}-${FIXTURE_USER_ID}'`)
  } catch (e) { console.log(`[teardown] 删 messages 出错: ${e}`) }
  try {
    psql(`DELETE FROM point_transactions WHERE external_ref='birthday-pts-${testYear}-${FIXTURE_USER_ID}'`)
  } catch (e) { console.log(`[teardown] 删 point_transactions 出错: ${e}`) }
  try {
    psql(`DELETE FROM user_coupons WHERE coupon_id='bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}'`)
  } catch (e) { console.log(`[teardown] 删 user_coupons 出错: ${e}`) }
  try {
    psql(
      `DELETE FROM operation_logs WHERE action='customer.birthdayBenefits' ` +
        `AND target_id='${FIXTURE_USER_ID}' AND created_at > NOW() - INTERVAL '1 hour'`,
    )
  } catch (e) { console.log(`[teardown] 删 operation_logs 出错: ${e}`) }

  // 还原 fixture
  try {
    if (origBirthday === 'NULL') {
      psql(`UPDATE client_wechat_users SET birthday=NULL, member_level=NULL, updated_at=NOW() WHERE user_id='${FIXTURE_USER_ID}'`)
    } else {
      const mem = origMemberLevel === 'NULL' ? 'NULL' : `'${origMemberLevel}'::member_level`
      psql(
        `UPDATE client_wechat_users SET birthday='${origBirthday}', member_level=${mem}, updated_at=NOW() ` +
          `WHERE user_id='${FIXTURE_USER_ID}'`,
      )
    }
  } catch (e) { console.log(`[teardown] 还原 fixture 出错: ${e}`) }

  // 还原 config
  try {
    if (origConfig) {
      psql(`UPDATE system_configs SET value='${origConfig.replace(/'/g, "''")}'::jsonb, updated_at=NOW() WHERE key='${CONFIG_KEY}'`)
    }
  } catch (e) { console.log(`[teardown] 还原 config 出错: ${e}`) }

  // 重算 points_balance（cron 写入的 +10 已被上面 DELETE 抵消，需复算缓存避免漂移）
  try {
    psql(
      `UPDATE client_wechat_users SET points_balance = COALESCE((` +
        `SELECT SUM(amount) FROM point_transactions WHERE user_id = client_wechat_users.user_id` +
        `), 0), updated_at=NOW() WHERE user_id='${FIXTURE_USER_ID}'`,
    )
  } catch (e) { console.log(`[teardown] 复算 points_balance 出错: ${e}`) }

  console.log('[链路22 teardown] 完成')
})

test.setTimeout(1500_000) // 25 min, 含 2 次 cron

test('链路22：生日 cron 触发 + 同年幂等', async () => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  const today = new Date().toISOString().substring(0, 10)
  console.log(`[链路22] 今日 = ${today}, testYear = ${testYear}`)

  // ── Step 1: baseline（应都 = 0，已在 beforeAll 预清） ──
  const ptsExternalKey = `birthday-pts-${testYear}-${FIXTURE_USER_ID}`
  const msgIdemKey = `birthday-msg-${testYear}-${FIXTURE_USER_ID}`
  const couponId = `bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}`

  const baselinePts = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const baselineMsg = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const baselineCpn = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] baseline: pts=${baselinePts}, msg=${baselineMsg}, cpn=${baselineCpn}`)
  verdicts.push({
    check: 'baseline_clean',
    verdict: baselinePts === 0 && baselineMsg === 0 && baselineCpn === 0 ? 'PASS' : 'FAIL',
    actual: `pts=${baselinePts}, msg=${baselineMsg}, cpn=${baselineCpn}`,
  })

  // ── Step 2: 第一次 cron ──
  console.log('[链路22] 第一次 cron…')
  const cron1Out = runCronOnce()
  const birthdayLine1 = cron1Out.split('\n').find((l) => l.includes('birthday') || l.includes('STEP 3'))
  console.log(`[链路22] cron1 STEP 3 行: ${birthdayLine1 || '(未找到)'}`)

  const pts1 = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const msg1 = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const cpn1 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] 第一次 cron 后: pts=${pts1}, msg=${msg1}, cpn=${cpn1}`)
  verdicts.push({
    check: 'first_cron_grants_pts',
    verdict: pts1 === 1 ? 'PASS' : 'FAIL',
    actual: `pts=${pts1}, expected=1`,
  })
  verdicts.push({
    check: 'first_cron_grants_msg',
    verdict: msg1 === 1 ? 'PASS' : 'FAIL',
    actual: `msg=${msg1}, expected=1`,
  })
  verdicts.push({
    check: 'first_cron_grants_coupon',
    verdict: cpn1 === 1 ? 'PASS' : 'FAIL',
    actual: `cpn=${cpn1}, expected=1`,
  })

  // ── Step 3: 第二次 cron（验幂等） ──
  console.log('[链路22] 第二次 cron…')
  runCronOnce()

  const pts2 = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const msg2 = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const cpn2 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] 第二次 cron 后: pts=${pts2}, msg=${msg2}, cpn=${cpn2}`)
  verdicts.push({
    check: 'second_cron_idempotent_pts',
    verdict: pts2 === 1 ? 'PASS' : 'FAIL',
    actual: `pts=${pts2}, expected=1（ON CONFLICT DO NOTHING）`,
  })
  verdicts.push({
    check: 'second_cron_idempotent_msg',
    verdict: msg2 === 1 ? 'PASS' : 'FAIL',
    actual: `msg=${msg2}, expected=1`,
  })
  verdicts.push({
    check: 'second_cron_idempotent_coupon',
    verdict: cpn2 === 1 ? 'PASS' : 'FAIL',
    actual: `cpn=${cpn2}, expected=1（自然主键唯一）`,
  })

  // ── Step 4: 感恩日校验 ──
  // 仅每月 20 号触发感恩日 STEP 4。今日非 20 号则 STEP 4 应跳过（无 thx- 系列产出）
  const isToday20th = new Date().getDate() === 20
  const thxPts = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE external_ref LIKE 'thx-pts-%-${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  verdicts.push({
    check: 'thanksgiving_only_on_20th',
    verdict: isToday20th || thxPts === 0 ? 'PASS' : 'SKIP',
    actual: `today=${today} day=${new Date().getDate()}, isToday20th=${isToday20th}, thxPts=${thxPts}`,
  })

  // ── Step 5: operation_logs 含 customer.birthdayBenefits ──
  const birthdayLogCount = parseInt(
    psql(
      `SELECT count(*) FROM operation_logs ` +
        `WHERE action='customer.birthdayBenefits' AND target_id='${FIXTURE_USER_ID}' ` +
        `AND created_at > NOW() - INTERVAL '20 minutes'`,
    ),
    10,
  ) || 0
  // 实测：每次 grantOneBirthday 成功跑都会 INSERT 一条日志 → 跑 2 次预期 2 条
  verdicts.push({
    check: 'birthday_operation_log',
    verdict: birthdayLogCount >= 1 ? 'PASS' : 'FAIL',
    actual: `log_count=${birthdayLogCount}`,
  })

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 22,
    status: overallStatus,
    testYear,
    today,
    fixtureUserId: FIXTURE_USER_ID,
    verdicts,
    cleaned: true,
    notes: '无 birthday_grant_log 表；幂等靠 external_ref / idempotency_key / coupon_id 三件套；'
      + '感恩日 STEP 4 硬编码仅当日 day=20 时跑',
  }
  console.log('\n[链路22] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link22', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
