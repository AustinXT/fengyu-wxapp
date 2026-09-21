/**
 * utils/cover-window 测试（issue #248）
 *
 * 核心不变量：页面同时挂载的 <image> 数量由视口窗口决定，与列表长度无关；
 * 且 observer 一旦不可用必须 fail-open 回「整列显示」，绝不能让商品图全白。
 */

import {
  createCoverWindow,
  withInitialCoverVisible,
  INITIAL_COVER_VISIBLE_COUNT,
} from '../../utils/cover-window'

const FLUSH_DELAY_MS = 50
const FALLBACK_DELAY_MS = 800

/** 最小 Page 替身：setData 支持 `list[i].coverVisible` 路径写法 */
function makePage(listKey: string, length: number) {
  const list = Array.from({ length }, (_, i) => ({
    product_id: `p${i}`,
    cover_image: 'https://cdn/x.jpg',
    coverVisible: false,
  }))
  const page = {
    data: { [listKey]: list } as Record<string, any>,
    setDataCalls: [] as Record<string, any>[],
    setData(patch: Record<string, any>) {
      page.setDataCalls.push(patch)
      Object.keys(patch).forEach((path) => {
        const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(path)
        if (m) {
          page.data[m[1]][Number(m[2])][m[3]] = patch[path]
          return
        }
        page.data[path] = patch[path]
      })
    },
  }
  return page
}

const OPTS = {
  scrollSelector: '.product-scroll',
  slotSelector: '.spu-cover-slot',
  listKey: 'spuList',
}

/** 模拟 observer 对某个下标的相交回调 */
function emit(idx: number, intersecting: boolean) {
  emitOn((wx as any).__lastObserver(), idx, intersecting)
}

/** 指定某个（可能已过期的）observer 发回调 */
function emitOn(ob: any, idx: number, intersecting: boolean) {
  ob.callback({ dataset: { idx: String(idx) }, intersectionRatio: intersecting ? 0.5 : 0 })
}

