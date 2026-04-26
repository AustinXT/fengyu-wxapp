#!/usr/bin/env node
/**
 * fengyu-client 冒烟脚本（无测试框架，纯 node 跑）
 *
 * 用法：
 *   1. 微信开发者工具 → 设置 → 安全 → 开启服务端口（默认 9420）
 *   2. 打开 fengyu-client 项目，首次需手机号+验证码登录一次（登录态会被保留）
 *   3. node e2e/smoke.js   # 默认尝试 connect 已开的 IDE
 *      LAUNCH=1 node e2e/smoke.js   # 没开 IDE 时由脚本拉起
 *
 * 输出：
 *   - 控制台打印每步 path 与关键 data 字段
 *   - 截图存到 e2e/screenshots/<timestamp>/
 *   - 退出码 0 通过 / 1 失败
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const PROJECT_PATH = path.resolve(__dirname, '..')
const CLI_PATH = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const WS_ENDPOINT = 'ws://localhost:9420'

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const SHOT_DIR = path.join(__dirname, 'screenshots', ts)
fs.mkdirSync(SHOT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const steps = []
async function step(name, fn) {
  process.stdout.write(`▶ ${name} ... `)
  const t0 = Date.now()
  try {
    const result = await fn()
    const ms = Date.now() - t0
    console.log(`ok (${ms}ms)`)
    steps.push({ name, ok: true, ms, result })
    return result
  } catch (err) {
    const ms = Date.now() - t0
    console.log(`FAIL (${ms}ms): ${err.message}`)
    steps.push({ name, ok: false, ms, error: err.message })
    throw err
  }
}

async function shoot(mp, label) {
  const file = path.join(SHOT_DIR, `${label}.png`)
  await mp.screenshot({ path: file })
  console.log(`  📸 ${path.relative(process.cwd(), file)}`)
}

async function main() {
  let mp
  if (process.env.LAUNCH === '1') {
    mp = await step('launch IDE', () =>
      automator.launch({ cliPath: CLI_PATH, projectPath: PROJECT_PATH })
    )
  } else {
    mp = await step(`connect ${WS_ENDPOINT}`, () =>
      automator.connect({ wsEndpoint: WS_ENDPOINT })
    )
  }

  await sleep(800)

  await step('首页：path 校验', async () => {
    const page = await mp.currentPage()
    if (!page.path.includes('pages/home/home')) {
      throw new Error(`expected home, got ${page.path}`)
    }
    await page.waitFor(500)
    const data = await page.data()
    return {
      path: page.path,
      categoriesCount: Array.isArray(data.categories) ? data.categories.length : null,
    }
  })
  await shoot(mp, '01-home')

  await step('Tab 切换 → 预约', async () => {
    await mp.switchTab('/pages/appointment/appointment')
    await sleep(600)
    const page = await mp.currentPage()
    return { path: page.path }
  })
  await shoot(mp, '02-appointment')

  await step('Tab 切换 → 我的', async () => {
    await mp.switchTab('/pages/profile/profile')
    await sleep(600)
    const page = await mp.currentPage()
    const data = await page.data()
    return { path: page.path, hasPhone: !!data.phone, hasUserId: !!data.userId }
  })
  await shoot(mp, '03-profile')

  await step('navigateTo → 商城', async () => {
    await mp.navigateTo('/pagesShop/shop/shop')
    await sleep(1200)
    const page = await mp.currentPage()
    const data = await page.data()
    return {
      path: page.path,
      categoriesCount: Array.isArray(data.categories) ? data.categories.length : null,
    }
  })
  await shoot(mp, '04-shop')

  await step('navigateTo → 我的订单', async () => {
    await mp.navigateBack()
    await sleep(300)
    await mp.switchTab('/pages/profile/profile')
    await sleep(400)
    await mp.navigateTo('/pagesOrder/orders/orders')
    await sleep(1000)
    const page = await mp.currentPage()
    return { path: page.path }
  })
  await shoot(mp, '05-orders')

  await step('断开（保留 IDE 进程）', () => mp.disconnect())
}

main()
  .then(() => {
    console.log(`\n✅ 全部 ${steps.length} 步通过`)
    console.log(`截图目录: ${SHOT_DIR}`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\n❌ 失败: ${err.message}`)
    console.error(`截图目录: ${SHOT_DIR}`)
    const passed = steps.filter((s) => s.ok).length
    console.error(`通过 ${passed}/${steps.length}`)
    process.exit(1)
  })
