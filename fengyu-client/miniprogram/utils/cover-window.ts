// utils/cover-window.ts —— 商品列表封面的「视口窗口」加载/卸载（issue #248）

/**
 * 背景：#230 给单张封面的解码内存封了顶（1080 box ≈ 4.45MiB/张），但那是 per-image
 * 不是 per-page——商品列表平铺 N 张图，解码总量仍是 O(N)。`lazy-load` 只延迟加载、
 * 不卸载，压得住打开页面瞬间的峰值，压不住滑到底后的累计驻留。
 *
 * 本模块用 IntersectionObserver 把「哪些卡片该挂 <image>」限制在视口上下各扩 margin px
 * 的窗口内，滚远的卡片把 `coverVisible` 置回 false（wxml 渲染成占位图标）。
 * 于是页面同时驻留的解码量 = 窗口内张数 × 单张上限，**与商品总数无关**。
 *
 * 包裹节点 `.spu-cover-slot` 尺寸固定且不随 coverVisible 变化，
 * 所以卡片高度、滚动位置零抖动，回滚时封面自动恢复。
 *
 * ## 调用契约（三条都不能省）
 * 1. `refresh()` 必须在 `setData` 的**渲染完成回调**里调，不能同步调 ——
 *    同步调会 observe 到旧 DOM，`observeAll` 拿不到新节点。
 * 2. 列表内容一变就要 `refresh()`：`observeAll` 不跟踪后续新增的节点。
 * 3. 页面隐藏/显示要调 `setVisible()`，卸载要调 `dispose()`。隐藏期间收到网络回包
 *    而不打招呼的话，observer 会建在不渲染的页面上、一个回调都收不到。
 */

/** 视口上下各扩展的像素数：一屏左右的预加载余量，滚动时不会看到占位闪烁 */
const DEFAULT_MARGIN = 600

/** 回调聚合窗口：快速滚动时 observer 会连续回调，攒一批只发一次 setData */
const FLUSH_DELAY_MS = 50

/**
 * fail-open 守护时长。observe 之后这么久一次回调都没收到，就退回改造前的行为
 * （整列显示封面）——「商品图全白」比「多解码几张图」严重得多。
 *
 * ⚠️ 这种「静默」是**可恢复**的，只在本轮放开，下一次 refresh 仍会重新尝试建观察器。
 * 零回调不等于 observer 不可用：目标滚动容器被 `wx:if` 切走、或页面处于隐藏态时
 * 同样一个回调都收不到，若就此永久停用，解码硬上限会被整场会话关掉且毫无痕迹。
 * 只有 `wx.createIntersectionObserver` **本身抛错**才是确定性的能力缺失。
 */
const FALLBACK_DELAY_MS = 800

/**
 * 新列表首屏直接标可见的条数。
 * 不做这个预置的话，首屏会先渲染占位、等 observer 回调后才换成图，肉眼可见地闪一下。
 * 6 条在常见机型上约 1.7~1.8 屏（home 卡片 172rpx/张、shop 约 346rpx/张）。
 */
export const INITIAL_COVER_VISIBLE_COUNT = 6

const FLAG = 'coverVisible'

/** 只依赖 Page 实例的这两个成员，便于单测注入假页面 */
interface PageLike {
  data: Record<string, any>;
  setData(data: Record<string, any>, callback?: () => void): void;
}

export interface CoverWindowOptions {
  /** 滚动容器选择器，作为相交判定的参照系（如 '.product-scroll'） */
  scrollSelector: string;
  /** 封面槽位选择器，每张卡片一个，必须带 `data-idx="{{index}}"` */
  slotSelector: string;
  /** 页面 data 里的列表字段名（如 'spuList' / 'searchResults'） */
  listKey: string;
  /** 视口上下扩展像素，默认 600 */
  margin?: number;
}

export interface CoverWindow {
  /** 列表内容变化（换分类 / 翻页追加 / 搜索结果刷新）后必须调用，且要在 setData 渲染回调里 */
  refresh(): void;
  /**
   * 页面显隐。隐藏时断开观察器（不渲染的页面收不到相交回调，硬撑只会误触发 fail-open），
   * 显示时由页面自行决定给哪份列表 `refresh()`。
   */
  setVisible(visible: boolean): void;
  /** 页面卸载时调用 */
  dispose(): void;
}

/**
 * 给一批行补上 `coverVisible` 初值。
 *
 * @param startIndex 这批行在整个列表中的起始下标。首屏传 0（前若干条直接可见）；
 *                   触底追加时传当前列表长度——追加的行都在屏幕外，一律 false。
 */
export function withInitialCoverVisible<T extends Record<string, any>>(
  rows: T[],
  startIndex = 0
): T[] {
  return rows.map((row, i) => ({
    ...row,
    [FLAG]: startIndex + i < INITIAL_COVER_VISIBLE_COUNT,
  }));
}

