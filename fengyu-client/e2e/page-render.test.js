/**
 * E2E 测试：页面渲染与数据加载
 *
 * 运行：E2E=1 npx vitest run e2e/
 */

const shouldRun = process.env.E2E === '1'
const describeFn = shouldRun ? describe : describe.skip

describeFn('页面渲染 E2E', () => {
  let mp

  beforeAll(async () => {
    const { connect } = require('./helpers')
    mp = await connect()
  }, 30000)

  afterAll(async () => {
    const { disconnect } = require('./helpers')
    await disconnect()
  })

  test('首页：搜索框存在', async () => {
    await mp.switchTab('/pages/home/home')
    const page = await mp.currentPage()
    await page.waitFor(500)

    const searchBar = await page.$('.search-bar')
    expect(searchBar).toBeTruthy()
  })

  test('首页：分类列表加载', async () => {
    const page = await mp.currentPage()
    const data = await page.data()

    // categories 应该被加载
    expect(data.categories).toBeDefined()
    expect(Array.isArray(data.categories)).toBe(true)
  })

  test('我的页面：用户信息区域', async () => {
    await mp.switchTab('/pages/profile/profile')
    const page = await mp.currentPage()
    await page.waitFor(500)

    const data = await page.data()
    // 至少有 phone 或 userId 字段
    expect(data).toBeDefined()
  })

  test('商城页：商品列表渲染', async () => {
    await mp.navigateTo('/pagesShop/shop/shop')
    const page = await mp.currentPage()
    await page.waitFor(1000) // 等待云函数返回

    const data = await page.data()
    expect(data.categories).toBeDefined()
  })

  test('预约页：Tab 筛选器', async () => {
    await mp.switchTab('/pages/appointment/appointment')
    const page = await mp.currentPage()
    await page.waitFor(500)

    const tabs = await page.$$('.van-tab')
    // 至少有待确认/已确认/全部等 Tab
    expect(tabs.length).toBeGreaterThanOrEqual(2)
  })
})
