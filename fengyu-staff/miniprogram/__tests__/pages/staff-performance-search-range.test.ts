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
  // 必须显式清队列：useFakeTimers 不会丢掉上一个用例遗留的定时器，
  // 而本页有跨零点定时器（每个 page 实例一个），累积下来会让后续用例里
  // 一次 advanceTimersByTime 引爆七八个旧实例的回调，测出莫名其妙的重复请求
  vi.clearAllTimers()
  vi.setSystemTime(new Date(2026, 8, 14, 10, 0, 0)) // 2026-09-14 本地时间
  ;(globalThis as any).wx.showToast = vi.fn()
  ;(globalThis as any).wx.pageScrollTo = vi.fn() // 滑窗后回顶，setup.ts 只 mock 了 storage
})

function createPage() {
  const page: Record<string, any> = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    // 支持 `items[3]` 这种路径 setData —— 翻页走增量追加以避开 1MB 上限，
    // mock 不认路径的话测试会假绿（this.data.items 永远停在第一页）
    setData(update: Record<string, unknown>, cb?: () => void) {
      for (const [key, value] of Object.entries(update)) {
        const m = key.match(/^(\w+)\[(\d+)\]$/)
        if (m) {
          const [, arr, idx] = m
          if (!Array.isArray(this.data[arr])) this.data[arr] = []
          this.data[arr][Number(idx)] = value
        } else {
          this.data[key] = value
        }
      }
      // 真机上 setData 的第二参在数据落到视图层后回调；`_screen.settled` 这类
      // 「屏幕数据身份证」就挂在这里提交，mock 必须一并支持
      cb?.()
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

  test('纯空格关键词不触发过滤（但原样回显——trim 回写会让含空格姓名输不进去）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    search(page, '   ')
    expect(page.data.keyword).toBe('   ')     // 受控回显不改用户输入（评审 r11 glm P3）
    expect(page.data.filterActive).toBe(false) // 但不当作检索，列表仍是全量
    expect(page.data.searchHint).toBe('')
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
      expect.objectContaining({ title: expect.stringContaining('相差') })
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

  test('加载失败后切「自定义」仍要重拉（屏幕身份已被清空）', async () => {
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
    // wxml 的空态 description 走 `filterActive ? searchHint : '暂无提成记录'`。
    // total===0 时归因必须落在「本时段没有任何记录」上，不能说成「未找到张三」——
    // 后者会让员工以为张三的单被分给了别人（codex r6 P2 要求不退回无信息空态、
    // glm r7 P3 要求归因准确，这条文案同时满足两者）
    expect(page.data.searchHint).toContain('本时段暂无提成记录')
    expect(page.data.searchHint).toContain('已加载 0/共 0 条') // 验收 3 要求计数
    expect(page.data.searchHint).toContain('张三')
    expect(page.data.searchHint).not.toContain('未找到')
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

describe('绩效页 · 翻页增量 setData（评审 round-7 glm P1）', () => {
  test('翻页只传新增那一页，不把已累积的全量重新序列化——单次 setData 有 1MB 上限', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 60)
    await page.loadData(true)
    expect(page.data.items).toHaveLength(20)

    const spy = vi.spyOn(page, 'setData')
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${20 + i}`, `1390000${String(i).padStart(4, '0')}`, 20 + i)), 60)
    await page.loadData(false)

    const payload = spy.mock.calls.find((c) => Object.keys(c[0] as object).some((k) => k.startsWith('items')))![0] as Record<string, unknown>
    // 路径式追加，不是整个 items 数组
    expect(payload.items).toBeUndefined()
    expect(payload['items[20]']).toBeDefined()
    expect(payload['items[39]']).toBeDefined()
    expect(payload['items[0]']).toBeUndefined() // 第一页不该被重传
    spy.mockRestore()

    expect(page.data.items).toHaveLength(40)
    expect(page.data.items[0].customerName).toBe('顾客0')
    expect(page.data.items[39].customerName).toBe('顾客39')
  })

  test('reset 仍整体替换（换时段/换员工不能留上一批的尾巴）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 60)
    await page.loadData(true)
    await page.loadData(false)
    expect(page.data.items).toHaveLength(40)

    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    expect(page.data.items).toHaveLength(1) // 不是 40 条里替换掉 1 条
    expect(page.data.items[0].customerName).toBe('张三')
  })
})

describe('绩效页 · 全角数字与防抖清理（评审 round-7 glm P3）', () => {
  test('全角数字关键词也能匹配半角手机号', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13812345678', 1), makeItem('李四', '13900001234', 2)], 2)
    await page.loadData(true)

    search(page, '１３８')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('onHide 把在途防抖结算掉，不留「输入框新词 / 列表旧词」的错配', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)]
    page.data.total = 2

    page.onKeywordChange({ detail: '张三' })
    expect(page.data.filterActive).toBe(false) // 防抖还没到

    page.onHide() // 用户 200ms 内就跳走了

    // 关键：离开时必须结算，否则回来时 keyword='张三' 而 displayItems 还是上一轮的
    expect(page.data.filterActive).toBe(true)
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    const spy = vi.spyOn(page, 'setData')
    vi.advanceTimersByTime(250)
    expect(spy).not.toHaveBeenCalled() // 定时器已清，不会再来一次
    spy.mockRestore()
  })

  test('onUnload 只取消不结算（页面要销毁了，setData 无意义）', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1)]
    page.data.total = 1

    page.onKeywordChange({ detail: '张三' })
    page.onUnload()
    const spy = vi.spyOn(page, 'setData')
    vi.advanceTimersByTime(250)

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('绩效页 · 过滤结果渲染上限（评审 round-8 codex P1）', () => {
  test('宽泛关键词命中上千条时截断到 200 并提示——整体重建 displayItems 同样会撞 1MB', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 500)
    await page.loadData(true)

    search(page, '顾客') // 500 条全中
    expect(page.data.displayItems).toHaveLength(200)
    expect(page.data.searchHint).toContain('匹配 500 条')
    expect(page.data.matchWindowLabel).toBe('第 1-200 条 / 共 500 条命中')
    expect(page.data.searchHint).not.toContain('第 1-200 条') // 区间只由底部导航播报一次
    expect(page.data.hasMoreMatches).toBe(true)
  })

  test('正常检索（命中少量）不受上限影响，文案照旧带汇总口径说明', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 2)
    await page.loadData(true)

    search(page, '张三')
    expect(page.data.displayItems).toHaveLength(1)
    expect(page.data.searchHint).toContain('顶部汇总为全量')
    expect(page.data.searchHint).not.toContain('仅显示前')
  })
})

describe('绩效页 · 姓名空格归一与手动刷新入口（评审 round-9 glm P3）', () => {
  test('「张 三」能搜到「张三」，反之亦然——看着一样却搜不到最伤信任', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李 四', '13900000002', 2)], 2)
    await page.loadData(true)

    search(page, '张 三')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    search(page, '李四')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['李 四'])
  })

  test('点已选中的「今日」仍然重拉（这是页面唯一的手动刷新入口）', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('从别的档位切进「自定义」不重拉（区间是沿用来的，数据本就同源）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(page.data.rangeType).toBe('custom')
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('已经是「自定义」了再点一次 = 手动刷新，必须重拉', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.rangeType).toBe('custom')

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    // 无结果文案里「点上方时段按钮可重查」指的就是这个动作，吞掉它那句指引就成了空话
    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('命中过多被截断时同样标注顶部汇总口径（此时明细与汇总差距最大）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage(Array.from({ length: 500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 500)
    await page.loadData(true)

    search(page, '顾客')
    expect(page.data.matchWindowLabel).toContain('第 1-200 条')
    expect(page.data.searchHint).toContain('顶部汇总为全量')
  })
})

describe('绩效页 · 评审 round-11 闭环（glm）', () => {
  test('打字中途的空格不被吃掉——受控回写 trim 会让「张 三」永远输不进去', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张 三', '13800000001', 1)]
    page.data.total = 1

    page.onKeywordChange({ detail: '张 ' }) // 打完「张」再打空格
    expect(page.data.keyword).toBe('张 ')    // 空格必须留着，否则下一个字接不上

    search(page, '张 三')
    expect(page.data.displayItems).toHaveLength(1)
  })

  test('纯空格仍不触发过滤（哑态由 buildSearchView 的空串早退兜住）', () => {
    const page = createPage()
    page.onLoad({})
    page.data.items = [makeItem('张三', '13800000001', 1)]
    page.data.total = 1

    search(page, '   ')
    expect(page.data.filterActive).toBe(false)
  })

  test('明细带稳定 rowKey：wx:key="index" 在对象列表上是无效键', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 4)
    await page.loadData(true)
    expect(page.data.items.map((i: any) => i.rowKey)).toEqual(['0-0', '0-1'])

    mockPage([makeItem('王五', '13700000003', 3)], 4)
    await page.loadData(false)
    // 翻页追加的键不与第一页冲突
    expect(page.data.items.map((i: any) => i.rowKey)).toEqual(['0-0', '0-1', '2-0'])
    expect(new Set(page.data.items.map((i: any) => i.rowKey)).size).toBe(3)
  })

  test('加载成功时取消在途防抖，不重复过滤一遍', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    page.onKeywordChange({ detail: '张三' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true) // 成功路径里已经带了最新的 buildSearchView 结果

    const spy = vi.spyOn(page, 'buildSearchView')
    vi.advanceTimersByTime(250)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('绩效页 · 渲染窗口可推进（评审 round-12 codex P2）', () => {
  function loadMany(page: Record<string, any>, n: number, total = n) {
    mockPage(Array.from({ length: n }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), total)
  }

  test('窗口不能钉死在前 200 条——否则翻页新取回的命中永远露不出来', async () => {
    const page = createPage()
    page.onLoad({})
    loadMany(page, 500)
    await page.loadData(true)

    search(page, '顾客')
    expect(page.data.displayItems).toHaveLength(200)
    expect(page.data.hasMoreMatches).toBe(true)

    page.onShowMoreMatches()
    expect(page.data.displayItems).toHaveLength(400)
    expect(page.data.matchWindowLabel).toBe('第 1-400 条 / 共 500 条命中')

    page.onShowMoreMatches()
    expect(page.data.displayItems).toHaveLength(500) // 命中只有 500，取完即止
    expect(page.data.hasMoreMatches).toBe(false)
  })

  test('窗口撑到硬顶后改为整段往后滑——钉死的话后面的命中永远露不出来', async () => {
    const page = createPage()
    page.onLoad({})
    loadMany(page, 1500)
    await page.loadData(true)

    search(page, '顾客')
    // 200 → 400 → 500(硬顶)
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(500)
    expect(page.data.displayOffset).toBe(0)
    expect(page.data.displayItems[0].customerName).toBe('顾客0')

    // 到顶后再点 = 下一批
    page.onShowMoreMatches()
    expect(page.data.displayOffset).toBe(500)
    expect(page.data.displayItems[0].customerName).toBe('顾客500')
    expect(page.data.matchWindowLabel).toBe('第 501-1000 条 / 共 1500 条命中')
    expect(page.data.hasPrevMatches).toBe(true)
    expect(page.data.hasMoreMatches).toBe(true)

    // 一直滑到最后一批
    page.onShowMoreMatches()
    expect(page.data.displayOffset).toBe(1000)
    expect(page.data.displayItems[page.data.displayItems.length - 1].customerName).toBe('顾客1499')
    expect(page.data.hasMoreMatches).toBe(false)

    // 还能滑回去
    page.onPrevMatches()
    expect(page.data.displayOffset).toBe(500)
    expect(page.data.displayItems[0].customerName).toBe('顾客500')
  })

  test('翻页取回的新命中落在窗口之后也仍可达', async () => {
    const page = createPage()
    page.onLoad({})
    loadMany(page, 500, 1000)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(500)
    expect(page.data.hasMoreMatches).toBe(false) // 目前只加载了 500 条，全在窗口里

    // 再翻一页，新命中排在 500 之后
    mockPage([makeItem('顾客500', '13800000500', 500)], 1000)
    await page.loadData(false)

    expect(page.data.hasMoreMatches).toBe(true) // 有了可达路径
    page.onShowMoreMatches()
    expect(page.data.displayItems[0].customerName).toBe('顾客500')
  })

  test('换关键词把窗口收回第一屏', async () => {
    const page = createPage()
    page.onLoad({})
    loadMany(page, 500)
    await page.loadData(true)

    search(page, '顾客')
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(400)

    search(page, '顾客1')
    expect(page.data.displayLimit).toBe(200)
  })

  test('翻页不会把已推开的窗口打回第一屏', async () => {
    const page = createPage()
    page.onLoad({})
    loadMany(page, 500, 1000)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(400)

    mockPage([makeItem('顾客999', '13800009999', 999)], 1000)
    await page.loadData(false)

    expect(page.data.displayLimit).toBe(400)
    expect(page.data.displayItems).toHaveLength(400)
  })
})

describe('绩效页 · 跨零点自动刷新 picker 上界（评审 round-12 codex P3）', () => {
  test('页面一直停在前台跨午夜也能把上界推到新的今天', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)
    page.onShow()
    expect(page.data.customMaxDate).toBe('2026-09-14')

    // 不触发 onShow、不点任何按钮，纯粹让时钟走过零点
    // （定时器定在次日 0:00:05，此刻是 10:00，差 14h05s —— fake timer 会一并推进 Date.now）
    vi.advanceTimersByTime(14 * 3600 * 1000 + 10 * 1000)

    expect(page.data.customMaxDate).toBe('2026-09-15')
  })

  test('onHide / onUnload 都要清掉跨零点定时器', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)
    page.onShow()

    page.onHide()
    expect(page._midnightTimer).toBeNull()

    page.onShow()
    expect(page._midnightTimer).not.toBeNull()
    page.onUnload()
    expect(page._midnightTimer).toBeNull()
  })
})

describe('绩效页 · 跨零点同步区间（评审 round-13 codex P2）', () => {
  // 注：这些用例不用 vi.waitFor —— 它在 fake timers 下会自行推进定时器，
  // 会把跨零点回调提前引爆，测出来的时序不是真实的
  test('停前台跨午夜：「今日」必须跟着推进，不能只刷 picker 上界', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    page.scheduleMidnightRefresh() // onShow 会做这件事，这里只挂定时器，隔离掉它的异步部分
    expect(page.data.startDate).toBe('2026-09-14')
    expect(page.data.items).toHaveLength(1)

    vi.mocked(callStaffApi).mockClear()
    mockPage([], 0)
    vi.advanceTimersByTime(14 * 3600 * 1000 + 10 * 1000) // 走过 0:00:05

    expect(page.data.customMaxDate).toBe('2026-09-15')
    expect(page.data.startDate).toBe('2026-09-15') // 区间也得推进
    expect(page.data.displayDate).toBe('2026-09-15')
    expect(callStaffApi).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ startDate: '2026-09-15' })
    expect(page.data.items).toHaveLength(0) // 主体变了，昨天的数据不能留
  })

  test('custom 是用户手选的区间，跨零点不擅自改', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)
    page.applyCustomRange('2026-08-20', '2026-09-14', 'start')
    page.scheduleMidnightRefresh()
    expect(page.data.startDate).toBe('2026-08-20')

    vi.advanceTimersByTime(14 * 3600 * 1000 + 10 * 1000)

    expect(page.data.startDate).toBe('2026-08-20')
    expect(page.data.customMaxDate).toBe('2026-09-15') // 上界推进，区间不动
  })
})

describe('绩效页 · 评审 round-14 闭环（glm）', () => {
  test('脱敏与检索同口径：带分隔符的号搜得到、也核对得上', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '138-0013-8000', 1)], 1)
    await page.loadData(true)

    // 直接喂原始值会脱敏错位成 138******8000，与员工输入的 13800138000 对不上
    expect(page.data.items[0].customerPhoneMasked).toBe('138****8000')

    search(page, '13800138000')
    expect(page.data.displayItems).toHaveLength(1)
  })

  test('屏幕身份整体替换：失败时不能和屏幕上的数据漂移', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page._screen?.key).toContain('2026-09-01')

    // 主体变更后请求失败：屏幕身份必须已被清空，否则 keepStaleOnError 会误判同源
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    page.setRange('today')
    await vi.waitFor(() => expect(page.data.loadFailed).toBe(true))
    expect(page._screen).toBeNull()
  })

  test('改完关键词 200ms 内正好有响应回来，渲染窗口仍复位回第一屏', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 500)
    await page.loadData(true)

    search(page, '顾客')
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(400)

    // 改词后不推进定时器，直接让一次请求回来（cancelFilter 会吞掉在途防抖）
    page.onKeywordChange({ detail: '顾客1' })
    mockPage(many, 500)
    await page.loadData(true)

    expect(page.data.displayLimit).toBe(200) // 复位，不是沿用 400
  })

  test('关键词没变时翻页不复位窗口', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 1000)
    await page.loadData(true)

    search(page, '顾客')
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(400)

    mockPage([makeItem('顾客999', '13800009999', 999)], 1000)
    await page.loadData(false)

    expect(page.data.displayLimit).toBe(400)
  })
})

describe('绩效页 · 评审 round-16 闭环（codex）', () => {
  test('国际前缀号：搜得到，也要能核对——脱敏必须归一到国内 11 位', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '+8613900139000', 1)], 1)
    await page.loadData(true)

    // 只剥非数字会得到 861******9000，员工看不到自己输入的 139 开头
    expect(page.data.items[0].customerPhoneMasked).toBe('139****9000')

    search(page, '13900139000')
    expect(page.data.displayItems).toHaveLength(1)
    // 连着 86 一起输入也应命中（两侧同一条归一规则）
    search(page, '8613900139000')
    expect(page.data.displayItems).toHaveLength(1)
  })

  test('normalizePhone 只吃掉 86 国际前缀，不误伤本身以 86 开头的号段', () => {
    const page = createPage()
    expect(page.normalizePhone('+86 138-0013-8000')).toBe('13800138000')
    expect(page.normalizePhone('8613900139000')).toBe('13900139000')
    expect(page.normalizePhone('13800138000')).toBe('13800138000') // 11 位不动
    expect(page.normalizePhone('8612345678901')).toBe('8612345678901') // 861 之后不是手机号段也不动
    expect(page.normalizePhone(null)).toBe('')
  })

  test('过桥期间继续打字：不能把「新词已过滤完」错记成事实', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 500)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(400)

    // 改词但不推进防抖 —— 此刻 keyword 已是新词、displayItems 还是旧词的结果
    page.onKeywordChange({ detail: '顾客12' })
    expect(page.data.keyword).not.toBe(page._filteredKeyword)

    // 这时点窗口按钮：不能沿用旧 offset/limit 从错误位置开窗
    page.onShowMoreMatches()
    expect(page._filteredKeyword).toBe('顾客12')
    expect(page.data.displayLimit).toBe(200)   // 复位到第一屏
    expect(page.data.displayOffset).toBe(0)
    expect(page.data.displayItems.every((i: any) => i.customerName.indexOf('顾客12') === 0)).toBe(true)
  })

  test('onPrevMatches 同样先复位再走', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 1500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 1500)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayOffset).toBe(500)

    page.onKeywordChange({ detail: '顾客7' })
    page.onPrevMatches()

    expect(page.data.displayOffset).toBe(0)
    expect(page._filteredKeyword).toBe('顾客7')
  })
})

describe('绩效页 · 混合关键词不误当号码用（round-16 测试逼出的真 bug）', () => {
  test('搜「顾客12」不该把所有手机号含 12 的人捞出来', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([
      makeItem('顾客12', '13900000000', 1),
      makeItem('张三', '13800000012', 2),   // 号里含 12，但姓名不含关键词
      makeItem('李四', '13812345678', 3),   // 同上
    ], 3)
    await page.loadData(true)

    search(page, '顾客12')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['顾客12'])
  })

  test('纯号码关键词仍照常匹配（含分隔符与全角）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000012', 1), makeItem('李四', '13900009999', 2)], 2)
    await page.loadData(true)

    search(page, '0012')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    search(page, '138 0000 0012')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    search(page, '００１２') // 全角
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('姓名里本来就带数字时按姓名匹配，不退化成号码搜索', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('3号店王五', '13700000000', 1), makeItem('赵六', '13700000003', 2)], 2)
    await page.loadData(true)

    search(page, '3号店')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['3号店王五'])
  })
})

describe('绩效页 · 评审 round-17 闭环（codex）', () => {
  test('国际前缀的号码片段也能命中（关键词侧不做 86 归一）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '+8613900139000', 1), makeItem('张三', '13800138000', 2)], 2)
    await page.loadData(true)

    search(page, '+86 139') // 片段，归一规则只认完整 13 位
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['李四'])

    search(page, '139001')  // 国内串片段
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['李四'])
  })

  test('被动刷新把 items 打回第一页时，窗口不能停在前面还有大段命中的位置', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 1500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 1500)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayOffset).toBe(500)

    // onShow 的被动刷新：reset=true，items 只剩第一页
    mockPage(many.slice(0, 20), 1500)
    await page.loadData(true, true)

    expect(page.data.displayOffset).toBe(0)
    expect(page.data.displayItems).toHaveLength(20)
    expect(page.data.hasPrevMatches).toBe(false)
  })

  test('命中数缩水时窗口收回最后一个完整窗口，不是只剩 1 条', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 1500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 1500)
    await page.loadData(true)
    search(page, '顾客')
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayOffset).toBe(500)

    // 直接按更小的命中集重建（模拟翻页后命中变少），窗口起点须收到 500 以内的窗口边界
    page.setData(page.buildSearchView(page.data.items.slice(0, 600), '顾客', 1500, 500, 500))
    expect(page.data.displayOffset).toBe(500)
    expect(page.data.displayItems).toHaveLength(100)

    page.setData(page.buildSearchView(page.data.items.slice(0, 300), '顾客', 1500, 500, 500))
    expect(page.data.displayOffset).toBe(0)   // 300 条只够一个窗口
    expect(page.data.displayItems).toHaveLength(300)
  })
})

describe('绩效页 · 号码格式交叉匹配（评审 round-18 codex P2）', () => {
  // 关键词与明细各自都可能带或不带 86，四种组合都得通
  const CASES: Array<[string, string, string]> = [
    ['明细带86 / 词带86 完整', '+8613900139000', '+86 13900139000'],
    ['明细带86 / 词不带86 完整', '+8613900139000', '13900139000'],
    ['明细不带86 / 词带86 完整', '13900139000', '+86 13900139000'],
    ['明细不带86 / 词不带86 完整', '13900139000', '13900139000'],
    ['明细带86 / 词带86 片段', '+8613900139000', '+86 139'],
    ['明细不带86 / 词带86 片段', '13900139000', '+86 139'],
    ['明细带86 / 词不带86 片段', '+8613900139000', '139001'],
    ['明细不带86 / 词不带86 片段', '13900139000', '139001'],
  ]

  test.each(CASES)('%s', async (_label, phone, keyword) => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', phone, 1), makeItem('张三', '13800138000', 2)], 2)
    await page.loadData(true)

    search(page, keyword)
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['李四'])
  })

  test('不相干的号不会因为摊候选而被误命中', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('李四', '13900139000', 1), makeItem('张三', '13800138000', 2)], 2)
    await page.loadData(true)

    search(page, '+86 138')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })
})

describe('绩效页 · 评审 round-19 闭环（codex）', () => {
  test('过桥回调迟到时不把「新词已过滤」的标记回滚成旧词', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1), makeItem('李四', '13900000002', 2)], 2)

    // 手工模拟真机时序：setData 回调延后到「用户已改词 + 新词防抖已跑完」之后
    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }

    await page.loadData(true)
    search(page, '张三')
    expect(page._filteredKeyword).toBe('张三')

    pending.forEach((cb) => cb()) // 迟到的回调此刻才落地
    expect(page._filteredKeyword).toBe('张三') // 不能被回滚成 ''

    page.setData = realSetData
    // 标记没被回滚，点窗口按钮就不会误判成「过滤未完成」而吞掉点击
    expect(page.data.keyword).toBe(page._filteredKeyword)
  })

  test('按钮文案由 ts 预算，不在 wxml 里硬编码硬顶数字', async () => {
    const page = createPage()
    page.onLoad({})
    const many = Array.from({ length: 1500 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i))
    mockPage(many, 1500)
    await page.loadData(true)

    search(page, '顾客')
    expect(page.data.moreMatchesLabel).toBe('显示更多') // 窗口还能变大

    page.onShowMoreMatches()
    page.onShowMoreMatches()
    expect(page.data.displayLimit).toBe(500)
    expect(page.data.moreMatchesLabel).toBe('下一批')   // 到硬顶，改为整段滑动
  })
})

describe('绩效页 · 评审 round-20 闭环（glm）', () => {
  test('全角括号/减号粘贴的号码也能搜——粘贴是手机号输入的主要来源', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800138000', 1), makeItem('李四', '13900139000', 2)], 2)
    await page.loadData(true)

    search(page, '（138）0013－8000')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])

    search(page, '１３８００１３８０００') // 全角数字
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('输到一半的 8613 不把所有含 13 的号涌进来', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([
      makeItem('张三', '13800138000', 1),
      makeItem('李四', '15913000000', 2), // 号里含 13，但不是 861 开头
    ], 2)
    await page.loadData(true)

    search(page, '8613')
    // 半截国际前缀：剥完只剩 `13`（噪声太大），只留 `8613` 又会造成
    // 「存成 +86 的搜得到、存成国内格式的搜不到」—— 所以两边都不匹配
    expect(page.data.displayItems).toHaveLength(0)

    search(page, '+86 138') // 剥完剩 3 位，正常纳入
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })

  test('被动刷新是完整 reset：宁可丢翻页进度，也不能沿用会漂移的 offset 游标', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 200)
    await page.loadData(true)
    await page.loadData(false)
    expect(page.data.items).toHaveLength(40)

    // 后端是 offset 分页 + 每次重排；期间有新单的话旧游标就指偏了，
    // 继续沿用会重复旧行、漏掉新行，还会显示「已加载 N/共 N」让员工以为查全了
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 201)
    await page.loadData(true, true)

    expect(page.data.items).toHaveLength(20)
    expect(page.data.page).toBe(1)
    expect(page.data.total).toBe(201)
  })

  test('被动刷新期间被撤权：必须清屏，不能继续挂着无权查看的薪酬', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 200)
    await page.loadData(true)
    await page.loadData(false)

    const denied = Object.assign(new Error('无权查看'), { errorType: 'PERMISSION_DENIED' })
    vi.mocked(callStaffApi).mockRejectedValue(denied)
    await page.loadData(true, true)

    expect(page.data.items).toHaveLength(0)
    expect(page.data.displayItems).toHaveLength(0)
    expect(page.data.totalCommission).toBe('--')
    expect(page._screen).toBeNull()
  })


  test('只有第一页时 onShow 仍照常被动刷新', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.page).toBe(1)

    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('深翻页后换时段仍走完整重拉（主体变更不受影响）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 200)
    await page.loadData(true)
    await page.loadData(false)
    expect(page.data.page).toBe(2)

    vi.mocked(callStaffApi).mockClear()
    mockPage([], 0)
    page.setRange('today')

    expect(callStaffApi).toHaveBeenCalledTimes(1)
    expect(page.data.items).toHaveLength(0)
  })
})

describe('绩效页 · 号码分隔符白名单（评审 round-22 codex P2）', () => {
  test.each([
    ['点分隔', '138.0013.8000'],
    ['全角点分隔', '138．0013．8000'],
    ['斜杠分隔', '138/0013/8000'],
    ['空格分隔', '138 0013 8000'],
    ['减号分隔', '138-0013-8000'],
    ['括号', '(138)0013 8000'],
  ])('%s 的写法都能搜到', async (_label, keyword) => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800138000', 1), makeItem('李四', '13900139000', 2)], 2)
    await page.loadData(true)

    search(page, keyword)
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })
})

describe('绩效页 · 评审 round-24 闭环（glm）', () => {
  test('加载失败后在 picker 里重选同一天要能重试，不被同值早退吞掉', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true)
    expect(page.data.loadFailed).toBe(true)
    const { startDate, endDate } = page.data

    vi.mocked(callStaffApi).mockClear()
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    page.applyCustomRange(startDate, endDate, 'start') // 重选当前这一天

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('成功态下重选同一天仍然不重拉（后端每页都是全区间扫描）', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.loadFailed).toBe(false)

    vi.mocked(callStaffApi).mockClear()
    page.applyCustomRange(page.data.startDate, page.data.endDate, 'start')

    expect(callStaffApi).not.toHaveBeenCalled()
  })
})

describe('绩效页 · 评审 round-25 闭环（codex）', () => {
  test('回调迟到但屏幕仍是它的数据时，身份证照常提交——否则下次失败会误清屏', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    // 把 setData 回调压住，模拟「A 已上屏、回调还没跑，B 已经发起」的真机时序
    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    await page.loadData(true)
    page._seq++ // 期间又发起了一次请求，请求代次已经往前走了
    pending.forEach((cb) => cb())
    page.setData = realSetData

    // 屏幕上挂的还是那批数据，身份就该反映这个事实
    expect(page._screen?.settled).toBe(true)

    // 于是紧随其后的被动刷新失败时，同源数据得以保留（keepStaleOnError 生效）
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true, true)
    expect(page.data.items).toHaveLength(1)
  })

  test('更新的响应写过屏幕后，旧回调不再提交身份证', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    await page.loadData(true)          // A 上屏
    const staleCb = pending.shift()!   // 扣下 A 的回调，先不执行
    await page.loadData(true)          // B 上屏
    page.setData = realSetData
    pending.forEach((cb) => cb())      // B 的回调正常落地
    const keyAfterB = page._screen?.key
    expect(keyAfterB).not.toBe('')

    staleCb() // A 的回调此刻才迟到
    expect(page._screen?.key).toBe(keyAfterB) // 没被 A 倒退覆盖
    expect(page._screen?.seq).toBe(2)
  })

  test('同区间请求在途时连点「自定义」，不并发启动多个全区间扫描', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {})) // 请求挂起
    page.loadData(true)
    expect(page.data.loading).toBe(true)
    expect(page._screen).toBeNull() // 首屏还没成功过

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(callStaffApi).not.toHaveBeenCalled() // 等在途那次就行
  })
})

describe('绩效页 · 清屏后迟到回调不得复活旧缓存（评审 round-26 codex P1）', () => {
  test('-403 清屏后，此前成功响应的迟到回调不能把旧主体缓存写回来', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockResolvedValue({
      totalSalesAlloc: 100, totalServiceCommission: 50, totalCommission: 150,
      items: [makeItem('张三', '13800000001', 1)], total: 1,
      categorySummary: { 自销自耗: { sales: 100, service: 50 } },
      categories: ['自销自耗'],
    } as never)

    // 压住回调，制造「成功已上屏、回调未跑」的时序
    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    await page.loadData(true)
    page.setData = realSetData

    // 此时被撤权
    const denied = Object.assign(new Error('无权查看'), { errorType: 'PERMISSION_DENIED' })
    vi.mocked(callStaffApi).mockRejectedValue(denied)
    await page.loadData(true, true)
    expect(page._summaryCache).toBeNull()
    expect(page._screen).toBeNull()

    // 迟到的成功回调此刻才落地
    pending.forEach((cb) => cb())

    // 不能复活：否则切一级 Tab 就能用 _summaryCache 重算出已撤权员工的分类薪酬
    expect(page._summaryCache).toBeNull()
    expect(page._screen).toBeNull()
    page.onMainTabChange({ detail: { index: 1 } })
    expect(page.data.hasCategoryPanel).toBe(false)
  })

  test('换员工后迟到回调同样不能把上一个员工的缓存写回', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    await page.loadData(true)
    page.setData = realSetData

    page.clearSubjectCache() // 换员工/换时段都会先做这件事
    pending.forEach((cb) => cb())

    expect(page._screen).toBeNull()
    expect(page._summaryCache).toBeNull()
  })
})

describe('绩效页 · 「看似查全」不把话说死（评审 round-27 codex P1 前端侧）', () => {
  test('已加载数等于总数时，未命中文案要给出重查入口', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.items.length).toBe(page.data.total)

    search(page, '王五')
    // 后端是 offset 分页 + 每次重排，翻页期间的新单可能根本没进过这批数据；
    // 而这个功能的结论恰恰是「这顾客到底有没有分配给我」，说死了会导出相反判断
    expect(page.data.searchHint).toContain('可重查')
  })

  test('还有没加载的页时不加这句（信息已经由「已加载 N/共 M」表达）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800000001', 1)], 58)
    await page.loadData(true)

    search(page, '王五')
    expect(page.data.searchHint).toContain('已加载 1/共 58 条')
    expect(page.data.searchHint).not.toContain('可重查')
  })
})

describe('绩效页 · 重查指引必须真的可用（评审 round-28 codex P2）', () => {
  test('自定义区间下搜不到 → 按文案点「自定义」能真的重查', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    search(page, '王五')
    expect(page.data.searchHint).toContain('可重查')

    vi.mocked(callStaffApi).mockClear()
    mockPage([makeItem('张三', '13800000001', 1), makeItem('王五', '13700000005', 2)], 2)
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('在途时连点仍然不并发（去重优先于手动刷新）', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(true)
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })
    page.onRangeTap({ currentTarget: { dataset: { type: 'custom' } } })

    expect(callStaffApi).not.toHaveBeenCalled()
  })
})

describe('绩效页 · 评审 round-29 闭环（glm）', () => {
  test('清空态不断言「本时段暂无提成记录」——那时 total=0 只代表还不知道', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    search(page, '张三')

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {})) // 请求挂起
    page.setRange('today')

    expect(page.data.filterActive).toBe(true)
    expect(page.data.searchHint).toBe('') // 不能挂着未经验证的断言
  })

  test('成功返回 0 条时才断言本期无记录', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([], 0)
    await page.loadData(true)
    search(page, '张三')

    expect(page.data.searchHint).toContain('本时段暂无提成记录')
  })

  test('picker 同值确认撞上在途请求，不重复扫描', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(true)
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.applyCustomRange(page.data.startDate, page.data.endDate, 'start')

    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('明细侧存全角数字的手机号也能被半角关键词搜到', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '１３８００１３８０００', 1), makeItem('李四', '13900139000', 2)], 2)
    await page.loadData(true)

    search(page, '13800138000')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
    // 脱敏展示也走同一条归一化，不会因为全角而错位
    expect(page.data.items[0].customerPhoneMasked).toBe('138****8000')
  })

  test('档位按钮 dataset 取空时直接忽略，不把 rangeType 写成 undefined', () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([], 0)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: {} } })

    expect(page.data.rangeType).toBe('month')
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})

describe('绩效页 · 评审 round-30 闭环（codex）', () => {
  test('被动刷新抢在成功回调之前失败时，同源数据必须保住', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    // 压住 A 的完成回调：loadData 不等它，B 完全可能抢先
    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    await page.loadData(true)
    expect(page.data.items).toHaveLength(1)
    expect(page._screen?.settled).toBe(false) // 回调还没跑
    expect(page._screen?.key).not.toBe('')    // 但数据已经过桥、身份已经立住

    // B：同源被动刷新，先失败
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true, true)
    page.setData = realSetData

    // keepStaleOnError：同源就该保住，不能因为 A 的回调还没落地就当异源清掉
    expect(page.data.items).toHaveLength(1)
    expect(page.data.loadFailed).toBe(false)
  })

  test('异源失败仍然照常清屏（别把守卫放得太宽）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)

    // 换时段 = 异源，失败必须清
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    page.setRange('today')
    await vi.waitFor(() => expect(page.data.loadFailed).toBe(true))

    expect(page.data.items).toHaveLength(0)
  })

  test('全角斜杠分隔的号码也能搜到（ASCII 斜杠已在白名单里）', async () => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', '13800138000', 1), makeItem('李四', '13900139000', 2)], 2)
    await page.loadData(true)

    search(page, '１３８／００１３／８０００')
    expect(page.data.displayItems.map((i: any) => i.customerName)).toEqual(['张三'])
  })
})

describe('绩效页 · 屏幕身份整体替换（评审 round-31 codex P2 的根因收敛）', () => {
  /** 把 setData 回调扣下来，手工控制落地时机 */
  function holdCallbacks(page: Record<string, any>) {
    const pending: Array<() => void> = []
    const real = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      real(u)
      if (cb) pending.push(cb)
    }
    return { pending, restore: () => { page.setData = real } }
  }

  test('A 的回调落在 B 的 setData 与 B 的回调之间：不能清掉 B 的身份', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    const held = holdCallbacks(page)
    await page.loadData(true)                 // A 上屏
    const aCb = held.pending.shift()!
    await page.loadData(true)                 // B 上屏（身份整体换成 B）
    const bCb = held.pending.shift()!
    const bKey = page._screen?.key

    aCb()                                     // A 的回调迟到，正好夹在 B 的 setData 与回调之间
    expect(page._screen?.key).toBe(bKey)      // B 的身份不受影响
    expect(page._screen?.seq).toBe(2)
    expect(page._screen?.settled).toBe(false) // 更不能被 A 标记成已落地

    bCb()
    expect(page._screen?.settled).toBe(true)
    held.restore()
  })

  test('这个交错下 B 若失败，同源数据仍要保住', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    const held = holdCallbacks(page)
    await page.loadData(true)
    const aCb = held.pending.shift()!
    await page.loadData(true, true)   // B：同源被动刷新
    aCb()                             // A 的回调迟到
    held.restore()

    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络开小差'))
    await page.loadData(true, true)   // C：同源，失败

    expect(page.data.items).toHaveLength(1) // keepStaleOnError 生效
    expect(page.data.loadFailed).toBe(false)
  })

  test('清屏把身份整体抹成 null，之后任何迟到回调都不生效', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)

    const held = holdCallbacks(page)
    await page.loadData(true)
    const aCb = held.pending.shift()!
    held.restore()

    page.clearSubjectCache()
    expect(page._screen).toBeNull()

    aCb()
    expect(page._screen).toBeNull()      // 不复活
    expect(page._summaryCache).toBeNull()
  })
})

describe('绩效页 · 半截国际前缀两种存法结果一致（评审 round-33 codex P2）', () => {
  test.each([
    ['存成国际格式', '+8613800138000'],
    ['存成国内格式', '13800138000'],
  ])('%s：输到 8613 时都不命中（等输全）', async (_label, phone) => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', phone, 1)], 1)
    await page.loadData(true)

    search(page, '8613')
    expect(page.data.displayItems).toHaveLength(0)
  })

  test.each([
    ['存成国际格式', '+8613800138000'],
    ['存成国内格式', '13800138000'],
  ])('%s：再输一位到 86138 时都命中', async (_label, phone) => {
    const page = createPage()
    page.onLoad({})
    mockPage([makeItem('张三', phone, 1)], 1)
    await page.loadData(true)

    search(page, '86138')
    expect(page.data.displayItems).toHaveLength(1)
  })
})

describe('绩效页 · 在途去重覆盖所有档位（评审 round-34 codex P2）', () => {
  test('连点两下「今日」不并发——否则后发失败会盖掉先发的成功', () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([], 0)
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))

    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })
    expect(page.data.loading).toBe(true)
    vi.mocked(callStaffApi).mockClear()

    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('在途时切到**不同**区间照常抢占（别把真正换靶点的操作也吞了）', () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(true)
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'month' } } })

    expect(callStaffApi).toHaveBeenCalledTimes(1)
    expect(page.data.rangeType).toBe('month')
  })

  test('请求结束后再点同一档位，仍然是手动刷新入口', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.loading).toBe(false)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })
})

describe('绩效页 · 分类缓存只在落地后消费（评审 round-35 codex P2）', () => {
  function respWith(sales: number, service: number) {
    return {
      totalSalesAlloc: sales, totalServiceCommission: service, totalCommission: sales + service,
      items: [makeItem('张三', '13800000001', 1)], total: 1,
      categorySummary: { 自销自耗: { sales, service } },
      categories: ['自销自耗'],
    }
  }

  test('过桥期间切 Tab 不拿旧缓存覆盖刚写入的新分类金额', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockResolvedValue(respWith(100, 50) as never)
    await page.loadData(true)
    expect(page._screen?.settled).toBe(true)

    // 被动刷新取回新金额；压住回调，模拟「已 setData、回调未回」
    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    vi.mocked(callStaffApi).mockResolvedValue(respWith(999, 1) as never)
    await page.loadData(true, true)
    page.setData = realSetData
    expect(page.data.categoryCells[0].amount).toBe('1,000.00') // 新金额已上屏
    expect(page._screen?.settled).toBe(false)

    // 此刻切 Tab：不能用还是旧值的 _summaryCache 把它盖回 150
    page.onMainTabChange({ detail: { index: 0 } })
    expect(page.data.categoryCells[0]?.amount).not.toBe('150.00')

    pending.forEach((cb) => cb())
  })

  test('落地之后切 Tab 仍走本地即时重算（慢网下不留旧口径）', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockResolvedValue(respWith(100, 50) as never)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {})) // 新请求挂住
    page.onMainTabChange({ detail: { index: 2 } }) // 服务口径

    expect(page.data.cellsCaption).toBe('服务提成构成')
    expect(page.data.categoryCells[0].amount).toBe('50.00') // 立刻换成服务口径，不等请求
  })
})

describe('绩效页 · 过桥期间切 Tab 的两个方向都有终态（评审 round-36 codex P2）', () => {
  function respWith(sales: number, service: number) {
    return {
      totalSalesAlloc: sales, totalServiceCommission: service, totalCommission: sales + service,
      items: [makeItem('张三', '13800000001', 1)], total: 1,
      categorySummary: { 自销自耗: { sales, service } },
      categories: ['自销自耗'],
    }
  }

  test('过桥期间切 Tab：缓存落地后按当前选中态补算，不停在旧口径', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockResolvedValue(respWith(100, 50) as never)
    await page.loadData(true)

    const pending: Array<() => void> = []
    const realSetData = page.setData.bind(page)
    page.setData = (u: Record<string, unknown>, cb?: () => void) => {
      realSetData(u)
      if (cb) pending.push(cb)
    }
    vi.mocked(callStaffApi).mockResolvedValue(respWith(300, 80) as never)
    await page.loadData(true, true)          // 新响应上屏，回调挂起
    expect(page.data.cellsCaption).toBe('提成构成（销售+服务）')

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.onMainTabChange({ detail: { index: 2 } }) // 切到「服务」，此刻缓存未落地
    expect(page.data.activeMainTab).toBe(2)

    pending.forEach((cb) => cb())            // 缓存落地
    page.setData = realSetData

    // 不能停在「服务 Tab 高亮、金额还是合计口径」
    expect(page.data.cellsCaption).toBe('服务提成构成')
    expect(page.data.categoryCells[0].amount).toBe('80.00')
  })

  test('选中态没变时回调不多发一次 setData', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockResolvedValue(respWith(100, 50) as never)
    await page.loadData(true)

    const spy = vi.spyOn(page, 'buildCategoryPanel')
    await page.loadData(true, true)
    // 一次来自 setData 的构建即可，回调不该再补一次
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('绩效页 · 评审 round-37 闭环（codex）', () => {
  test('翻页在途时点档位要求重查，不能被当成「重复请求」吞掉', async () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 200)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(false)                 // 「继续加载下一页」在途
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } }) // 手动重查

    // 分页走的是可能漂移的 offset，替代不了完整 reset
    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('重查在途时连点同档位仍然去重', () => {
    const page = createPage()
    page.onLoad({ range: 'today' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(true)                  // 重查在途
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })
    page.onRangeTap({ currentTarget: { dataset: { type: 'today' } } })

    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('倒置区间先被 toast 拦下，不会被绝对边界钳成同一天而静默放行', () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })

    // 未来的开始日期 + 今天的结束日期：先钳的话双双变成今天，倒置就被抹平了
    page.applyCustomRange('2030-01-01', '2026-09-15', 'start')

    expect((globalThis as any).wx.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '开始日期不能晚于结束日期' })
    )
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('顺序合法但越界的区间仍照常钳制放行', async () => {
    const page = createPage()
    page.onLoad({ range: 'custom' })
    mockPage([], 0)

    page.applyCustomRange('1990-01-01', '2026-09-15', 'start')
    await vi.waitFor(() => expect(callStaffApi).toHaveBeenCalled())

    expect(page.data.startDate).toBe('2020-01-01')
  })
})

describe('绩效页 · onShow 一律复验权限（评审 round-39 codex P1）', () => {
  test('即使同区间重查在途，回前台也要重新发一次——那一次承担的是权限复验', () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(true)                 // 首屏还在路上
    expect(page.data.loading).toBe(true)

    vi.mocked(callStaffApi).mockClear()
    page.onShow()                       // 切去微信抄手机号再回来

    // 在途那次是隐藏**之前**发的，鉴权也在隐藏之前 —— 期间员工可能已被撤权，
    // 拿它顶替复验就等于把无权查看的薪酬继续留在屏幕上。多一次扫描是这条安全线的代价
    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('翻页在途时 onShow 同样照常刷新', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage(Array.from({ length: 20 }, (_, i) => makeItem(`顾客${i}`, `1380000${String(i).padStart(4, '0')}`, i)), 200)
    await page.loadData(true)

    vi.mocked(callStaffApi).mockImplementation(() => new Promise(() => {}))
    page.loadData(false)                // 分页在途
    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })

  test('请求结束后 onShow 正常刷新', async () => {
    const page = createPage()
    page.onLoad({ range: 'month' })
    mockPage([makeItem('张三', '13800000001', 1)], 1)
    await page.loadData(true)
    expect(page.data.loading).toBe(false)

    vi.mocked(callStaffApi).mockClear()
    page.onShow()

    expect(callStaffApi).toHaveBeenCalledTimes(1)
  })
})