beforeEach(() => {
  ;(wx as any).__resetObservers()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('withInitialCoverVisible', () => {
  test('首屏前若干条预置为可见，避免打开页面先闪一下占位', () => {
    const rows = withInitialCoverVisible(Array.from({ length: 10 }, (_, i) => ({ id: i })), 0)
    expect(rows.slice(0, INITIAL_COVER_VISIBLE_COUNT).every(r => (r as any).coverVisible)).toBe(true)
    expect(rows.slice(INITIAL_COVER_VISIBLE_COUNT).every(r => (r as any).coverVisible === false)).toBe(true)
  })

  test('翻页追加的行都在屏幕外，一律不可见', () => {
    const rows = withInitialCoverVisible(Array.from({ length: 20 }, (_, i) => ({ id: i })), 20)
    expect(rows.every(r => (r as any).coverVisible === false)).toBe(true)
  })

  test('不改写原数组', () => {
    const src = [{ id: 1 }]
    const out = withInitialCoverVisible(src, 0)
    expect(src[0]).not.toHaveProperty('coverVisible')
    expect(out[0]).toHaveProperty('coverVisible', true)
  })
})

describe('createCoverWindow · 观察器接线', () => {
  test('按配置的滚动容器与槽位选择器建观察，并开启 observeAll', () => {
    const page = makePage('spuList', 5)
    createCoverWindow(page as any, OPTS).refresh()

    const ob = (wx as any).__lastObserver()
    expect(ob.options).toEqual({ observeAll: true })
    expect(ob.relativeToSelector).toBe('.product-scroll')
    expect(ob.relativeToMargins).toEqual({ top: 600, bottom: 600 })
    expect(ob.observeSelector).toBe('.spu-cover-slot')
  })

  test('空列表不建观察器（没有节点可观察）', () => {
    const page = makePage('spuList', 0)
    createCoverWindow(page as any, OPTS).refresh()
    expect((wx as any).__getObservers()).toHaveLength(0)
  })

  test('列表变化后 refresh 重建：observeAll 不跟踪新增节点', () => {
    const page = makePage('spuList', 5)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const first = (wx as any).__lastObserver()

    w.refresh()
    expect(first.disconnected).toBe(true)
    expect((wx as any).__getObservers()).toHaveLength(2)
  })

  test('dispose 断开观察器并清掉待处理的定时器', () => {
    const page = makePage('spuList', 5)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    emit(0, true)

    w.dispose()
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)

    expect((wx as any).__lastObserver().disconnected).toBe(true)
    expect(page.setDataCalls).toHaveLength(0)
  })
})

describe('createCoverWindow · 窗口内外切换', () => {
  test('进入窗口置 true、离开窗口置 false —— 挂载的封面数与列表长度无关', () => {
    const page = makePage('spuList', 200)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()

    // 200 行里只有 3 行进窗口
    ;[10, 11, 12].forEach(i => emit(i, true))
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    const visible = (page.data.spuList as any[]).filter(r => r.coverVisible)
    expect(visible).toHaveLength(3)

    // 滚走：同样三行离开窗口
    ;[10, 11, 12].forEach(i => emit(i, false))
    vi.advanceTimersByTime(FLUSH_DELAY_MS)
    expect((page.data.spuList as any[]).filter(r => r.coverVisible)).toHaveLength(0)
  })

  test('连续回调聚合成一次 setData', () => {
    const page = makePage('spuList', 30)
    createCoverWindow(page as any, OPTS).refresh()

    for (let i = 0; i < 10; i++) emit(i, true)
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    expect(page.setDataCalls).toHaveLength(1)
    expect(Object.keys(page.setDataCalls[0])).toHaveLength(10)
  })

  test('状态没变化就不发 setData', () => {
    const page = makePage('spuList', 5)
    createCoverWindow(page as any, OPTS).refresh()

    emit(0, false) // 初值本来就是 false
    vi.advanceTimersByTime(FLUSH_DELAY_MS)
    expect(page.setDataCalls).toHaveLength(0)
  })

  test('回调下标越界（列表已被换掉）直接丢弃，不写出界', () => {
    const page = makePage('spuList', 3)
    createCoverWindow(page as any, OPTS).refresh()

    emit(99, true)
    emit(-1, true)
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    expect(page.setDataCalls).toHaveLength(0)
    expect(page.data.spuList).toHaveLength(3)
  })

  test('dataset.idx 不是数字时忽略，不把 NaN 写进路径', () => {
    const page = makePage('spuList', 3)
    createCoverWindow(page as any, OPTS).refresh()

    const ob = (wx as any).__lastObserver()
    ob.callback({ dataset: {}, intersectionRatio: 1 })
    ob.callback({ dataset: { idx: 'x' }, intersectionRatio: 1 })
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    expect(page.setDataCalls).toHaveLength(0)
  })
})

describe('createCoverWindow · fail-open', () => {
  test('守护期内没有任何回调 → 整列显示封面（退回改造前的行为）', () => {
    const page = makePage('spuList', 8)
    createCoverWindow(page as any, OPTS).refresh()

    vi.advanceTimersByTime(FALLBACK_DELAY_MS)

    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
    expect((wx as any).__lastObserver().disconnected).toBe(true)
  })

  test('收到过回调就不触发 fail-open', () => {
    const page = makePage('spuList', 8)
    createCoverWindow(page as any, OPTS).refresh()

    emit(0, true)
    vi.advanceTimersByTime(FALLBACK_DELAY_MS)

    const visible = (page.data.spuList as any[]).filter(r => r.coverVisible)
    expect(visible).toHaveLength(1)
    expect((wx as any).__lastObserver().disconnected).toBe(false)
  })

  test('createIntersectionObserver 抛错 → 立即整列显示，不留半白页面', () => {
    const page = makePage('spuList', 8)
    ;(wx as any).__setObserverFactoryThrows(true)

    createCoverWindow(page as any, OPTS).refresh()

    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
  })

  test('工厂抛错是确定性的能力缺失 → 永久停用，之后不再重建观察器', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    ;(wx as any).__setObserverFactoryThrows(true)
    w.refresh()

    ;(wx as any).__setObserverFactoryThrows(false)
    w.refresh()

    expect((wx as any).__getObservers()).toHaveLength(0)
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
  })

  // 「零回调」不等于 observer 不可用：目标滚动容器被 wx:if 切走（home 进入搜索模式）时
  // 同样一个回调都收不到。若就此永久停用，用户退出搜索后解码硬上限会被整场会话关掉。
  test('零回调只放开本轮，下一次 refresh 仍重新尝试建观察器', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    vi.advanceTimersByTime(FALLBACK_DELAY_MS)
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)

    w.refresh()
    expect((wx as any).__getObservers()).toHaveLength(2)

    // 新观察器正常工作：窗口外的卡片重新被卸载
    emit(0, true)
    for (let i = 1; i < 8; i++) emit(i, false)
    vi.advanceTimersByTime(FLUSH_DELAY_MS)
    expect((page.data.spuList as any[]).filter(r => r.coverVisible)).toHaveLength(1)
  })

  test('第一轮收到过回调，不妨碍后续某一轮零回调时再次 fail-open', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    emit(0, true)
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)

    // 第二轮一个回调都不给
    w.refresh()
    vi.advanceTimersByTime(FALLBACK_DELAY_MS)

    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
  })

  test('relativeTo/observe 抛错算瞬态：本轮放开，下轮仍重试，且不泄漏半构造的 observer', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    ;(wx as any).__setObserverWiringThrows(true)
    w.refresh()

    const broken = (wx as any).__lastObserver()
    expect(broken.disconnected).toBe(true)            // 已创建的原生 observer 必须收掉
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)

    ;(wx as any).__setObserverWiringThrows(false)
    w.refresh()
    expect((wx as any).__lastObserver().observeSelector).toBe('.spu-cover-slot')
  })
})

