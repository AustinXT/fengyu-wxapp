/**
 * 顾客档案列表分页（#181）
 *
 * 覆盖 pr-ready 三个 reviewer 查出的 4 个 P1 —— 它们全在前端，改造前该页零单测，
 * 没有任何测试网能罩住这些路径。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { callStaffApi } from '../../utils/cloud'

vi.mock('../../utils/cloud', () => ({
  callStaffApi: vi.fn(),
}))

const appState = { globalData: { staffWfId: 'staff-self', loginLevel: 'store', currentStoreId: 'store-1' } as Record<string, unknown> }
const pageDefinitions: Record<string, Record<string, any>> = {}
let registeringPage = ''
let originalGetApp: unknown
let originalPage: unknown
const toastCalls: Array<{ title: string }> = []

function createPage(name: string) {
  const definition = pageDefinitions[name]
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
  } as Record<string, any>
  page.setData = (update: Record<string, unknown>) => {
    Object.assign(page.data, update)
  }
  return page
}

/** 造一条云函数原样返回的顾客行（字段名与 routes/customer.js 的 map 对齐） */
function customerRow(id: string) {
  return {
    id: null,
    clientUserId: id,
    name: `顾客${id}`,
    phone: '13800001111',
    phoneMasked: '138****1111',
    memberLevel: null,
    storeName: '测试店',
    lastServiceDate: null,
    lastPurchaseName: null,
    source: 'miniprogram',
  }
}

function pageEnvelope(ids: string[], page: number, hasMore: boolean) {
  return { customers: ids.map(customerRow), page, pageSize: 20, hasMore }
}

beforeAll(async () => {
  originalGetApp = (globalThis as any).getApp
  originalPage = (globalThis as any).Page
  ;(globalThis as any).getApp = () => appState
  ;(globalThis as any).Page = (definition: Record<string, any>) => {
    pageDefinitions[registeringPage] = definition
  }
  ;(globalThis as any).wx.showToast = (opts: { title: string }) => { toastCalls.push(opts) }
  ;(globalThis as any).wx.stopPullDownRefresh = () => {}
  ;(globalThis as any).wx.reLaunch = () => {}

  registeringPage = 'customerList'
  await import('../../pages/customer-list/customer-list')
})

afterAll(() => {
  ;(globalThis as any).getApp = originalGetApp
  ;(globalThis as any).Page = originalPage
})

beforeEach(() => {
  vi.clearAllMocks()
  toastCalls.length = 0
})

describe('#181 分页信封与裸数组兼容', () => {
  test('正常信封：首页写入 results / page / hasMore', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['u1', 'u2'], 1, true) as never)

    await page.loadList(1, true)

    expect(callStaffApi).toHaveBeenCalledWith('customer.search', expect.objectContaining({
      profileScope: true, page: 1, pageSize: 20,
    }))
    expect(page.data.results).toHaveLength(2)
    expect(page.data.page).toBe(1)
    expect(page.data.hasMore).toBe(true)
  })

  test('翻页追加到列表尾部，不覆盖已有结果', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi)
      .mockResolvedValueOnce(pageEnvelope(['u1', 'u2'], 1, true) as never)
      .mockResolvedValueOnce(pageEnvelope(['u3'], 2, false) as never)

    await page.loadList(1, true)
    await page.loadList(2, false)

    expect(page.data.results.map((r: any) => r.clientUserId)).toEqual(['u1', 'u2', 'u3'])
    expect(page.data.hasMore).toBe(false)
  })

  /**
   * P1：云函数部署与小程序发版是两条独立时间线。旧版 staffApi 不认 page，返回裸数组，
   * 此时 data.customers 是 undefined —— 改造前这会让列表恒空且「没有更多了」照常显示，
   * 伪装成「本店没有顾客」，既不报错也不进 catch。
   */
  test('云函数返回裸数组（旧版本未部署）时按单页降级，不清空列表', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValueOnce([customerRow('u1'), customerRow('u2')] as never)

    await page.loadList(1, true)

    expect(page.data.results).toHaveLength(2)
    expect(page.data.page).toBe(1)
    expect(page.data.hasMore).toBe(false)
  })
})

