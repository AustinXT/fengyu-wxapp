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

/** 输入关键词并推进防抖窗口（过滤延后 SEARCH_DEBOUNCE_MS 生效，见 scheduleFilter） */
function search(page: Record<string, any>, keyword: string) {
  page.onKeywordChange({ detail: keyword })
  vi.advanceTimersByTime(250)
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
    // 未搜索时 displayItems 刻意留空，wxml 走 `filterActive ? displayItems : items`
    expect(page.data.filterActive).toBe(false)
    expect(page.data.displayItems).toHaveLength(0)

    search(page, '张三')
    expect(page.data.filterActive).toBe(true)
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    page.onKeywordClear()
    expect(page.data.filterActive).toBe(false)
    expect(page.data.displayItems).toHaveLength(0) // 回到「渲染 items」模式
    expect(page.data.items).toHaveLength(2)
  })

  test('按手机号过滤走原始号，被脱敏遮掉的中间 4 位也能搜到', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13812345678', 1), makeItem('李四', '13900001234', 2)], 2)
    await page.loadData(true)

    // 卡片上展示的是 138****5678，若拿脱敏串去匹配，输入 1234 会命中 0 条
    expect(page.data.items[0].customerPhoneMasked).toBe('138****5678')

    search(page, '1234')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三', '李四'])

    search(page, '5678')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('搜不到时提示带「已加载 N/共 M 条」，不伪装成「该顾客没分配给你」', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 58) // 共 58 条，只加载了 1 条
    await page.loadData(true)

    search(page, '王五')
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

    search(page, '张')
    expect(page.data.searchHint).toContain('匹配 1 条')
    expect(page.data.searchHint).toContain('顶部汇总为全量')
  })

  test('关键词跨翻页存活：触底取回的新条目立即参与过滤，不需重新输入', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '13900000002', 1)], 2)
    await page.loadData(true)

    search(page, '张三')
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
    search(page, '张三')
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

    search(page, '张三')
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

  test('开始日期晚于结束日期 → toast 拦截，不发请求且不写坏 data', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)
    // 先把结束日期挪到月初，再把开始日期挪到它之后（两端都在 picker 的绝对边界内，
    // 否则会先被 clampDate 钳成合法区间，测不到这条分支）
    page.onCustomEndChange({ detail: { value: '2026-09-05' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())
    vi.mocked(callStaffApi).mockClear()

    page.onCustomStartChange({ detail: { value: '2026-09-10' } })

    expect((globalThis as any).wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '开始日期不能晚于结束日期' })
    )
    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.startDate).toBe('2026-09-01') // picker 受控，显示回退原值
    expect(page.data.endDate).toBe('2026-09-05')
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

// ===== pr-ready 闸门补漏（#159 评审轮次）=====

describe('绩效页 · 搜索态翻页入口（评审补漏 P1）', () => {
  test('命中少量但不足一屏时仍给翻页入口——不能只靠 onReachBottom', async () => {
    const page = createPage()
    page.onLoad({})
    // 40 条里只加载了 1 条，且这 1 条正好命中：页面高度不足一屏，触底事件永远不会来
    mockPage([makeItem('张三', '13800000001', 1)], 40)
    await page.loadData(true)

    search(page, '张三')
    expect(page.data.displayItems).toHaveLength(1)
    expect(page.data.filterActive).toBe(true)
    // wxml 的按钮条件是 filterActive && hasMore —— 与命中条数无关
    expect(page.data.hasMore).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onLoadMoreTap()
    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })
})

describe('绩效页 · 手机号脏数据归一（评审补漏 P2）', () => {
  test('带分隔符/国际前缀的号也能被纯数字关键词搜到', async () => {
    const page = createPage()
    page.onLoad({})
    // sale_orders.client_phone 是 varchar(30) 无格式 CHECK，WorkFine 历史数据里这些写法真实存在
    mockPage([
      makeItem('张三', '138-0013-8000', 1),
      makeItem('李四', '+8613900139000', 2),
      makeItem('王五', '136 0013 6000', 3),
    ], 3)
    await page.loadData(true)

    search(page, '13800138000')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    search(page, '13900139000')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['李四'])

    search(page, '1360013')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['王五'])
  })

  test('纯文字关键词不会因为剥数字而误命中所有人', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 2)
    await page.loadData(true)

    search(page, '张')
    expect(page.data.displayItems).toHaveLength(1)
  })

  test('纯空格关键词不算检索，也不留在输入框里造成哑态', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    search(page, '   ')
    expect(page.data.keyword).toBe('')
    expect(page.data.filterActive).toBe(false)
  })

  test('超长关键词在提示文案里被截断，不撑爆空状态', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    search(page, '阿'.repeat(200))
    expect(page.data.searchHint).toContain('…')
    expect(page.data.searchHint.length).toBeLessThan(60)
  })
})

