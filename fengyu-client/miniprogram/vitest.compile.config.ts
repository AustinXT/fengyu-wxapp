import { defineConfig } from 'vitest/config'

/**
 * wxml 编译校验专用配置（`npm run test:compile`）。
 *
 * `__tests__/compile/` 会解析每个页面 `.json` 里的 `usingComponents`，
 * 确认组件路径可达。Vant 组件解析到 `miniprogram_npm/` —— 那是微信开发者工具
 * 「构建 npm」的产物，已 gitignore，**CI 里永远不存在**（`npm ci` 只产出 node_modules）。
 *
 * 所以它不能进默认的 `vitest run`（那条要能在干净 checkout 上跑），
 * 只在有构建产物的本地环境显式执行。
 * 与 staffApi 把 `__tests__/integration/`（需真实 PG）分出去是同一处理。
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/compile/**/*.test.ts'],
  },
})
