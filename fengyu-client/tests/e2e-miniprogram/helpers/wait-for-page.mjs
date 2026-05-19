// helpers/wait-for-page.mjs — 轮询等待小程序页面 path / data 满足条件
//
// 用法：
//   import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'
//
//   await mp.navigateTo('/pagesShop/shop/shop')
//   const page = await waitForPagePath(mp, 'pagesShop/shop')
//   await waitForData(mp, p => Array.isArray(p?.spuList), { name: 'spuList 加载完' })
//
// 设计：替代固定 `setTimeout` 等待，缩短稳态等待时间 + 提升不稳网络下的鲁棒性。

/**
 * 轮询替代固定 setTimeout — 等到当前页 path 包含期望子串
 *
 * @param {import('miniprogram-automator').MiniProgram} mp
 * @param {string} pathSubstr 期望的子串（不必含前缀 /）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.intervalMs=200]
 * @returns {Promise<import('miniprogram-automator').Page>} 当前页对象
 */
export async function waitForPagePath(mp, pathSubstr, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const start = Date.now()
  let lastPath = null
  while (Date.now() - start < timeoutMs) {
    try {
      const page = await mp.currentPage()
      lastPath = page?.path ?? null
      if (lastPath && lastPath.includes(pathSubstr)) return page
    } catch (e) {
      // ignore transient errors during navigation
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(
    `waitForPagePath timeout (>${timeoutMs}ms) waiting for path "${pathSubstr}"; last seen path=${lastPath}`
  )
}

/**
 * 等到当前页 data 满足 predicate
 *
 * @param {import('miniprogram-automator').MiniProgram} mp
 * @param {(data: any) => boolean} predicate
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.intervalMs=200]
 * @param {string} [opts.name='data'] 仅用于错误信息
 * @returns {Promise<any>} 满足条件时的 data 快照
 */
export async function waitForData(mp, predicate, { timeoutMs = 5000, intervalMs = 200, name = 'data' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const page = await mp.currentPage()
      const data = page ? await page.data() : null
      if (predicate(data)) return data
    } catch (e) {
      // ignore transient errors (currentPage during nav transition)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`waitForData timeout (>${timeoutMs}ms) for ${name}`)
}