describe('绩效页 · 自定义区间跨度上限（评审补漏 P1）', () => {
  test('picker 上界是今天；下界只防滚轮甩到 1900，不当跨度限制用', () => {
    const page = createPage()
    page.onLoad({})

    expect(page.data.customMaxDate).toBe('2026-09-14')
    // 固定业务数据起点，不是「今天往前 N 天」的滚动窗口：查 2020 年某个 7 天区间
    // 既合理又不增加后端开销，不该被跨度上限连坐挡住（评审 codex round-1 P1 / round-2 P2）
    expect(page.data.customMinDate).toBe('2020-01-01')
  })

  test('上界每次 onShow 重算：页面过夜后当天必须可选（评审 round-1 codex P3）', () => {
    const page = createPage()
    page.onLoad({})
    expect(page.data.customMaxDate).toBe('2026-09-14')

    vi.setSystemTime(new Date(2026, 8, 15, 9, 0, 0)) // 隔夜
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.onShow()

    expect(page.data.customMaxDate).toBe('2026-09-15')
  })

  test('超过上限时保留用户刚动的那端，另一端收敛到上限内并提示', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)

    page.onCustomStartChange({ detail: { value: '2024-01-01' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect((globalThis as any).wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('跨度最多') })
    )
    expect(page.data.startDate).toBe('2024-01-01')          // 用户的意图原样保留
    expect(page.data.endDate).toBe('2025-01-06')            // 2024-01-01 + 371 天
    expect(page.daysBetween(page.data.startDate, page.data.endDate)).toBe(371)
  })

  test('改结束日期超限时收敛的是开始日期（锚定用户动的那端）', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    page.applyCustomRange('2020-01-01', '2020-01-07', 'end')
    mockPage([], 0)
    vi.mocked(callStaffApi).mockClear()

    page.onCustomEndChange({ detail: { value: '2023-06-01' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect(page.data.endDate).toBe('2023-06-01')            // 用户的意图原样保留
    expect(page.data.startDate).toBe('2022-05-26')          // 2023-06-01 - 371 天
  })

  test('两步可达任意历史短区间——单端即时提交不能把用户锁死（评审 round-3 codex P1）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([], 0)
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })
    expect(page.data.startDate).toBe('2026-09-01')
    expect(page.data.endDate).toBe('2026-09-14')

    // 第一步：挪开始日期到 2020 —— 旧实现在这里就被「跨度超限」拒了
    page.onCustomStartChange({ detail: { value: '2020-01-01' } })
    expect(page.data.startDate).toBe('2020-01-01')

    // 第二步：挪结束日期到目标 —— 旧实现走另一个顺序会被「起晚于止」拒，两路皆死
    page.onCustomEndChange({ detail: { value: '2020-01-07' } })
    expect(page.data.startDate).toBe('2020-01-01')
    expect(page.data.endDate).toBe('2020-01-07')
    expect(page.data.displayDate).toBe('2020-01-01 ~ 2020-01-07')
  })

  // 这两条钳制在 picker 带绝对上下界时正常操作走不到（要触发就得先选出界外的日期），
  // 属防御性分支——直接调 applyCustomRange 覆盖，别用 picker 事件构造不可能的输入
  test('收敛后的结束日期不会跑到今天之后（防御分支）', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)

    page.applyCustomRange('2026-09-01', '2028-01-01', 'start')

    expect(page.data.startDate).toBe('2026-09-01')
    expect(page.data.endDate).toBe('2026-09-14') // 钳到 customMaxDate，不是 2026-09-01+371
  })

  test('收敛后的开始日期不会早于业务数据起点（防御分支）', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)

    page.applyCustomRange('2019-01-01', '2020-06-01', 'end')

    expect(page.data.endDate).toBe('2020-06-01')
    expect(page.data.startDate).toBe('2020-01-01') // 钳到 HISTORY_MIN_DATE，不是 2019-05-27
  })

  test('shiftDate 与 daysBetween 互为逆运算（跨年跨闰）', () => {
    const page = createPage()
    expect(page.shiftDate('2026-09-14', 1)).toBe('2026-09-15')
    expect(page.shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(page.shiftDate('2024-02-28', 2)).toBe('2024-03-01') // 闰年
    expect(page.shiftDate('2020-01-01', 371)).toBe('2021-01-06')
    expect(page.daysBetween('2020-01-01', page.shiftDate('2020-01-01', 371))).toBe(371)
  })

  test('上限之内的长区间正常放行', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    page.onCustomStartChange({ detail: { value: '2025-10-01' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect(page.data.startDate).toBe('2025-10-01')
  })

  test('daysBetween 跨年跨闰月算得准', () => {
    const page = createPage()
    expect(page.daysBetween('2026-09-01', '2026-09-14')).toBe(13)
    expect(page.daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(page.daysBetween('2024-02-28', '2024-03-01')).toBe(2) // 2024 闰年
    expect(page.daysBetween('2026-09-14', '2026-09-14')).toBe(0)
  })
})

describe('绩效页 · 切「自定义」不做无谓重拉（评审 round-1 codex P2）', () => {
  test('区间与当前一致时只展开 picker，不清屏也不发请求', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.items).toHaveLength(1)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(page.data.rangeType).toBe('custom')
    expect(page.data.displayDate).toBe('2026-09-01 ~ 2026-09-14')
    expect(callStaffApi).not.toHaveBeenCalled()   // 后端是全区间扫描，白跑一趟就是纯浪费
    expect(page.data.items).toHaveLength(1)       // 屏幕上的数据同源，不该被清掉
    expect(page.data.totalCommission).not.toBe('--')
  })

  test('首屏 onLoad(range=custom) 仍照常交给 onShow 取数，不被早退吃掉', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    expect(page.data.rangeType).toBe('custom')
    expect(page.data.startDate).toBe('2026-09-01')
    expect(callStaffApi).not.toHaveBeenCalled() // onLoad 本就 fetch=false
    expect(page.data.items).toHaveLength(0)
  })

  test('真改了日期照常刷新', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })
    vi.mocked(callStaffApi).mockClear()
    page.onCustomStartChange({ detail: { value: '2026-08-20' } })

    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())
    expect(page.data.startDate).toBe('2026-08-20')
  })
})

