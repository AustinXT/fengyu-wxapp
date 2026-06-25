import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e-pages',
  // 详情用例夹具工厂：globalSetup 建「有欠款订单 + 待审批退款单」并把 id 写临时文件，
  // 让 refunds/orders-repayment 详情用例进常规 CI（不再因缺 E2E_*_ID 种子而跳过）。
  globalSetup: './tests/e2e-pages/global-setup.ts',
  globalTeardown: './tests/e2e-pages/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  timeout: 60000,
  reporter: process.env.CI ? [['html'], ['github']] : [['html']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 45000,
    actionTimeout: 15000,
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    // dev server 子进程继承本进程环境变量（含 E2E_DATABASE_URL），经 src/db/index.ts 连独立测试库。
    command: 'bun run dev',
    // url 与 baseURL 对齐（支持 worktree/独立端口跑，避免硬编码 3000 与 POR=3010 的 worktree 起冲突挂起）。
    url: process.env.BASE_URL || 'http://localhost:3000',
    // 用独立测试库时不复用现有(可能连开发库的) dev server，强制起继承 E2E_DATABASE_URL 的专用实例。
    reuseExistingServer: !process.env.CI && !process.env.E2E_DATABASE_URL,
  },
})
