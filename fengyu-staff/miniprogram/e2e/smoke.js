#!/usr/bin/env node
/**
 * fengyu-staff 冒烟脚本（automator 直驱，无测试框架）
 *
 * 用法：
 *   1. 微信开发者工具 → 设置 → 安全 → 开启服务端口（默认 9420）
 *   2. 打开 fengyu-staff/miniprogram 项目，首次需手机号+验证码登录一次
 *   3. node e2e/smoke.js           # 连已开的 IDE
 *      LAUNCH=1 node e2e/smoke.js  # 没开 IDE 时由脚本拉起
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
    console.log(`ok (${Date.now() - t0}ms)`)
    steps.push({ name, ok: true, result })
    return result
  } catch (err) {
    console.log(`FAIL (${Date.now() - t0}ms): ${err.message}`)
    steps.push({ name, ok: false, error: err.message })
    throw err
  }
}

async function shoot(mp, label) {
  const file = path.join(SHOT_DIR, `${label}.png`)
  await mp.screenshot({ path: file })
  console.log(`  📸 ${path.relative(process.cwd(), file)}`)
}

async function assertElement(page, selector, label) {
  const el = await page.$(selector)
  if (!el) throw new Error(`找不到 ${label}（${selector}）`)
  return el
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

  await step('启动页：工作台或登录页', async () => {
    const page = await mp.currentPage()
    const validPaths = ['pages/workbench/workbench', 'pages/login/login']
    if (!validPaths.some((p) => page.path.includes(p))) {
      throw new Error(`意外页面: ${page.path}`)
    }
    return { path: page.path }
  })
  await shoot(mp, '01-launch')

  await step('工作台：reLaunch + 三个区域', async () => {
    const page = await mp.reLaunch('/pages/workbench/workbench')
    await sleep(2000)
    await assertElement(page, '.commission-section', '今日分成')
    await assertElement(page, '.calendar-section', '日历')
    await assertElement(page, '.todo-section', '待办')
    return { path: page.path }
  })
  await shoot(mp, '02-workbench')

  await step('工作台：点击预约待办跳转', async () => {
    const page = await mp.currentPage()
    const link = await page.$('.todo-appointment')
    if (link) {
      await link.tap()
      await sleep(1000)
      const cur = await mp.currentPage()
      if (!cur.path.includes('appointment')) {
        throw new Error(`预期跳转预约页，got ${cur.path}`)
      }
      return { path: cur.path }
    }
    return { skipped: '无预约待办入口' }
  })
  await shoot(mp, '03-workbench-appointment-nav')

  await step('服务页：Tab 筛选 + tabActive=pending', async () => {
    const page = await mp.switchTab('/pages/service/service')
    await sleep(2000)
    await assertElement(page, '.van-tabs', '服务 Tab')
    const data = await page.data()
    if (data.tabActive !== 'pending') {
      throw new Error(`期望 tabActive=pending，got ${data.tabActive}`)
    }
    await assertElement(page, '.add-service-btn', '新建服务单按钮')
    return { tabActive: data.tabActive }
  })
  await shoot(mp, '04-service')

  await step('服务页：切换到服务中 Tab', async () => {
    const page = await mp.currentPage()
    const tab = await page.$('.van-tab:nth-child(2)')
    if (tab) {
      await tab.tap()
      await sleep(1000)
      const data = await page.data()
      if (data.tabActive !== 'processing') {
        throw new Error(`期望 tabActive=processing，got ${data.tabActive}`)
      }
      return { tabActive: data.tabActive }
    }
    return { skipped: '找不到第二个 Tab' }
  })
  await shoot(mp, '05-service-processing')

  await step('顾客列表页：Tab 切换', async () => {
    await mp.switchTab('/pages/customer-list/customer-list')
    await sleep(1000)
    const page = await mp.currentPage()
    return { path: page.path }
  })
  await shoot(mp, '06-customer-list')

  await step('我的页面：Tab 切换', async () => {
    await mp.switchTab('/pages/profile/profile')
    await sleep(600)
    const page = await mp.currentPage()
    const data = await page.data()
    return { path: page.path, hasName: !!data.staffName }
  })
  await shoot(mp, '07-profile')

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
    console.error(`通过 ${steps.filter((s) => s.ok).length}/${steps.length}`)
    process.exit(1)
  })