describe('绩效页 · 过夜/跨月后区间必须跟着今天走（评审 round-2 codex P1）', () => {
  test('页面在页面栈过夜：onShow 把「今日」推进到新的今天并重拉', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.startDate).toBe('2026-09-14')

    vi.setSystemTime(new Date(2026, 8, 15, 9, 0, 0)) // 隔夜
    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(page.data.startDate).toBe('2026-09-15')
    expect(page.data.endDate).toBe('2026-09-15')
    expect(page.data.displayDate).toBe('2026-09-15')
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ startDate: '2026-09-15' })
    // 区间变了 = 主体变了，旧数据不能留在屏幕上冒充新一天的业绩
    expect(page.data.items).toHaveLength(0)
  })

  test('跨月：「本月」不再停留在上个月', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.startDate).toBe('2026-09-01')

    vi.setSystemTime(new Date(2026, 9, 3, 9, 0, 0)) // 跨到 10 月
    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(page.data.startDate).toBe('2026-10-01')
    expect(page.data.endDate).toBe('2026-10-03')
    expect(page.data.displayDate).toBe('2026年10月')
  })

  test('同一天内 onShow 仍走原来的被动刷新（不清屏）', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(page.data.items).toHaveLength(1) // 主体没变，旧数据保留
    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('custom 是用户手选的区间，onShow 不擅自改动', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    page.onCustomStartChange({ detail: { value: '2026-08-20' } })
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    vi.setSystemTime(new Date(2026, 8, 15, 9, 0, 0))
    page.onShow()

    expect(page.data.startDate).toBe('2026-08-20')
    expect(page.data.endDate).toBe('2026-09-14')
  })
})

describe('绩效页 · 「成功查到 0 条」不等于「还没加载」（评审 round-2 codex P3）', () => {
  test('本期 0 条时切「自定义」同样不重复扫描', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([], 0) // 成功返回，但本期确实没有记录
    await page.loadData(true)
    expect(page.data.items).toHaveLength(0)
    expect(page.data.loadFailed).toBe(false)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(page.data.rangeType).toBe('custom')
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('加载失败后切「自定义」仍要重拉（_lastKey 已被清空）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true)
    expect(page.data.loadFailed).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })
})