describe('#181 关键词提交态', () => {
  /**
   * `reqGen` 防的是「旧响应后到」，防不了「请求发出时参数已漂移」：
   * 搜「张」拿到第 1 页 → 在输入框改成「李」但没点搜索 → 触底 →
   * 若读实时值就会用「李」拉第 2 页拼到「张」的结果后面，既漏「张」的第 2 页又混两批数据。
   */
  test('翻页沿用已提交的关键词，输入框里的未提交改动不生效', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['z1'], 1, true) as never)
    page.data.searchKeyword = '张'
    await page.onSearch()
    expect(page.data.committedKeyword).toBe('张')

    page.onSearchChange({ detail: '李' })   // 改了输入框但没提交
    expect(page.data.searchKeyword).toBe('李')

    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['z2'], 2, false) as never)
    await page.loadList(2, false)

    expect(vi.mocked(callStaffApi).mock.calls.at(-1)![1]).toMatchObject({ keyword: '张', page: 2 })
    expect(page.data.results.map((r: any) => r.clientUserId)).toEqual(['z1', 'z2'])
  })

  test('提交新关键词后 committedKeyword 才更新', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValue(pageEnvelope(['n1'], 1, false) as never)
    page.data.searchKeyword = '张'
    await page.onSearch()
    page.data.searchKeyword = '李'
    await page.onSearch()
    expect(page.data.committedKeyword).toBe('李')
    expect(vi.mocked(callStaffApi).mock.calls.at(-1)![1]).toMatchObject({ keyword: '李', page: 1 })
  })

  test('onSearchChange 的 detail 为空值时不抛异常', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValue(pageEnvelope([], 1, false) as never)
    expect(() => page.onSearchChange({ detail: undefined })).not.toThrow()
    expect(page.data.searchKeyword).toBe('')
  })
})

describe('#181 请求世代：并发响应错序', () => {
  /**
   * P1：翻页请求在途时切筛选会并发发起 reset 请求。若旧的那次后返回，
   * 它的 reset=false 分支会把旧条件的数据追加到新列表尾部（跨筛选脏合并）。
   */
  test('翻页响应晚于随后的重置请求时被整体丢弃', async () => {
    const page = createPage('customerList')
    let resolveOld!: (v: unknown) => void
    vi.mocked(callStaffApi)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce(pageEnvelope(['new1'], 1, false) as never)

    const oldReq = page.loadList(3, false)       // 第 3 页在途
    await page.loadList(1, true)                 // 用户切筛选，重置请求先完成
    expect(page.data.results.map((r: any) => r.clientUserId)).toEqual(['new1'])

    resolveOld(pageEnvelope(['stale1', 'stale2'], 3, true))  // 旧请求后到
    await oldReq

    // 旧结果既不得追加，也不得把 page/hasMore 改回旧分支的值
    expect(page.data.results.map((r: any) => r.clientUserId)).toEqual(['new1'])
    expect(page.data.page).toBe(1)
    expect(page.data.hasMore).toBe(false)
  })

  test('作废请求的 finally 不得关掉新请求的 loading', async () => {
    const page = createPage('customerList')
    let resolveOld!: (v: unknown) => void
    let resolveNew!: (v: unknown) => void
    vi.mocked(callStaffApi)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve }))

    const oldReq = page.loadList(2, false)
    const newReq = page.loadList(1, true)

    resolveOld(pageEnvelope(['stale'], 2, true))
    await oldReq
    expect(page.data.loading).toBe(true)   // 新请求还在途

    resolveNew(pageEnvelope(['fresh'], 1, false))
    await newReq
    expect(page.data.loading).toBe(false)
  })
})

