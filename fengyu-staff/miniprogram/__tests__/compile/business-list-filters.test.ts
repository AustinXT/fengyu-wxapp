import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const PAGES = [
  'packageOrder/order-list/order-list',
  'packageService/appointment/appointment',
  'pages/service/service',
  'packageOrder/allocation-list/allocation-list',
]

describe('业务列表统一筛选与分页', () => {
  test.each(PAGES)('%s 提供搜索、状态下拉和日期范围', (relativePath) => {
    const ts = fs.readFileSync(path.join(ROOT, `${relativePath}.ts`), 'utf8')
    const wxml = fs.readFileSync(path.join(ROOT, `${relativePath}.wxml`), 'utf8')
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, `${relativePath}.json`), 'utf8'))

    expect(wxml).toContain('placeholder="搜索顾客姓名或手机号"')
    expect(wxml).toContain('<van-dropdown-item')
    expect(wxml).toContain('mode="date"')
    expect(ts).toContain('pageSize: 20')
    expect(ts).toMatch(/onReachBottom\(\)/)
    expect(json.usingComponents['van-search']).toBe('@vant/weapp/search/index')
    expect(json.usingComponents['van-dropdown-item']).toBe('@vant/weapp/dropdown-item/index')
  })

  test('服务记录和预约不再使用状态 Tab 或今日快捷项', () => {
    const appointment = fs.readFileSync(path.join(ROOT, 'packageService/appointment/appointment.wxml'), 'utf8')
    const service = fs.readFileSync(path.join(ROOT, 'pages/service/service.wxml'), 'utf8')
    expect(appointment).not.toContain('<van-tabs')
    expect(appointment).not.toContain('今日到店')
    expect(service).not.toContain('<van-tabs')
  })

  test('营业额分配保留业务 Tab，仅状态改为下拉', () => {
    const allocation = fs.readFileSync(path.join(ROOT, 'packageOrder/allocation-list/allocation-list.wxml'), 'utf8')
    expect(allocation).toContain('<van-tabs')
    expect(allocation).toContain('title="销售提成"')
    expect(allocation).toContain('title="服务提成"')
    expect(allocation).not.toContain('status-switch')
  })
})