describe('绩效页 · picker 边界刷新时机（评审 round-4 glm P3）', () => {
  test('值没变时不白发一次 setData', () => {
    const page = createPage()
    page.onLoad({})
    mockPage([], 0)

    const spy = vi.spyOn(page, 'setData')
    page.refreshDateBounds()

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  test('长时间停在前台跨午夜：点「自定义」时补刷上界', () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([], 0)
    expect(page.data.customMaxDate).toBe('2026-09-14')

    // 一直停在页面上跨过午夜 —— 收不到 onShow
    vi.setSystemTime(new Date(2026, 8, 15, 0, 30, 0))
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(page.data.customMaxDate).toBe('2026-09-15')
  })
})

describe('绩效页 · 检索防抖（评审 round-5 glm P2）', () => {
  test('关键词立即回显，过滤延后一拍——上千条明细时逐字全量过滤会掉帧', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)]
    page.data.total = 2

    page.onKeywordChange({ detail: '张三' })
    expect(page.data.keyword).toBe('张三')      // 输入框受控，回显不能等
    expect(page.data.filterActive).toBe(false)  // 过滤还没跑

    vi.advanceTimersByTime(250)
    expect(page.data.filterActive).toBe(true)
    expect(page.data.displayItems).toHaveLength(1)
  })

  test('连打多个字符只过滤一次', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1)]
    page.data.total = 1
    const spy = vi.spyOn(page, 'buildSearchView')

    page.onKeywordChange({ detail: '张' })
    page.onKeywordChange({ detail: '张三' })
    page.onKeywordChange({ detail: '张三丰' })
    expect(spy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test('清空立即生效，不等防抖', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1)]
    page.data.total = 1
    search(page, '李四')
    expect(page.data.filterActive).toBe(true)

    page.onKeywordClear()
    expect(page.data.filterActive).toBe(false) // 没有 advanceTimers
    expect(page.data.keyword).toBe('')
  })

  test('防抖窗口里页面被关掉，不对已销毁页面 setData', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1)]

    page.onKeywordChange({ detail: '张三' })
    page.onUnload()
    const spy = vi.spyOn(page, 'setData')
    vi.advanceTimersByTime(250)

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('绩效页 · 关键词还在但新主体零记录（评审 round-6 codex P2）', () => {
  test('切到没有记录的时段时空态仍给「已加载 N/共 M 条」，不退回无信息的「暂无提成记录」', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    search(page, '张三')
    expect(page.data.displayItems).toHaveLength(1)

    // 切到一个一条都没有的时段：keyword 被 blankItems 刻意保留
    mockPage([], 0)
    page.setRange('today')
    await vi.waitFor(() => expect(page.data.items).toHaveLength(0))

    expect(page.data.keyword).toBe('张三')
    expect(page.data.filterActive).toBe(true)
    // wxml 的空态 description 走 `filterActive ? searchHint : '暂无提成记录'`
    expect(page.data.searchHint).toContain('已加载 0/共 0 条')
    expect(page.data.searchHint).toContain('张三')
    expect(page.data.loadFailed).toBe(false)
  })

  test('加载失败优先级高于搜索提示——不能把失败说成「未找到某某」', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    search(page, '张三')

    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true)

    expect(page.data.loadFailed).toBe(true) // wxml 三元里 loadFailed 分支在最外层
  })
})

describe('绩效页 · applyCustomRange 自己守边界（评审 round-6 codex P3）', () => {
  test('非法日期直接拒绝——NaN 跨度会静默绕过上限校验', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    page.applyCustomRange('不是日期', '2026-09-14', 'start')
    page.applyCustomRange('2026-9-1', '2026-09-14', 'start')   // 非定宽
    page.applyCustomRange('2026-02-31', '2026-09-14', 'start') // 格式合法但日期不存在

    expect(callStaffApi).not.toHaveBeenCalled()
    expect(page.data.startDate).toBe('2026-09-01')
  })

  test('越界日期被钳回绝对上下界，不原样发到后端', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)

    page.applyCustomRange('1990-01-01', '2026-09-14', 'start')
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect(page.data.startDate).toBe('2020-01-01')
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ startDate: '2020-01-01' })
  })

  test('isValidDate 认得闰日与月末', () => {
    const page = createPage()
    expect(page.isValidDate('2024-02-29')).toBe(true)  // 2024 闰年
    expect(page.isValidDate('2025-02-29')).toBe(false) // 2025 平年
    expect(page.isValidDate('2026-04-31')).toBe(false)
    expect(page.isValidDate('2026-12-31')).toBe(true)
  })
})
