let miniProgram
let page

beforeAll(async () => {
  miniProgram = global.__miniProgram
  page = await miniProgram.reLaunch('/pages/workbench/workbench')
  await page.waitFor(2000)
})

describe('工作台', () => {
  test('显示今日分成区域', async () => {
    const section = await page.$('.commission-section')
    expect(section).toBeTruthy()
  })

  test('显示日历区域', async () => {
    const calendar = await page.$('.calendar-section')
    expect(calendar).toBeTruthy()
  })

  test('显示待办事项', async () => {
    const todo = await page.$('.todo-section')
    expect(todo).toBeTruthy()
  })

  test('点击预约跳转', async () => {
    const link = await page.$('.todo-appointment')
    if (link) {
      await link.tap()
      await page.waitFor(1000)
      const current = await miniProgram.currentPage()
      expect(await current.path).toContain('appointment')
    }
  })
})
