let miniProgram
let page

beforeAll(async () => {
  miniProgram = global.__miniProgram
  page = await miniProgram.switchTab('/pages/service/service')
  await page.waitFor(2000)
})

describe('护理管理', () => {
  test('显示 Tab 筛选', async () => {
    const tabs = await page.$('.van-tabs')
    expect(tabs).toBeTruthy()
  })

  test('默认显示待服务 Tab', async () => {
    const data = await page.data()
    expect(data.tabActive).toBe('pending')
  })

  test('切换到服务中 Tab', async () => {
    const tab = await page.$('.van-tab:nth-child(2)')
    if (tab) {
      await tab.tap()
      await page.waitFor(1000)
      const data = await page.data()
      expect(data.tabActive).toBe('processing')
    }
  })

  test('创建服务单按钮存在', async () => {
    const btn = await page.$('.add-service-btn')
    expect(btn).toBeTruthy()
  })
})
