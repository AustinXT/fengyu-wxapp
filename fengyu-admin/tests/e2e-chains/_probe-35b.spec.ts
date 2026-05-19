import { test } from '@playwright/test'

test.setTimeout(180_000)

test('probe-customers', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' })
  await page.locator('#phone').waitFor({ state: 'attached', timeout: 60_000 })
  page.on('response', (r) => {
    if (r.url().includes('login') || r.request().method() === 'POST') {
      console.log('  [resp]', r.status(), r.request().method(), r.url())
    }
  })
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139000', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForTimeout(15_000)
  console.log('AFTER click url=', page.url())
  const errTxt = await page.locator('.text-\\[var\\(--destructive\\)\\]').textContent().catch(() => null)
  console.log('ERR TEXT =', errTxt)
  const toastTxt = await page.locator('[data-sonner-toast]').allTextContents().catch(() => [])
  console.log('TOAST =', toastTxt.join(' | '))
  return

  await page.goto('http://localhost:3000/customers', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  const html = await page.content()
  console.log('HAS "全部市场"=', html.includes('全部市场'))
  console.log('HAS "全部门店"=', html.includes('全部门店'))
  console.log('HAS "顾客管理"=', html.includes('顾客管理'))
  console.log('HAS "新增顾客"=', html.includes('新增顾客'))
  const selectCount = await page.locator('select').count()
  console.log('selects total=', selectCount)
  if (selectCount > 0) {
    for (let i = 0; i < Math.min(selectCount, 6); i++) {
      const opts = await page.locator('select').nth(i).locator('option').allTextContents()
      console.log(`  select[${i}] options=`, JSON.stringify(opts.slice(0, 3)))
    }
  }
})
