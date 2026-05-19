import { test } from '@playwright/test'
test.setTimeout(60_000)
test('probe-adm-emp-create', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' })
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139000', { delay: 30 }) // ADM
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 })

  // 重新跑一遍 expectDenied 逻辑
  const resp = await page.goto('http://localhost:3000/employees/create').catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
  await page.waitForTimeout(1000)
  console.log('status=', resp?.status())
  const body = (await page.textContent('body').catch(() => '')) || ''
  const re = /无权|无权限|没有权限|403|权限不足|Forbidden/
  const hasDenyText = re.test(body)
  const matches = body.match(new RegExp(re, 'g')) || []
  console.log('hasDenyText=', hasDenyText, ' first match indices=', matches.slice(0, 3))
  const idx = body.search(re)
  console.log('body around match=', JSON.stringify(body.substring(Math.max(0,idx-30), idx+30)))
  const finalPath = new URL(page.url()).pathname
  const expectedPrefix = '/employees/create'.split('?')[0].split('/').slice(0, 3).join('/')
  console.log('finalPath=', finalPath, ' expectedPrefix=', expectedPrefix, ' includes=', finalPath.includes(expectedPrefix))
})
