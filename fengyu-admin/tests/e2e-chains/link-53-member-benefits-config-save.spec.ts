/**
 * 链路 53：会员等级权益配置 `saveMemberBenefits` 写入 + 审计
 *
 * 主题：
 *   1) admin 在 /member-benefits（升级 Tab）改某等级（黑钻）的奖励积分 → 触发 memberDirty
 *   2) 保存调用 saveMemberBenefits → 写 3 个独立 key（member_level_benefits / birthday_benefits / thanksgiving_benefits）
 *   3) 审计 `system.saveMemberBenefits` / target_id='member_benefits'
 *      detail = { _v:3, _t:'update', changes:{upgrade:{from,to}} } —— logUpdate diff 精度（仅 upgrade 改了）
 *
 * 与 cron-03 不重复：cron-03 走 backupAndSetConfig 直 SQL 注入配置，绕过 saveMemberBenefits action；
 *                    本 spec 专门守护 action 路径（权限 + 规范化 + 审计）。
 *
 * 设计妥协：UI 表单 5 等级 × 3 场景 = 15 区块过于复杂，本 spec 只在升级 Tab 改黑钻积分一个字段触发 dirty。
 *
 * 预条件：admin dev server + FY-TEST-ADM；/member-benefits 页可达。
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { backupAndSetConfig, restoreAllConfigs } from './_helpers/cron-config'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(150_000)

test('链路53：admin 改 member-benefits.upgrade.黑钻.points → 3 key 持久化 + audit changes 精度', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // backup 3 个 key 原值 + 设置初始基线（黑钻 points=100）
  const baselineUpgrade = {
    初钻: { points: 0, messageTitle: '', messageBody: '', couponTemplateIds: [] },
    星钻: { points: 0, messageTitle: '', messageBody: '', couponTemplateIds: [] },
    粉钻: { points: 0, messageTitle: '', messageBody: '', couponTemplateIds: [] },
    金钻: { points: 0, messageTitle: '', messageBody: '', couponTemplateIds: [] },
    黑钻: { points: 100, messageTitle: '', messageBody: '', couponTemplateIds: [] },
  }
  const baselineBirthday = JSON.parse(JSON.stringify(baselineUpgrade))
  baselineBirthday.黑钻.points = 0
  const baselineThx = JSON.parse(JSON.stringify(baselineUpgrade))
  baselineThx.黑钻.points = 0
  backupAndSetConfig('member_level_benefits', baselineUpgrade)
  backupAndSetConfig('birthday_benefits', baselineBirthday)
  backupAndSetConfig('thanksgiving_benefits', baselineThx)

  try {
    // ── Step 1: admin 进 /member-benefits → 升级 Tab ───────────
    console.log('[链路53] Step 1: admin 进 /member-benefits → 升级 Tab')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/member-benefits`)
    await expect(adminPage.getByRole('heading', { name: /会员权益/ })).toBeVisible({ timeout: 15_000 })
    await adminPage.getByRole('tab', { name: /^升级权益$/ }).click()
    // 期望升级 Tab 内能看到"黑钻"区块
    await expect(adminPage.getByText(/^黑钻$/).first()).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 改黑钻 points 100 → 200 ─────────────────────
    console.log('[链路53] Step 2: 改黑钻 points 100 → 200')
    // 5 等级渲染顺序：初/星/粉/金/黑，每等级 1 个"奖励积分" input → 黑钻是第 5 个 (nth(4))
    const pointsInputs = adminPage.locator('input[type="number"][placeholder="0"]')
    const beforeStr = await pointsInputs.nth(4).inputValue()
    const beforeNum = Number(beforeStr || '0')
    const newPoints = beforeNum + 100
    console.log(`[链路53] Step 2: 黑钻 points ${beforeNum} → ${newPoints}`)
    await pointsInputs.nth(4).fill(String(newPoints))

    // ── Step 3: 保存 → toast.success ─────────────────────────
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 4: SQL 验 3 个 key 都存在（即使未改也会被 saveMemberBenefits 全 UPSERT） ─
    const upgradeStored = psql(`SELECT value FROM system_configs WHERE key = 'member_level_benefits'`)
    const birthdayStored = psql(`SELECT value FROM system_configs WHERE key = 'birthday_benefits'`)
    const thxStored = psql(`SELECT value FROM system_configs WHERE key = 'thanksgiving_benefits'`)
    recordVerdict(verdicts, 'persist: member_level_benefits 写入', Boolean(upgradeStored), upgradeStored.slice(0, 60))
    recordVerdict(verdicts, 'persist: birthday_benefits 写入', Boolean(birthdayStored), birthdayStored.slice(0, 60))
    recordVerdict(verdicts, 'persist: thanksgiving_benefits 写入', Boolean(thxStored), thxStored.slice(0, 60))

    let upgradeMap: Record<string, { points: number }> = {}
    try {
      upgradeMap = JSON.parse(upgradeStored)
    } catch {
      /* empty */
    }
    recordVerdict(verdicts, `persist: upgrade.黑钻.points = ${newPoints}`, upgradeMap['黑钻']?.points === newPoints, String(upgradeMap['黑钻']?.points))

    // ── Step 5: 审计 changes 精度（仅 upgrade 字段应在 changes） ──
    const audit = readLatestAudit('system.saveMemberBenefits', 'member_benefits')
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._v=3', audit?.detail?._v === 3, String(audit?.detail?._v))
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes 含 upgrade', Boolean(changes?.upgrade), changes?.upgrade ? 'yes' : 'no')
    recordVerdict(
      verdicts,
      'audit: changes 不含 birthday/thanksgiving（未改）',
      !changes?.birthday && !changes?.thanksgiving,
      `birthday=${Boolean(changes?.birthday)} thanksgiving=${Boolean(changes?.thanksgiving)}`,
    )
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()
  } finally {
    restoreAllConfigs()
    summarize(53, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路53 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
