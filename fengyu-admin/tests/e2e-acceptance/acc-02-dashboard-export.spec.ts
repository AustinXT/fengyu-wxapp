import { test, expect } from '@playwright/test'

/**
 * #140（工作台实付/退款 KPI 改按归属日期）、#138（数据中心客量板块）、
 * #183（顾客/员工导出补日期列）的 UI 验收。全部只读：不点导出、不触发 export job。
 */

test('#140 工作台三项现金流 KPI 存在且可读', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page.getByText(/今日业绩/).first()).toBeVisible({ timeout: 40_000 })

  const body = await page.locator('main').first().innerText()
  console.log(`[#140] 工作台文本:\n${body.slice(0, 1500)}`)
  // #140 把实付/退款切到 spe.performance_date 后，这组 KPI 仍应渲染出金额而非报错/空白。
  // UI 文案是「今日业绩 + 已扣退款」（不是字面的"实付"），口径切换本身由 dashboard.ts 代码层守护。
  expect(body).toMatch(/今日业绩/)
  expect(body).toMatch(/已扣退款/)
  expect(body).toMatch(/¥[\d,]+/)
})

test('#138 数据中心客量板块可打开', async ({ page }) => {
  await page.goto('/data-center')
  await page.waitForLoadState('domcontentloaded')
  const body = await page.locator('body').innerText()
  console.log(`[#138] 数据中心首屏:\n${body.slice(0, 1200)}`)
  expect(body).not.toContain('An error occurred in the Server Components render')
  // #133：页面上不得出现裸 digest 数字作为错误文案
  expect(body).not.toMatch(/^\s*\d{10,}\s*$/m)
})

test('#183 顾客列表有导出入口且页面无脱敏报错', async ({ page }) => {
  await page.goto('/customers')
  await page.waitForLoadState('domcontentloaded')
  const body = await page.locator('body').innerText()
  console.log(`[#183] 顾客列表首屏:\n${body.slice(0, 800)}`)
  expect(body).not.toContain('An error occurred in the Server Components render')
  await expect(page.getByText(/导出/).first()).toBeVisible({ timeout: 30_000 })
})

test('#183 员工列表有导出入口', async ({ page }) => {
  await page.goto('/employees')
  await page.waitForLoadState('domcontentloaded')
  const body = await page.locator('body').innerText()
  expect(body).not.toContain('An error occurred in the Server Components render')
  await expect(page.getByText(/导出/).first()).toBeVisible({ timeout: 30_000 })
})
