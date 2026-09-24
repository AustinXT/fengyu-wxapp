import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    include: ['__tests__/**/*.test.ts'],
    // `__tests__/compile/` 校验 wxml 里 usingComponents 的组件路径可达，
    // 而 Vant 组件解析到 `miniprogram_npm/`——那是微信开发者工具「构建 npm」的产物、
    // 已 gitignore，CI 里**永远不存在**（`npm ci` 只产出 node_modules）。
    // 它天然属于「带构建产物的本地环境」，走 `npm run test:compile`。
    // 与 staffApi 把 `__tests__/integration/**`（需真实 PG）分出去同一处理。
    exclude: [...configDefaults.exclude, '__tests__/compile/**'],
  },
})
