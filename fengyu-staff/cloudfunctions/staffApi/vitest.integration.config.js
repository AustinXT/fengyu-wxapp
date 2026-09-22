import { defineConfig } from 'vitest/config'

/**
 * 集成测试专用配置（`npm run test:int`）。
 *
 * `__tests__/integration/` 下的 `.int.test.js` 用**真实** `pg.Client` 直连 dev 库
 * （默认 `101.34.242.103:5433`），跟其余 2300 条纯 mock 单测的性质完全不同：
 * 需要网络、需要库里的数据形态、会开事务写入。
 *
 * 它们曾被默认的 `vitest run` 一并跑掉 —— 默认 include 是「__tests__ 下所有
 * .test.js」，而 `.int.test.js` 也匹配。后果有两层：
 * - CI runner 连不上那台库 → 整个 job 红，而红的原因跟被测改动毫无关系
 * - 连得上时又会在**共享的** dev 库上写入，结果受远端数据与并发会话影响
 *
 * 所以默认配置里排除它们，只在显式跑本配置时执行。
 * 这个切分由 `__tests__/utils/image-cross-copy.test.js` 的 meta-guard 间接守住：
 * 它要求 CI 跑的是不带路径参数的 `npx vitest run`，也就是默认配置。
 */
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['__tests__/setup.js'],
    include: ['__tests__/integration/**/*.test.js'],
    testTimeout: 30000,
  },
})
