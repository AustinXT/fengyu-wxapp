import { hasMoreSkuPages, ReportableSkuSearch, SKU_PAGE_SIZE, SKU_SEARCH_DEBOUNCE_MS } from '../../utils/reportable-sku-search'

type Sku = { skuId: string }
const page = (from: number, count: number): Sku[] => Array.from({ length: count }, (_, i) => ({ skuId: `S${from + i}` }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup() {
  const fetchPage = vi.fn<(keyword: string, page: number) => Promise<{ items: Sku[]; total: number }>>()
  const state: Record<string, unknown> = {}
  const search = new ReportableSkuSearch<Sku>({ fetchPage, onState: (patch) => Object.assign(state, patch) })
  return { fetchPage, state, search }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('门店报货选品检索（#339）', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  test('关键词防抖：连续输入只在停顿 300ms 后发一次请求，且带最后的关键词', async () => {
    const { fetchPage, search } = setup()
    fetchPage.mockResolvedValue({ items: [], total: 0 })
    search.onKeyword('凝')
    search.onKeyword('凝胶')
    search.onKeyword('凝胶 ')
    vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS - 1)
    expect(fetchPage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith('凝胶', 1)
  })

  test('上拉加载第 2 页：追加去重；不满一页即到底', async () => {
    const { fetchPage, state, search } = setup()
    fetchPage
      .mockResolvedValueOnce({ items: page(0, SKU_PAGE_SIZE), total: 25 })
      .mockResolvedValueOnce({ items: [...page(19, 1), ...page(20, 5)], total: 25 })
    search.open()
    vi.useRealTimers(); await flush()
    expect(state.skuHasMore).toBe(true)
    search.loadMore()
    await flush()
    expect(fetchPage).toHaveBeenLastCalledWith('', 2)
    expect((state.skuOptions as Sku[]).map((s) => s.skuId)).toEqual(page(0, 25).map((s) => s.skuId))
    expect(state.skuPage).toBe(2)
    expect(state.skuHasMore).toBe(false)
    search.loadMore()
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  test('先发后到的旧关键词结果被丢弃，loading 由最后一次请求收尾', async () => {
    const { fetchPage, state, search } = setup()
    const slow = deferred<{ items: Sku[]; total: number }>()
    fetchPage.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ items: [{ skuId: 'NEW' }], total: 1 })
    search.open()
    search.clearKeyword()
    vi.useRealTimers(); await flush()
    slow.resolve({ items: [{ skuId: 'OLD' }], total: 1 })
    await flush()
    expect((state.skuOptions as Sku[]).map((s) => s.skuId)).toEqual(['NEW'])
    expect(state.skuLoading).toBe(false)
  })

  test('首页在途时重复打开不重复请求；第 N 页失败只重试那一页', async () => {
    const { fetchPage, state, search } = setup()
    const first = deferred<{ items: Sku[]; total: number }>()
    fetchPage.mockReturnValueOnce(first.promise)
    search.open()
    search.open()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    first.resolve({ items: page(0, SKU_PAGE_SIZE), total: 30 })
    vi.useRealTimers(); await flush()
    fetchPage.mockRejectedValueOnce(new Error('网络异常'))
    search.loadMore()
    await flush()
    expect(state.skuError).toBe('网络异常')
    expect((state.skuOptions as Sku[]).length).toBe(SKU_PAGE_SIZE)
    search.loadMore() // 有错误时上拉不再自动翻页
    expect(fetchPage).toHaveBeenCalledTimes(2)
    fetchPage.mockResolvedValueOnce({ items: page(20, 10), total: 30 })
    search.retry()
    await flush()
    expect(fetchPage).toHaveBeenLastCalledWith('', 2)
    expect((state.skuOptions as Sku[]).length).toBe(30)
    expect(state.skuError).toBe('')
  })

  test('卸载后：防抖取消、在途结果不再回写', async () => {
    const { fetchPage, state, search } = setup()
    const gate = deferred<{ items: Sku[]; total: number }>()
    fetchPage.mockReturnValueOnce(gate.promise)
    search.open()
    search.onKeyword('凝胶')
    search.dispose()
    vi.advanceTimersByTime(SKU_SEARCH_DEBOUNCE_MS)
    expect(fetchPage).toHaveBeenCalledTimes(1)
    const before = { ...state }
    gate.resolve({ items: [{ skuId: 'LATE' }], total: 1 })
    vi.useRealTimers(); await flush()
    expect(state).toEqual(before)
  })

  test('hasMoreSkuPages：total 口径漂移时不会无限上拉', () => {
    expect(hasMoreSkuPages(20, 100, SKU_PAGE_SIZE)).toBe(true)
    expect(hasMoreSkuPages(21, 100, 1)).toBe(false)
    expect(hasMoreSkuPages(40, 40, SKU_PAGE_SIZE)).toBe(false)
  })
})

describe('门店报货页面接线（#339 源码守护）', () => {
  // 页面本身跑不了单测（Page / wx 运行时）；钉住它确实走状态机，且已选商品独立于检索结果保存
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const form = fs.readFileSync(path.resolve(__dirname, '../../packageMy/inventory/form.ts'), 'utf8')

  test('关键词 / 上拉 / 重试 / 卸载都交给 ReportableSkuSearch', () => {
    expect(form).toMatch(/this\.skuSearch\(\)\.onKeyword\(value\)/)
    expect(form).toMatch(/this\.skuSearch\(\)\.clearKeyword\(\)/)
    expect(form).toMatch(/onSkuListReachBottom\(\) \{\s*this\.skuSearch\(\)\.loadMore\(\)/)
    expect(form).toMatch(/this\._skuSearch\?\.dispose\(\)/)
    // 可报货 SKU 只有一处取数，且分页走状态机的 SKU_PAGE_SIZE（不再一次预拉 100 条）
    expect(form.match(/'inventory\.reportableSkuOptions'/g)).toHaveLength(1)
    expect(form).toMatch(/'inventory\.reportableSkuOptions',\s*\{[^}]*page, pageSize: SKU_PAGE_SIZE \}/)
  })

  test('已选商品存独立副本：换关键词后名称不依赖当前列表', () => {
    expect(form).toMatch(/selectedSku: \{ \.\.\.sku \}/)
  })
})
