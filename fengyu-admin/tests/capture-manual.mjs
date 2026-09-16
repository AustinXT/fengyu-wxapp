// 重拍《客户使用手册》里此前 500 的 7 张业务页截图。
//
// 背景：原截图用 admin 单角色登录、连 5433，admin 当时无业务权限 →
// requirePermission 抛 PERMISSION_DENIED，生产构建脱敏 message 后误显示 500。
// 现 admin 已全开（DEFAULT_PERMISSION_MATRIX.admin = 全部权限）。
//
// 本脚本连本地 admin（应配 DATABASE_URL → 5433 真实业务库），用 admin 账号登录后采集。
//
// 用法（先起服务，再跑）：
//   cd fengyu-admin
//   bun run build && bun run start            # 或 bun run dev（dev 有 React 调试浮层，建议 build+start）
//   ADMIN_PHONE=13900139000 ADMIN_PASS=<密码> bun tests/capture-manual.mjs
//
// 前提：.env.local 的 DATABASE_URL 指向 5433（postgresql://fengyu:***@101.34.242.103:5433/fengyu_wxapp）。

import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3000'
const PHONE = process.env.ADMIN_PHONE
const PASS = process.env.ADMIN_PASS
// 注意：URL.pathname 会把中文百分号编码，必须 decodeURIComponent 还原成「手册」
const OUT = decodeURIComponent(new URL('../../docs/assets/手册', import.meta.url).pathname)

if (!PHONE || !PASS) {
  console.error('!! 请设置 ADMIN_PHONE 和 ADMIN_PASS 环境变量')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

// 仅重拍此前 500 的 7 页（文件名与《客户使用手册.md》引用保持一致）
const PAGES = [
  ['20-订单管理', '/orders'],
  ['21-营业额分配', '/allocations'],
  ['22-服务单管理', '/services'],
  ['23-预约管理', '/appointments'],
  ['25-顾客管理', '/customers'],
  ['26-疗程卡管理', '/cards'],
  ['27-提货记录', '/pickup-records'],
]

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

// ---- 登录 ----
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.getByPlaceholder('请输入手机号').fill(PHONE)
await page.getByPlaceholder('请输入密码').fill(PASS)
await page.locator('button[type=submit]').click()
await page.waitForTimeout(2500)
console.log('LOGIN ->', page.url())
if (page.url().includes('/login')) {
  console.log('!! 登录失败，停止。检查 ADMIN_PHONE/ADMIN_PASS 是否正确（账号需在所连库中存在）。')
  await browser.close()
  process.exit(2)
}

const ok = [], bad = []
for (const [name, route] of PAGES) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(1200)
    // 防回归：若页面仍是「服务异常 / 无权访问」，记为失败，不要覆盖好图
    const body = await page.locator('body').innerText()
    if (body.includes('服务异常') || body.includes('无权访问')) {
      bad.push(`${name}(${body.includes('服务异常') ? '500' : '403'})`)
      console.log('SKIP  ', name, '→ 仍报错，未截图')
      continue
    }
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
    ok.push(name)
    console.log('OK    ', name)
  } catch (e) {
    bad.push(`${name}(err:${e.message.slice(0, 40)})`)
    console.log('ERR   ', name, e.message.slice(0, 60))
  }
}

console.log('\n=== captured:', ok.length, '===', ok.join(' | '))
console.log('=== failed  :', bad.length, '===', bad.join(' | '))
await browser.close()
process.exit(bad.length ? 1 : 0)
