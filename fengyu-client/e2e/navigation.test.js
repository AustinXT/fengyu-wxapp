/**
 * E2E 测试：页面导航与路由
 *
 * 前置条件：
 *   - 微信开发者工具已打开 fengyu-client 项目
 *   - 设置 → 安全设置 → 开启服务端口
 *
 * 运行：E2E=1 npx vitest run e2e/
 * 默认跳过（无开发者工具环境时不报错）
 */

const shouldRun = process.env.E2E === '1'
const describeFn = shouldRun ? describe : describe.skip

describeFn('页面导航 E2E', () => {
  let mp, page

  beforeAll(async () => {
    const { connect } = require('./helpers')
    mp = await connect()
  }, 30000)

  afterAll(async () => {
    const { disconnect } = require('./helpers')
    await disconnect()
  })

  test('首页加载成功', async () => {
    page = await mp.currentPage()
    expect(page.path).toContain('pages/home/home')
  })

  test('Tab 切换 → 预约页', async () => {
    await mp.switchTab('/pages/appointment/appointment')
    page = await mp.currentPage()
    expect(page.path).toContain('pages/appointment/appointment')
  })

  test('Tab 切换 → 我的', async () => {
    await mp.switchTab('/pages/profile/profile')
    page = await mp.currentPage()
    expect(page.path).toContain('pages/profile/profile')
  })

  test('Tab 切换 → 回到首页', async () => {
    await mp.switchTab('/pages/home/home')
    page = await mp.currentPage()
    expect(page.path).toContain('pages/home/home')
  })

  test('navigateTo → 门店选择', async () => {
    await mp.navigateTo('/pagesStore/store-select/store-select')
    page = await mp.currentPage()
    expect(page.path).toContain('pagesStore/store-select/store-select')

    // 返回
    await mp.navigateBack()
    page = await mp.currentPage()
    expect(page.path).toContain('pages/home/home')
  })

  test('navigateTo → 我的订单', async () => {
    await mp.navigateTo('/pagesOrder/orders/orders')
    page = await mp.currentPage()
    expect(page.path).toContain('pagesOrder/orders/orders')
    await mp.navigateBack()
  })

  test('navigateTo → 商城', async () => {
    await mp.navigateTo('/pagesShop/shop/shop')
    page = await mp.currentPage()
    expect(page.path).toContain('pagesShop/shop/shop')
    await mp.navigateBack()
  })
})