describe('#181 失败反馈', () => {
  /**
   * P1：loadFilteredList 与 onSearch 合并后，onSearch 恒走 reset=true 分支。
   * 若该分支静默清空，搜索失败会呈现为「无任何文案的空白列表」。
   */
  /**
   * 查询条件已切成新的（这里是加了关键词），此时把旧条件的数据留在屏幕上会顶着新的
   * 筛选高亮、底部还写「没有更多了」—— 比空列表更误导。所以 reset 失败要清空并进错误态。
   */
  test('搜索失败：toast + 清空 + 进错误态（旧条件数据不得冒充新结果）', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['u1'], 1, false) as never)
    await page.loadList(1, true)
    expect(page.data.listError).toBe(false)

    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('网络开小差'))
    page.data.searchKeyword = '张'
    await page.onSearch()

    expect(toastCalls.map((t) => t.title)).toContain('网络开小差')
    expect(page.data.results).toEqual([])
    expect(page.data.listError).toBe(true)
    expect(page.data.hasMore).toBe(false)
  })

  test('onListRetry 按当前分支重拉第一页并清掉错误态', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('超时'))
    await page.loadList(1, true)
    expect(page.data.listError).toBe(true)

    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['u1'], 1, false) as never)
    await page.onListRetry()
    expect(page.data.listError).toBe(false)
    expect(page.data.results).toHaveLength(1)

    // 标签分支的重试要走 listByTag
    page.data.activeTag = 'active'
    page.data.listError = true
    vi.mocked(callStaffApi).mockResolvedValueOnce({ customers: [customerRow('t1')], total: 1 } as never)
    await page.onListRetry()
    expect(vi.mocked(callStaffApi).mock.calls.at(-1)![0]).toBe('customer.listByTag')
    expect(page.data.listError).toBe(false)
  })

  test('首屏失败（本来就没数据）清空并提示', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('加载失败'))

    await page.loadList(1, true)

    expect(page.data.results).toEqual([])
    expect(page.data.hasMore).toBe(false)
    expect(page.data.listError).toBe(true)
    expect(toastCalls).toHaveLength(1)
  })

  test('翻页失败不推进 page，下次触底重试同一页', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['u1'], 1, true) as never)
    await page.loadList(1, true)

    vi.mocked(callStaffApi).mockRejectedValueOnce(new Error('超时'))
    await page.loadList(2, false)

    expect(page.data.page).toBe(1)    // 仍停在第 1 页
    expect(page.data.hasMore).toBe(true)
    expect(page.data.results).toHaveLength(1)
    // 翻页失败时查询条件没变，屏幕上的数据是对的 —— 不得清空、不得进错误态
    expect(page.data.listError).toBe(false)
  })
})

describe('#181 onShow 与触底', () => {
  /**
   * P1：改造前该分支不支持翻页，onShow 重拉第一页无损失；加上下滑加载后，
   * 从详情页返回会把已加载的第 2、3… 页整体丢掉。
   */
  test('已有结果时 onShow 不重置分页（从详情页返回保留已加载页）', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi)
      .mockResolvedValueOnce(pageEnvelope(['u1'], 1, true) as never)
      .mockResolvedValueOnce(pageEnvelope(['u2'], 2, false) as never)
    await page.loadList(1, true)
    await page.loadList(2, false)
    expect(page.data.results).toHaveLength(2)

    vi.mocked(callStaffApi).mockResolvedValue({ active: 0 } as never)  // customer.stats
    page.onShow()

    expect(page.data.results).toHaveLength(2)
    expect(page.data.page).toBe(2)
    const searchCalls = vi.mocked(callStaffApi).mock.calls.filter(([action]) => action === 'customer.search')
    expect(searchCalls).toHaveLength(2)   // onShow 没有再发第三次
  })

  test('列表为空时 onShow 仍会加载首页', async () => {
    const page = createPage('customerList')
    vi.mocked(callStaffApi).mockResolvedValue({ active: 0 } as never)
    page.onShow()
    const searchCalls = vi.mocked(callStaffApi).mock.calls.filter(([action]) => action === 'customer.search')
    expect(searchCalls).toHaveLength(1)
  })

  test('onReachBottom：非标签分支走 loadList；loading/hasMore 任一不满足即不发请求', async () => {
    const page = createPage('customerList')
    page.data.page = 2
    page.data.hasMore = true
    page.data.loading = false

    vi.mocked(callStaffApi).mockResolvedValueOnce(pageEnvelope(['u3'], 3, false) as never)
    page.onReachBottom()
    await Promise.resolve()
    expect(vi.mocked(callStaffApi).mock.calls[0][0]).toBe('customer.search')
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ page: 3 })

    vi.clearAllMocks()
    page.data.hasMore = false
    page.onReachBottom()
    expect(callStaffApi).not.toHaveBeenCalled()

    vi.clearAllMocks()
    page.data.hasMore = true
    page.data.loading = true
    page.onReachBottom()
    expect(callStaffApi).not.toHaveBeenCalled()
  })

  test('onReachBottom：标签分支走 listByTag 且带上下一页页码', async () => {
    const page = createPage('customerList')
    page.data.activeTag = 'active'
    page.data.page = 2
    page.data.hasMore = true
    page.data.loading = false

    vi.mocked(callStaffApi).mockResolvedValueOnce({ customers: [customerRow('t3')], total: 99 } as never)
    page.onReachBottom()
    await Promise.resolve()

    expect(vi.mocked(callStaffApi).mock.calls[0][0]).toBe('customer.listByTag')
    expect(vi.mocked(callStaffApi).mock.calls[0][1]).toMatchObject({ tag: 'active', page: 3, pageSize: 20 })
  })
})

