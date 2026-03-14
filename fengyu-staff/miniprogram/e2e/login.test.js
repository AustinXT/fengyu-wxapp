let miniProgram
let page

beforeAll(() => {
  miniProgram = global.__miniProgram
})

describe('登录流程', () => {
  test('启动后进入工作台或登录页', async () => {
    page = await miniProgram.currentPage()
    const path = await page.path
    expect([
      'pages/workbench/workbench',
      'pages/login/login',
    ]).toContain(path)
  })

  test('页面正确渲染', async () => {
    const element = await page.$('.container')
    expect(element).toBeTruthy()
  })
})
