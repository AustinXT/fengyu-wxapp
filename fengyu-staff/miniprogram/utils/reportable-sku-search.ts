// utils/reportable-sku-search.ts — 门店报货选品弹层的检索状态机（#339）
//
// 从 packageMy/inventory/form.ts 抽出来，是为了让「防抖 / 翻页追加 / 丢弃过期响应 / 到底判定」
// 能脱离 Page 与 wx 运行时单测：页面只负责把 state 补丁 setData、把请求转给 staffApi。

/** 每页条数；staffApi reportableSkuOptions 上限 100 */
export const SKU_PAGE_SIZE = 20
/** 关键词防抖：逐字输入不逐字发请求 */
export const SKU_SEARCH_DEBOUNCE_MS = 300

export interface SkuSearchState<T> {
  skuOptions: T[]
  skuPage: number
  skuTotal: number
  skuHasMore: boolean
  skuLoading: boolean
  skuError: string
}

export interface SkuSearchDeps<T> {
  /** 取一页；调用方负责拼 locationId 与映射展示字段 */
  fetchPage: (keyword: string, page: number) => Promise<{ items: T[]; total: number }>
  /** 把状态补丁交给页面 setData */
  onState: (patch: Partial<SkuSearchState<T>>) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * 满页才可能还有下一页：total 统计与列表口径万一漂移（或翻页期间有新数据插入被去重掉），
 * 只看 length < total 会让上拉永远停不下来。
 */
export function hasMoreSkuPages(loaded: number, total: number, incoming: number): boolean {
  return loaded < total && incoming === SKU_PAGE_SIZE
}

export class ReportableSkuSearch<T extends { skuId: string }> {
  private seq = 0
  private timer: unknown = null
  private keyword = ''
  private options: T[] = []
  private page = 0
  private loading = false
  private hasMore = true
  private error = ''

  constructor(private readonly deps: SkuSearchDeps<T>) {}

  get state() {
    return { page: this.page, loading: this.loading, hasMore: this.hasMore, error: this.error }
  }

  /** 关键词输入：防抖后从第 1 页重查 */
  onKeyword(value: string) {
    this.keyword = value
    this.clearPendingTimer()
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.timer = set(() => {
      this.timer = null
      this.load(true)
    }, SKU_SEARCH_DEBOUNCE_MS)
  }

  /** 清空关键词：立即重查，并取消还没触发的防抖 */
  clearKeyword() {
    this.keyword = ''
    this.clearPendingTimer()
    this.load(true)
  }

  /** 打开弹层：首次打开时拉第一页（首页请求仍在途就不重复发） */
  open() {
    if (this.page === 0 && !this.loading) this.load(true)
  }

  /** 上拉 / 点「加载更多」 */
  loadMore() {
    if (this.loading || !this.hasMore || this.error) return
    this.load(false)
  }

  /** 失败后重试：第 N 页失败只重试那一页，不清掉已加载的 */
  retry() {
    if (this.loading) return
    this.load(this.page === 0)
  }

  /** 页面卸载：取消防抖并作废在途请求 */
  dispose() {
    this.clearPendingTimer()
    this.seq += 1
  }

  private clearPendingTimer() {
    if (this.timer === null) return
    const clear = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    clear(this.timer)
    this.timer = null
  }

  private async load(reset: boolean) {
    const seq = ++this.seq
    const page = reset ? 1 : this.page + 1
    this.loading = true
    this.error = ''
    const patch: Partial<SkuSearchState<T>> = { skuLoading: true, skuError: '' }
    if (reset) {
      this.options = []
      this.page = 0
      this.hasMore = true
      Object.assign(patch, { skuOptions: [], skuPage: 0, skuTotal: 0, skuHasMore: true })
    }
    this.deps.onState(patch)
    try {
      const res = await this.deps.fetchPage(this.keyword.trim(), page)
      if (seq !== this.seq) return
      const incoming = res.items || []
      const seen = new Set(this.options.map((item) => item.skuId))
      this.options = this.options.concat(incoming.filter((item) => !seen.has(item.skuId)))
      const total = Number(res.total || 0)
      this.page = page
      this.hasMore = hasMoreSkuPages(this.options.length, total, incoming.length)
      this.deps.onState({ skuOptions: this.options, skuPage: page, skuTotal: total, skuHasMore: this.hasMore })
    } catch (err: any) {
      if (seq !== this.seq) return
      this.error = err?.message || '加载可报货产品失败'
      this.deps.onState({ skuError: this.error })
    } finally {
      if (seq === this.seq) {
        this.loading = false
        this.deps.onState({ skuLoading: false })
      }
    }
  }
}