/**
 * 五条会切换查询条件的入口（都调 reset 请求）。
 * 它们与 loadList/loadByTag 共用同一套 page/hasMore，任何一条忘了归位，
 * 下一次触底就会拿新条件去请求旧分支的页码。
 */
describe('#181 查询条件切换时的分页归位', () => {
  function primeSecondPage(page: Record<string, any>) {
    // 把页面置成「默认列表已加载到第 2 页」
    page.data.results = [customerRow('u1'), customerRow('u2')]
    page.data.page = 2
    page.data.hasMore = true
  }

  test.each([
    ['onStatTap（统计卡片）', (p: Record<string, any>) => p.onStatTap({ currentTarget: { dataset: { tag: 'active' } } }), 'customer.listByTag'],
    ['onSearch（关键词）', (p: Record<string, any>) => { p.data.searchKeyword = '张'; return p.onSearch() }, 'customer.search'],
    ['onSearchChange（清空关键词）', (p: Record<string, any>) => {
      // 必须先造出「有关键词」的现场，否则这条只是在验证默认态又请求了一次第 1 页
      p.data.searchKeyword = '张'
      p.data.searched = true
      return p.onSearchChange({ detail: '' })
    }, 'customer.search'],
    ['onAdvancedFilterTap（拓展筛选）', (p: Record<string, any>) => p.onAdvancedFilterTap({ currentTarget: { dataset: { dim: 'spendingTier', value: '10W+' } } }), 'customer.search'],
    ['onResetFilters（重置）', (p: Record<string, any>) => p.onResetFilters(), 'customer.search'],
  ])('%s 成功时请求第 1 页且分页状态归位', async (_name, act, expectedAction) => {
    const page = createPage('customerList')
    primeSecondPage(page)
    vi.mocked(callStaffApi).mockResolvedValue(
      (expectedAction === 'customer.listByTag'
        ? { customers: [customerRow('n1')], total: 1 }
        : pageEnvelope(['n1'], 1, false)) as never,
    )

    await act(page)

    const call = vi.mocked(callStaffApi).mock.calls.find(([action]) => action === expectedAction)
    expect(call, `${_name} 应发起 ${expectedAction}`).toBeTruthy()
    expect(call![1]).toMatchObject({ page: 1 })
    expect(page.data.page).toBe(1)
    expect(page.data.results.map((r: any) => r.clientUserId)).toEqual(['n1'])
    if (_name.startsWith('onSearchChange')) {
      // 关键词清空后请求不得再带 keyword，searched 也要归位
      expect(call![1]).not.toHaveProperty('keyword')
      expect(page.data.searched).toBe(false)
    }
  })

  /**
   * codex 谱系命中的 P1：reset 请求失败后，查询条件已经切成新的，屏幕上留的却是旧数据。
   * 若此时保留旧 page/hasMore，下一次触底会用**新条件**请求 page+1 ——
   * 既跳过新条件的第 1 页，又把两种条件的数据混进同一个列表。
   */
  test.each([
    ['切到标签筛选失败', (p: Record<string, any>) => p.onStatTap({ currentTarget: { dataset: { tag: 'active' } } })],
    ['切到关键词搜索失败', (p: Record<string, any>) => { p.data.searchKeyword = '张'; return p.onSearch() }],
    ['切到拓展筛选失败', (p: Record<string, any>) => p.onAdvancedFilterTap({ currentTarget: { dataset: { dim: 'spendingTier', value: '10W+' } } })],
  ])('%s 后必须掐断触底（page=1 / hasMore=false）', async (_name, act) => {
    const page = createPage('customerList')
    primeSecondPage(page)
    vi.mocked(callStaffApi).mockRejectedValue(new Error('网络异常'))

    await act(page)

    expect(page.data.page).toBe(1)
    expect(page.data.hasMore).toBe(false)
    expect(page.data.results).toEqual([])      // 旧条件的数据不得留在屏幕上冒充新结果
    expect(page.data.listError).toBe(true)     // 与「该分类确实没有顾客」区分开
    expect(toastCalls.map((t) => t.title)).toContain('网络异常')

    // 再触底不得发请求（hasMore 已为 false）
    vi.clearAllMocks()
    page.onReachBottom()
    expect(callStaffApi).not.toHaveBeenCalled()
  })
})
