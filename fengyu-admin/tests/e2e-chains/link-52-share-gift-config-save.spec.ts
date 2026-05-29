/**
 * 链路 52：分享礼配置 `saveShareGiftConfig` 写入 + 审计
 *
 * 主题：
 *   1) admin 在 /member-benefits（分享礼 Tab）改字段 → system_configs.share_gift_config 全量 UPSERT
 *   2) 审计 `system.saveShareGiftConfig` / target_id='share_gift'
 *      detail = { _v:3, _t:'update', changes:{percent:{from,to}} } —— 仅含变更字段（logUpdate diff 精度）
 *
 * 不测：
 *   - 顾客端脱敏读（属 clientApi L2 e2e 范畴）
 *   - finance 拒访问（与 link-51 同模式，去重）
 *
 * 设计要点：仅改 percent 一个数值字段触发 saveShareGiftConfig，验 changes 精度。
 *
 * 预条件：admin dev server + FY-TEST-ADM；/member-benefits 页可达。
 */

import { test, expect } from '@playwright/test'
import { BASE, login, psql, TEST_PHONES, recordVerdict, summarize, type Verdict } from './_helpers/scope-helpers'
import { backupAndSetConfig, restoreAllConfigs } from './_helpers/cron-config'
import { readLatestAudit } from './_helpers/inventory'

test.setTimeout(150_000)

test('链路52：admin 改 share-gift.percent → system_configs 持久化 + audit changes 精度', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // backup share_gift_config 原值 + 设置初始基线（含 percent=0.10）
  const baseline = {
    enabled: false,
    percent: 0.1,
    minFaceValue: 5,
    maxFaceValue: 100,
    validityDays: 90,
    couponTemplateId: '',
    inviterMustHavePaidOrder: false,
    messageInviterTitle: '',
    messageInviterBody: '',
    messageInviteeTitle: '',
    messageInviteeBody: '',
  }
  backupAndSetConfig('share_gift_config', baseline)

  try {
    // ── Step 1: admin 进 /member-benefits → 分享礼 Tab ─────────
    console.log('[链路52] Step 1: admin 进 /member-benefits → 分享礼 Tab')
    const adminCtx = await browser.newContext()
    const adminPage = await adminCtx.newPage()
    adminPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(adminPage, TEST_PHONES.ADM)
    await adminPage.goto(`${BASE}/member-benefits`)
    await expect(adminPage.getByRole('heading', { name: /会员权益/ })).toBeVisible({ timeout: 15_000 })
    await adminPage.getByRole('tab', { name: /分享礼/ }).click()
    await expect(adminPage.getByText(/代金券比例/).first()).toBeVisible({ timeout: 5_000 })

    // ── Step 2: 读当前 percent → 改成 +0.01 后的值（保证一定有变更）──
    const percentLabel = adminPage.locator('label', { hasText: /代金券比例/ })
    const percentInput = percentLabel.locator('xpath=following-sibling::*//input[@type="number"]').first()
    const beforeStr = await percentInput.inputValue()
    const beforeNum = Number(beforeStr || '0.1')
    const newPercent = Math.round((beforeNum + 0.01) * 100) / 100
    console.log(`[链路52] Step 2: percent ${beforeNum} → ${newPercent}`)
    await percentInput.fill(String(newPercent))

    // ── Step 3: 保存 → 看 toast.success ─────────────────────
    await adminPage.getByRole('button', { name: /^保\s*存$/ }).click()
    await expect(adminPage.getByText(/保存成功/)).toBeVisible({ timeout: 15_000 })

    // ── Step 4: SQL 验 system_configs.share_gift_config 全量 ─
    const stored = psql(`SELECT value FROM system_configs WHERE key = 'share_gift_config'`)
    recordVerdict(verdicts, 'persist: share_gift_config 已写', Boolean(stored), stored.slice(0, 80))
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(stored)
    } catch {
      /* keep empty */
    }
    recordVerdict(verdicts, `persist: percent = ${newPercent}`, cfg.percent === newPercent, String(cfg.percent))
    // 9 字段（normalize 后一定包含全部 ShareGiftConfig 字段）
    recordVerdict(verdicts, 'persist: 字段数 >= 9', Object.keys(cfg).length >= 9, String(Object.keys(cfg).length))

    // ── Step 5: 审计 changes 精度（仅 percent 应在 changes）──
    const audit = readLatestAudit('system.saveShareGiftConfig', 'share_gift')
    recordVerdict(verdicts, 'audit: 落库存在', Boolean(audit), audit ? 'present' : 'missing')
    recordVerdict(verdicts, 'audit: detail._v=3', audit?.detail?._v === 3, String(audit?.detail?._v))
    recordVerdict(verdicts, 'audit: detail._t=update', audit?.detail?._t === 'update', String(audit?.detail?._t))
    const changes = audit?.detail?.changes as Record<string, { from: unknown; to: unknown }> | undefined
    recordVerdict(verdicts, 'audit: changes 含 percent', Boolean(changes?.percent), changes?.percent ? 'yes' : 'no')
    recordVerdict(verdicts, `audit: changes.percent.from = ${beforeNum}`, changes?.percent?.from === beforeNum, String(changes?.percent?.from))
    recordVerdict(verdicts, `audit: changes.percent.to = ${newPercent}`, changes?.percent?.to === newPercent, String(changes?.percent?.to))
    recordVerdict(
      verdicts,
      'audit: changes 精度——不应含未改字段（如 minFaceValue/enabled）',
      !changes?.minFaceValue && !changes?.enabled,
      `minFaceValue=${Boolean(changes?.minFaceValue)} enabled=${Boolean(changes?.enabled)}`,
    )
    recordVerdict(verdicts, 'audit: operator = FY-TEST-ADM', audit?.operatorEmployeeId === 'FY-TEST-ADM', audit?.operatorEmployeeId ?? '?')

    await adminCtx.close()
  } finally {
    restoreAllConfigs()
    summarize(52, verdicts)
  }

  const failures = verdicts.filter((v) => v.verdict === 'FAIL')
  expect(failures, `链路52 失败项:\n${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
})
