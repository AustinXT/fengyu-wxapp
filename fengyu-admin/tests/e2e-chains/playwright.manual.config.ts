import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    // baseURL 与 scope-helpers 的 BASE（ADMIN_BASE_URL）对齐，支持指向独立端口的 fengyu_e2e dev server；
    // 默认 3000 向后兼容。chains 直连 PG（psql helper）硬编码 fengyu_e2e，故 server 也须连 fengyu_e2e。
    baseURL: process.env.ADMIN_BASE_URL || process.env.BASE_URL || 'http://localhost:3000',
    trace: 'off',
    screenshot: 'off',
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
    headless: process.env.PW_HEADED === '1' ? false : true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
