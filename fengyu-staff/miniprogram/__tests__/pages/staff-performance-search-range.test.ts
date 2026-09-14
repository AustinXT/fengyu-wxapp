/**
 * 绩效页顾客检索 + 时间范围「自定义」（#159）
 *
 * 检索口径：只过滤已 setData 的明细，不查服务器、不额外翻页（2026-09-14 甲方拍板）。
 * 正因为如此，「搜不到」与「还没加载到」必须能被员工区分，否则这个用来核对
 * 「某顾客有没有分配给自己」的功能会直接产出相反的结论 —— 相关断言不是文案洁癖。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

vi.mock('../../utils/role', () => ({
  isManager: () => false,
}))

const testApp = { globalData: { staffWfId: 'staff-1', staffName: '小美' } }
let pageDefinition: Record<string, any>
let originalGetApp: unknown
let originalPage: unknown

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => testApp
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinition = definition
  }
  await import('../../packageOrder/staff-performance/staff-performance')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 14, 10, 0, 0)) // 2026-09-14 本地时间
  ;(globalThis as any).wx.showToast = vi.fn()
})

function createPage() {
  const page: Record<string, any> = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(update: Record<string, unknown>) {
      Object.assign(this.data, update)
    },
  }
  return page
}

function makeItem(customerName: string, clientPhone: string, seq: number) {
  return {
    type: 'sale',
    productName: `商品${seq}`,
    specName: '',
    amount: 10,
    allocAmount: 100,
    customerName,
    clientPhone,
    date: '2026-09-14 10:00:00',
    salesCategory: '自销自耗',
  }
}

/** 返回一页明细；total 用于制造「还有下一页」的场景 */
function mockPage(items: unknown[], total: number) {
  vi.mocked(callStaffApi).mockResolvedValue({
    totalSalesAlloc: 1000,
    totalServiceCommission: 200,
    totalCommission: 1200,
    items,
    total,
  } as never)
}

describe('绩效页 · 顾客检索（前端过滤已加载明细）', () => {
  test('按姓名过滤 displayItems，清空关键词恢复全量', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800005678', 1), makeItem('李四', '13900001234', 2)], 2)
    await page.loadData(true)

    expect(page.data.items).toHaveLength(2)
    expect(page.data.displayItems).toHaveLength(2)
    expect(page.data.filterActive).toBe(false)

    page.onKeywordChange({ detail: '张三' })
    expect(page.data.filterActive).toBe(true)
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    page.onKeywordClear()
    expect(page.data.filterActive).toBe(false)
    expect(page.data.displayItems).toHaveLength(2)
  })

  test('按手机号过滤走原始号，被脱敏遮掉的中间 4 位也能搜到', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13812345678', 1), makeItem('李四', '13900001234', 2)], 2)
    await page.loadData(true)

    // 卡片上展示的是 138****5678，若拿脱敏串去匹配，输入 1234 会命中 0 条
    expect(page.data.items[0].customerPhoneMasked).toBe('138****5678')

    page.onKeywordChange({ detail: '1234' })
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三', '李四'])

    page.onKeywordChange({ detail: '5678' })
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('搜不到时提示带「已加载 N/共 M 条」，不伪装成「该顾客没分配给你」', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 58) // 共 58 条，只加载了 1 条
    await page.loadData(true)

    page.onKeywordChange({ detail: '王五' })
    expect(page.data.displayItems).toHaveLength(0)
    expect(page.data.searchHint).toContain('已加载 1/共 58 条')
    expect(page.data.searchHint).toContain('王五')
    // 还有未加载的页 → wxml 据此渲染「继续加载下一页」按钮
    expect(page.data.hasMore).toBe(true)
  })

  test('命中时也提示顶部汇总仍是全量，避免被当成金额对不上', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 2)
    await page.loadData(true)

    page.onKeywordChange({ detail: '张' })
    expect(page.data.searchHint).toContain('匹配 1 条')
    expect(page.data.searchHint).toContain('顶部汇总为全量')
  })

  test('关键词跨翻页存活：触底取回的新条目立即参与过滤，不需重新输入', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '13900000002', 1)], 2)
    await page.loadData(true)

    page.onKeywordChange({ detail: '张三' })
    expect(page.data.displayItems).toHaveLength(0)

    mockPage([makeItem('张三', '13800000001', 2)], 2)
    await page.loadData(false) // 触底 / 点「继续加载下一页」

    expect(page.data.items).toHaveLength(2)
    expect(page.data.keyword).toBe('张三')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('换时段清空明细时 displayItems 同步清空，不留上一时段的过滤结果', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    page.onKeywordChange({ detail: '张三' })
    expect(page.data.displayItems).toHaveLength(1)

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {})) // 请求挂起，停在清空态
    page.setRange('month')

    expect(page.data.items).toHaveLength(0)
    expect(page.data.displayItems).toHaveLength(0)
    expect(page.data.total).toBe(0)
    expect(page.data.hasMore).toBe(false)
    expect(page.data.keyword).toBe('张三') // 关键词刻意保留：换时段接着查同一个人
  })

  test('搜索不改变顶部汇总（汇总恒全量口径）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 2)
    await page.loadData(true)
    const before = page.data.totalCommission

    page.onKeywordChange({ detail: '张三' })
    expect(page.data.totalCommission).toBe(before)
  })
})

