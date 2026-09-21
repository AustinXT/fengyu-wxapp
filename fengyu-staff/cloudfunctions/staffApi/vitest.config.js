import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['__tests__/setup.js'],
    include: ['__tests__/**/*.test.js'],
    // `__tests__/integration/*.int.test.js` 用真实 pg.Client 直连 dev 库，
    // 却也匹配上面的 include。默认跑全量时把它们带上会让 CI（连不到那台库）必红，
    // 连得上时又在共享库上写入。改走 `npm run test:int` / vitest.integration.config.js。
    exclude: [...configDefaults.exclude, '__tests__/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['routes/**/*.js', 'middleware/**/*.js', 'index.js'],
      thresholds: {
        branches: 35,
        functions: 40,
        lines: 48,
      },
    },
  },
})
