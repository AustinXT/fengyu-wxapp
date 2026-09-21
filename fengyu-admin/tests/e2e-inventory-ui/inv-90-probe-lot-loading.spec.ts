/**
 * 诊断专用（不属于 INV-xx 场景编号）：单据中心批次下拉「加载库存批次...」是否会永久卡住。
 *
 * 怀疑点 inventory-docs-page.tsx:351-375 的 useEffect：
 *   依赖数组含 loadingLotKeys / lotOptionsByKey，而 effect 内部又 setState 这两个，
 *   形成自循环；effect 重跑时 cleanup 把 cancelled 置 true，导致**首次请求**返回时
 *   then/catch/finally 全部被 `if (!cancelled)` 跳过 —— loadingLotKeys[key] 永远停在
 *   true，select 的 disabled 条件 `isLoadingLots` 永远成立。
 *
 * 跑法：bunx playwright test --config=tests/e2e-inventory-ui/playwright.inventory.config.ts \
 *         tests/e2e-inventory-ui/probe-lot-loading.spec.ts
 */

import { test } from '@playwright/test'
import { BASE, INVT_ACCOUNTS, INVT_PASS, TOPO, login, readCtx } from './_helpers/env'
import { selectContaining } from './_helpers/ui'

test.setTimeout(300_000)

// 诊断专用：默认不进全套（跑一次要 60s 且无断言）。
// 需要复核 BUG-LOT-LOADING 是否已修时，加 INVT_PROBE=1 单独跑。
test.skip(process.env.INVT_PROBE !== '1', '诊断专用，设 INVT_PROBE=1 启用')

test('probe：批次下拉是否永久停留在「加载库存批次...」', async ({ browser }) => {
  const inv01 = readCtx<{ supplySkuName: string }>('inv01')!
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  const actionCalls: Array<{ url: string; status: number }> = []
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/inventory/docs')) {
      actionCalls.push({ url: r.url().slice(-40), status: r.status() })
    }
  })
  page.on('dialog', async (d) => { await d.accept('').catch(() => null) })

  await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)
  await page.goto(`${BASE}/inventory/docs`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /新建/ }).first().click()

  const dialog = page.getByRole('dialog')
  const selects = dialog.locator('select')
  await selects.nth(0).selectOption('分院调货出库')
  await selectContaining(selects.nth(1), `门店 · ${TOPO.STORE_A_NAME}`)
  await selectContaining(selects.nth(2), `门店 · ${TOPO.STORE_B_NAME}`)
  await page.waitForTimeout(500)
  await selectContaining(selects.nth(4), inv01.supplySkuName)

  const lotSel = selects.nth(3)
  // 每 5 秒采样一次，持续 60 秒
  for (const t of [1, 5, 10, 20, 30, 45, 60]) {
    await page.waitForTimeout(t === 1 ? 1000 : 5000)
    const disabled = await lotSel.isDisabled()
    const placeholder = (await lotSel.locator('option').first().textContent())?.trim()
    const optionCount = await lotSel.locator('option').count()
    console.log(`[probe] t≈${t}s  disabled=${disabled}  占位文案="${placeholder}"  option数=${optionCount}`)
    if (!disabled) {
      console.log('[probe] ✅ 批次框最终解除禁用，不是永久卡死')
      break
    }
  }
  console.log('[probe] 期间的 POST 响应:', JSON.stringify(actionCalls))
  await ctx.close()
})