describe('绩效页 · 时间范围「自定义」', () => {
  test('三个范围为 today / month / custom，lastMonth 已下线并回落 today', () => {
    const page = createPage()
    page.onLoad({ range: 'lastMonth' })

    expect(page.data.rangeType).toBe('today')
    expect(page.data.startDate).toBe('2026-09-14')
    expect(page.data.endDate).toBe('2026-09-14')
  })

  test('工作台入口 ?range=month 仍默认本月', () => {
    const page = createPage()
    page.onLoad({ range: 'month' })

    expect(page.data.rangeType).toBe('month')
    expect(page.data.startDate).toBe('2026-09-01')
    expect(page.data.endDate).toBe('2026-09-14')
  })

  test('切到「自定义」沿用切换前的区间作为起点，不出现空区间', () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))

    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(page.data.rangeType).toBe('custom')
    expect(page.data.startDate).toBe('2026-09-01')
    expect(page.data.endDate).toBe('2026-09-14')
    expect(page.data.displayDate).toBe('2026-09-01 ~ 2026-09-14')
  })

  test('deeplink 直接进 custom（data 里还没有日期）回落本月', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    expect(page.data.rangeType).toBe('custom')
    expect(page.data.startDate).toBe('2026-09-01')
    expect(page.data.endDate).toBe('2026-09-14')
  })

  test('选定合法区间 → 刷新明细与汇总，displayDate 显示区间', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    page.onCustomStartChange({ detail: { value: '2026-08-25' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect(page.data.startDate).toBe('2026-08-25')
    expect(page.data.displayDate).toBe('2026-08-25 ~ 2026-09-14')
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({
      startDate: '2026-08-25',
      endDate: '2026-09-14',
    })
  })

  test('开始日期晚于结束日期 → toast 拦截，不发请求且不写坏 data', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    page.onCustomStartChange({ detail: { value: '2026-09-20' } })

    expect((globalThis as any).wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '开始日期不能晚于结束日期' })
    )
    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.startDate).toBe('2026-09-01') // picker 受控，显示回退原值
  })

  test('结束日期早于开始日期 → 同样拦截', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    page.onCustomEndChange({ detail: { value: '2026-08-01' } })

    expect((globalThis as any).wx.showToast).toHaveBeenCalled()
    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.endDate).toBe('2026-09-14')
  })

  test('自定义后切回「今日」恢复预置区间', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))

    page.onCustomStartChange({ detail: { value: '2026-08-25' } })
    expect(page.data.startDate).toBe('2026-08-25')

    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })
    expect(page.data.rangeType).toBe('today')
    expect(page.data.startDate).toBe('2026-09-14')
    expect(page.data.endDate).toBe('2026-09-14')
    expect(page.data.displayDate).toBe('2026-09-14')
  })

  test('选中同一区间不重复请求', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    page.onCustomStartChange({ detail: { value: '2026-09-01' } }) // 与当前一致

    expect(callStaffApi).not.toHaveBeenCalled()
  })
})

describe('绩效页 · 搜不到时的翻页入口', () => {
  test('onLoadMoreTap 在还有下一页时取下一页，加载中不重复触发', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '13900000002', 1)], 40)
    await page.loadData(true)

    expect(page.data.hasMore).toBe(true)
    vi.mocked(callStaffApi).mockClear()

    page.data.loading = true
    page.onLoadMoreTap()
    expect(callStaffApi).not.toHaveBeenCalled()

    page.data.loading = false
    page.onLoadMoreTap()
    expect(callStaffApi).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ page: 2 })
  })

  test('已无下一页时 onLoadMoreTap 不发请求', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '13900000002', 1)], 1)
    await page.loadData(true)

    expect(page.data.hasMore).toBe(false)
    vi.mocked(callStaffApi).mockClear()

    page.onLoadMoreTap()
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})