export function createCoverWindow(page: PageLike, options: CoverWindowOptions): CoverWindow {
  const margin = options.margin ?? DEFAULT_MARGIN;

  let observer: WechatMiniprogram.IntersectionObserver | null = null;
  let pending: Record<number, boolean> = {};
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let visible = true;
  /** 仅由 `wx.createIntersectionObserver` 抛错置位：环境确定性不支持，永久停用 */
  let unsupported = false;

  /**
   * 观察器世代。每次 refresh / setVisible(false) / dispose 都换代。
   *
   * ⚠️ 这是整个模块最关键的一个状态。`disconnect()` 拦不住**已经进了事件队列**的旧回调：
   * 它执行时面对的是新一代的世界，会把旧列表的下标写进新列表（同下标是不同商品，
   * 越界检查看不出来），还会把新一代的 fail-open 守护定时器当成自己的清掉 ——
   * 后者更糟：新观察器若恰好注定零回调（比如建在被 wx:if 切走的列表上），
   * 守护被误杀就再也没人兜底，整列永久停在占位图。
   */
  let generation = 0;

  function getList(): any[] | null {
    const list = page.data?.[options.listKey];
    return Array.isArray(list) ? list : null;
  }

  function flush(gen: number) {
    if (gen !== generation) return;
    flushTimer = null;
    const list = getList();
    const buffered = pending;
    pending = {};
    if (!list) return;

    const patch: Record<string, boolean> = {};
    Object.keys(buffered).forEach((key) => {
      const idx = Number(key);
      // 列表可能在回调到达前已被换掉（切分类），越界的下标直接丢弃
      if (idx < 0 || idx >= list.length) return;
      const want = buffered[idx];
      if (Boolean(list[idx]?.[FLAG]) === want) return;
      patch[`${options.listKey}[${idx}].${FLAG}`] = want;
    });

    if (Object.keys(patch).length > 0) page.setData(patch);
  }

  function scheduleFlush(gen: number) {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => flush(gen), FLUSH_DELAY_MS);
  }

  /** fail-open：整列显示封面，等价于改造前的行为 */
  function showAll() {
    const list = getList();
    if (!list || list.length === 0) return;
    const patch: Record<string, boolean> = {};
    list.forEach((item, idx) => {
      if (!item?.[FLAG]) patch[`${options.listKey}[${idx}].${FLAG}`] = true;
    });
    if (Object.keys(patch).length > 0) page.setData(patch);
  }

  function clearTimers() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function disconnect() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  /** 换代 + 拆掉当前这一轮的全部接线 */
  function teardown() {
    generation++;
    clearTimers();
    disconnect();
    pending = {};
  }

  function refresh() {
    if (unsupported) {
      showAll();
      return;
    }
    // 隐藏的页面不渲染，observer 注定零回调。此时建观察器只会在 800ms 后误触发
    // fail-open 把整列放开；等 setVisible(true) 时页面会重新接线。
    if (!visible) return;

    // observeAll 不会自动跟踪后续新增的节点，列表一变就得整个重建
    teardown();
    const gen = generation;

    const list = getList();
    if (!list || list.length === 0) return;

    let created: WechatMiniprogram.IntersectionObserver;
    try {
      created = wx.createIntersectionObserver(page as any, { observeAll: true });
    } catch (err) {
      // 工厂抛错 = 环境不支持，确定性的，永久停用
      console.warn('[cover-window] observer 创建失败，退回整列显示', err);
      unsupported = true;
      showAll();
      return;
    }

    try {
      created.relativeTo(options.scrollSelector, { top: margin, bottom: margin });
      created.observe(options.slotSelector, (res) => {
        // 旧世代的在队回调整段丢弃：既不写 pending，也不碰新世代的守护定时器
        if (gen !== generation) return;
        // 收到第一个回调就撤掉 fail-open 守护：本轮观察器已被证明在工作
        if (fallbackTimer !== null) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        const idx = Number((res as any).dataset?.idx);
        if (!Number.isInteger(idx)) return;
        pending[idx] = res.intersectionRatio > 0;
        scheduleFlush(gen);
      });
      observer = created;
    } catch (err) {
      // relativeTo / observe 抛错多是节点未上树之类的瞬态原因，不代表环境不支持。
      // 但 created 已经是个真实的原生 observer，不收掉就泄漏了。
      console.warn('[cover-window] observer 接线失败，本轮退回整列显示', err);
      try {
        created.disconnect();
      } catch (_) {
        /* 已经坏掉的 observer 收不掉也没别的办法 */
      }
      showAll();
      return;
    }

    fallbackTimer = setTimeout(() => {
      if (gen !== generation) return;
      fallbackTimer = null;
      // 只放开本轮，不置 unsupported —— 下次 refresh 仍会重新尝试
      console.warn('[cover-window] 本轮未收到相交回调，暂退回整列显示');
      disconnect();
      showAll();
    }, FALLBACK_DELAY_MS);
  }

  function setVisible(next: boolean) {
    if (visible === next) return;
    visible = next;
    // 隐藏时只拆接线、保留 unsupported；显示后由页面决定给哪份列表 refresh
    if (!next) teardown();
  }

  function dispose() {
    teardown();
  }

  return { refresh, setVisible, dispose };
}
