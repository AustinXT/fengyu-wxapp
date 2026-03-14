/**
 * E2E 测试：用户交互
 *
 * 运行：E2E=1 npx vitest run e2e/
 */

const shouldRun = process.env.E2E === '1'
const describeFn = shouldRun ? describe : describe.skip

describeFn('用户交互 E2E', () => {
  let mp

  beforeAll(async () => {
    const { connect } = require('./helpers')
    mp = await connect()
  }, 30000)

  afterAll(async () => {
    const { disconnect } = require('./helpers')
    await disconnect()
  })

  test('首页搜索：输入关键字', async () => {
    await mp.switchTab('/pages/home/home')
    const page = await mp.currentPage()
    await page.waitFor(500)

    // 找到搜索输入框
    const input = await page.$('.search-input')
    if (input) {
      await input.trigger('focus')
      await input.input('护理')
      await page.waitFor(300)

      const data = await page.data()
      expect(data.searchValue).toBe('护理')
    }
  })

  test('商城：切换分类', async () => {
    await mp.navigateTo('/pagesShop/shop/shop')
    const page = await mp.currentPage()
    await page.waitFor(1000)

    const data = await page.data()
    if (data.categories && data.categories.length > 1) {
      // 点击第二个分类
      const sidebar = await page.$('.sidebar-item:nth-child(2)')
      if (sidebar) {
        await sidebar.tap()
        await page.waitFor(500)

        const newData = await page.data()
        expect(newData.activeCategory).toBeDefined()
      }
    }
    await mp.navigateBack()
  })

  test('门店选择：点击门店卡片', async () => {
    await mp.navigateTo('/pagesStore/store-select/store-select')
    const page = await mp.currentPage()
    await page.waitFor(1000)

    const data = await page.data()
    if (data.stores && data.stores.length > 0) {
      // 点击第一个门店
      const storeCard = await page.$('.store-card')
      if (storeCard) {
        await storeCard.tap()
        await page.waitFor(500)

        // 应导航到门店详情
        const currentPage = await mp.currentPage()
        expect(currentPage.path).toContain('store-detail')
        await mp.navigateBack()
      }
    }
    await mp.navigateBack()
  })

  test('我的页面：点击订单入口', async () => {
    await mp.switchTab('/pages/profile/profile')
    const page = await mp.currentPage()
    await page.waitFor(500)

    // 点击我的订单入口
    const orderEntry = await page.$('.order-entry')
    if (orderEntry) {
      await orderEntry.tap()
      await page.waitFor(500)

      const currentPage = await mp.currentPage()
      expect(currentPage.path).toContain('orders')
      await mp.navigateBack()
    }
  })
})
