import { defineConfig, devices } from '@playwright/test'

/**
 * 已关闭 issue 的 UI 验收套件（只读）。
 *
 * 与 playwright.config.ts 的区别，三条都是刻意的：
 *   1. **不起 webServer**、不跑 globalSetup —— 直接打 dev admin（101.34.242.103:3000），
 *      验的是"dev 环境上跑着的那份代码"，顺带回答"改动是否真的发到 dev 了"。
 *   2. **不建任何夹具**：e2e 库在 101.34.242.103 上尚未建（issue #151 遗留），
 *      跑写库套件会落到 dev 业务库上污染真实数据。本套件全程只读。
 *   3. 断言锚定 dev 库里**真实存在的缺陷样本**（部分支付家居行 / 转入家居行 /
 *      paid_sessions=0 疗程卡），因此断言的是"这些行现在看得见"，而不是造数复现。
 */
export default defineConfig({
  testDir: './tests/e2e-acceptance',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.ACC_BASE_URL || 'http://101.34.242.103:3000',
    trace: 'off',
    screenshot: 'only-on-failure',
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/acceptance.json' },
      dependencies: ['setup'],
    },
  ],
})