// 两个谱系的评审独立命中：`disconnect()` 拦不住已经进了事件队列的旧回调
describe('createCoverWindow · 世代校验', () => {
  test('旧世代回调不得把可见性写进新列表', () => {
    const page = makePage('spuList', 50)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    // 换了一批商品（切分类），新一轮观察器就位
    w.refresh()

    // 旧观察器的在队回调这时才执行
    emitOn(stale, 12, true)
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    expect(page.setDataCalls).toHaveLength(0)
    expect((page.data.spuList as any[])[12].coverVisible).toBe(false)
  })

  test('旧世代回调不得清掉新世代的 fail-open 守护定时器', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    // 新一轮观察器注定零回调（例如建在被 wx:if 切走的列表上），守护定时器是唯一兜底
    w.refresh()
    emitOn(stale, 0, false)

    vi.advanceTimersByTime(FALLBACK_DELAY_MS)

    // 守护没被旧回调误杀 → 整列放开，而不是永久停在占位图
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
  })

  // fail-open 之后既没有 observer 也没有守护定时器，旧回调再把行写回 false 就永久停在占位图
  test('fail-open 放开整列后，旧观察器的在队回调不得把行写回 false', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    vi.advanceTimersByTime(FALLBACK_DELAY_MS)
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)

    emitOn(stale, 3, false)
    vi.advanceTimersByTime(FLUSH_DELAY_MS)

    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)
  })

  test('接线失败放开整列后不留可回调的残骸，且不起守护定时器', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    ;(wx as any).__setObserverWiringThrows(true)
    w.refresh()

    const broken = (wx as any).__lastObserver()
    expect(broken.callback).toBeNull()      // observe 没跑成，没有回调能再写脏数据
    expect(broken.disconnected).toBe(true)  // 但原生 observer 已经建出来了，必须收掉
    expect((page.data.spuList as any[]).every(r => r.coverVisible)).toBe(true)

    const calls = page.setDataCalls.length
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)
    expect(page.setDataCalls).toHaveLength(calls)
  })

  test('invalidate 换代但不重建：setData 换列表前用它掐掉旧回调', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    w.invalidate()
    expect(stale.disconnected).toBe(true)
    expect((wx as any).__getObservers()).toHaveLength(1) // 没有重建

    emitOn(stale, 0, true)
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)
    expect(page.setDataCalls).toHaveLength(0)
  })

  test('dispose 之后的在队回调不再重新武装定时器', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    w.dispose()
    emitOn(stale, 3, true)
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)

    expect(page.setDataCalls).toHaveLength(0)
  })
})

describe('createCoverWindow · 页面显隐', () => {
  test('隐藏期间的 refresh 不建观察器（不渲染的页面注定零回调，会误触 fail-open）', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.setVisible(false)

    w.refresh()
    vi.advanceTimersByTime(FALLBACK_DELAY_MS)

    expect((wx as any).__getObservers()).toHaveLength(0)
    expect(page.setDataCalls).toHaveLength(0)
    expect((page.data.spuList as any[]).every(r => r.coverVisible === false)).toBe(true)
  })

  test('setVisible(false) 拆掉当前接线并换代', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.refresh()
    const stale = (wx as any).__lastObserver()

    w.setVisible(false)
    expect(stale.disconnected).toBe(true)

    emitOn(stale, 0, true)
    vi.advanceTimersByTime(FALLBACK_DELAY_MS + FLUSH_DELAY_MS)
    expect(page.setDataCalls).toHaveLength(0)
  })

  test('setVisible(true) 不自动 refresh —— 由页面决定给哪份列表接线', () => {
    const page = makePage('spuList', 8)
    const w = createCoverWindow(page as any, OPTS)
    w.setVisible(false)
    w.setVisible(true)
    expect((wx as any).__getObservers()).toHaveLength(0)

    w.refresh()
    expect((wx as any).__getObservers()).toHaveLength(1)
  })
})
