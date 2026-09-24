import { defineConfig, devices } from '@playwright/test'

/**
 * 库存管理 UI 端到端测试配置。
 *
 * 与其他两套 Playwright 配置的区别：
 *   - 顶层 playwright.config.ts    → testDir=tests/e2e-pages，带 webServer（本地起 dev server）
 *   - e2e-chains/playwright.manual → testDir=e2e-chains，localhost 默认
 *   - 本配置                        → 指向**远程已部署的 dev 实例**，无 webServer
 *
 * 串行执行（workers=1 / fullyParallel=false）：链路有状态，inv-02 的总部库存是
 * inv-03 的前置，单据号通过 .last-inventory-context.json 跨 spec 传递。
 * retries=0：库存写入不可回滚（inventory_movements 只追加），重试会造成重复单据。
 */
export default defineConfig({
  testDir: '.',
  testMatch: /inv-\d+-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.ADMIN_BASE_URL || 'http://101.34.242.103:3000',
    trace: 'off',
    screenshot: 'only-on-failure',
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
    headless: process.env.PW_HEADED === '1' ? false : true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
