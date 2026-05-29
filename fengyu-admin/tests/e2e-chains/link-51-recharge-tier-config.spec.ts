/**
 * 链路 51：充值卡档位配置 `saveRechargeCardConfig` 写入 + 审计 + 权限边界
 *
 * 主题：
 *   1) admin 在 /settings（充值卡 Tab）改档位 → system_configs.recharge.{tiers,minAmount,maxAmount}
 *      三个独立 key 全部 UPSERT
 *   2) admin 同步走 logUpdate → operation_logs `system.saveRechargeConfig`
 *      detail = { _v:3, _t:'update', changes:{ field:{from,to} } }
 *   3) 规范化：金额 round 2 位、tiers 按 faceValue 升序排序（action 内规范化）
 *   4) finance（无 system:config 权限）进 /settings → 页面渲染失败/无访问
 *      （间接验证 system:config 守护：finance 看不到/无法保存）
 *
 * 设计妥协：
 *   - createRechargeOrder 档位命中/越界拒绝在 cards.ts 单元测已覆盖，本 spec 不重复（避免与 admin-coding tests 重叠）
 *   - 仅测 admin 写入与权限边界两个核心不变量
 *   - tier-form dirty flag 复杂：本 spec 仅追加一个新档位（最少 dirty 触发）
 *
 * 复用：scope-helpers.{login,psql,TEST_PHONES} + _helpers/cron-config（backup/restore 3 个 key）
 *
 * 预条件：admin dev server + FY-TEST-ADM/FIN 账号
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { backupAndSetConfig, restoreAllConfigs } from './_helpers/cron-config'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(180_000)

test('链路51：admin 改充值档位 → 3 key 持久化 + 审计 + finance 边界', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // 备份当前 recharge.* 3 个 key（afterAll 还原）
  // 注：backupAndSetConfig 内部 JSON.stringify，传对象/数字即可
  backupAndSetConfig('recharge.tiers', [{ faceValue: 1000, payAmount: 900 }])
  backupAndSetConfig('recharge.minAmount', 100)
  backupAndSetConfig('recharge.maxAmount', 50000)

  try {
    // ── Step 1: admin 登录 → /settings → 切换充值卡 Tab ─────────────
    console.log('[链路51] Step 1: admin 进 /settings 充值卡 Tab')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/settings`)
    await expect(adminPage.getByRole('heading', { name: /系统配置/ })).toBeVisible({ timeout: 15_000 })

    // 切换到"充值卡配置" Tab
    await adminPage.getByRole('tab', { name: /充值卡配置/ }).click()
    await expect(adminPage.getByText(/充值档位|金额边界/).first()).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 修改：追加一个新档位 + 调高 max ──────────────────
    console.log('[链路51] Step 2: 追加档位 2000 → 1700 + max 改 60000')
    // 点"+ 添加档位"
    await adminPage.getByRole('button', { name: /添加档位/ }).click()
    await adminPage.waitForTimeout(300)
    // 新行的 faceValue/payAmount input —— 找新增的那行：第 2 行（原有 1 个）
    const faceInputs = adminPage.locator('input[placeholder="如 1000"]')
    const payInputs = adminPage.locator('input[placeholder="如 900"]')
    await faceInputs.nth(1).fill('2000')
    await payInputs.nth(1).fill('1700')

    // 改 max 从 50000 → 60000
    const maxInput = adminPage.locator('input[placeholder="50000"]').first()
    await maxInput.fill('60000')

    // 保存
    const winStart = psql(`SELECT NOW()::text`)
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/充值卡配置保存成功|保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 3: SQL 验 3 个 key 落库 + 规范化 ─────────────────────
    console.log('[链路51] Step 3: 验 3 key 持久化 + 规范化')
    const tiersStored = psql(`SELECT value FROM system_configs WHERE key = 'recharge.tiers'`)
    const minStored = psql(`SELECT value FROM system_configs WHERE key = 'recharge.minAmount'`)
    const maxStored = psql(`SELECT value FROM system_configs WHERE key = 'recharge.maxAmount'`)
    recordVerdict(verdicts, 'persist: recharge.tiers 已写', Boolean(tiersStored), tiersStored.slice(0, 80))
    recordVerdict(verdicts, 'persist: recharge.minAmount = 100', minStored === '100', minStored)
    recordVerdict(verdicts, 'persist: recharge.maxAmount = 60000', maxStored === '60000', maxStored)

    // tiers 规范化：应按 faceValue 升序 [{1000,900},{2000,1700}]
    let tiers: Array<{ faceValue: number; payAmount: number }> = []
    try {
      tiers = JSON.parse(tiersStored)
    } catch {
      tiers = []
    }
    recordVerdict(verdicts, 'persist: tiers 解析为数组', Array.isArray(tiers), JSON.stringify(tiers).slice(0, 80))
    recordVerdict(verdicts, 'persist: tiers 长度 = 2', tiers.length === 2, String(tiers.length))
    if (tiers.length === 2) {
      recordVerdict(verdicts, 'persist: tiers[0].faceValue=1000', tiers[0].faceValue === 1000, String(tiers[0].faceValue))
      recordVerdict(verdicts, 'persist: tiers[0].payAmount=900', tiers[0].payAmount === 900, String(tiers[0].payAmount))
      recordVerdict(verdicts, 'persist: tiers[1].faceValue=2000', tiers[1].faceValue === 2000, String(tiers[1].faceValue))
      recordVerdict(verdicts, 'persist: tiers[1].payAmount=1700', tiers[1].payAmount === 1700, String(tiers[1].payAmount))
      recordVerdict(
        verdicts,
        'persist: tiers 按 faceValue 升序',
        tiers[0].faceValue <= tiers[1].faceValue,
        `${tiers[0].faceValue}<=${tiers[1].faceValue}`,
      )
    }

    // ── Step 4: 审计 system.saveRechargeConfig + changes 精度 ───
    const audit = readLatestAudit('system.saveRechargeConfig', 'recharge')
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._v=3', audit?.detail?._v === 3, String(audit?.detail?._v))
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes 含 tiers', Boolean(changes?.tiers), changes?.tiers ? 'yes' : 'no')
    recordVerdict(verdicts, 'audit: changes 含 maxAmount (100 → 60000 改了)', Boolean(changes?.maxAmount), changes?.maxAmount ? 'yes' : 'no')
    recordVerdict(
      verdicts,
      'audit: changes.maxAmount.to = 60000',
      changes?.maxAmount?.to === 60000,
      String(changes?.maxAmount?.to),
    )
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()

    // ── Step 5: finance 边界 —— 进 /settings 应渲染失败/异常 ─────
    console.log('[链路51] Step 5: finance 进 /settings → 应失败/无 system:config')
    const finCtx = await browser.newContext()
    const finPage = await finCtx.newPage()
    await login(finPage, TEST_PHONES.FIN)
    const resp = await finPage.goto(`${BASE}/settings`).catch(() => null)
    await finPage.waitForLoadState('networkidle').catch(() => null)
    await finPage.waitForTimeout(800)
    const finBody = (await finPage.locator('body').innerText().catch(() => '')) || ''
    // 期望命中以下任一：HTTP 500、错误页文案、PERMISSION_DENIED 关键字、或 settings UI 元素未渲染
    const httpStatus = resp ? resp.status() : 0
    const hasErrorText = /权限不足|无权|PERMISSION_DENIED|500|出错|系统配置.*出错/.test(finBody)
    const hasSettingsHeading = /系统配置/.test(finBody) && /充值卡配置/.test(finBody) // settings 完整渲染
    const denied = httpStatus >= 500 || hasErrorText || !hasSettingsHeading
    recordVerdict(verdicts, 'finance: 无 system:config 访问被拒（500/错误文案/UI 未渲染 之一）', denied, `status=${httpStatus}, hasErr=${hasErrorText}, hasUI=${hasSettingsHeading}`)
    await finCtx.close()
  } finally {
    restoreAllConfigs()
    summarize(51, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路51 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
