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
 */

/** 视口上下各扩展的像素数：一屏左右的预加载余量，滚动时不会看到占位闪烁 */
const DEFAULT_MARGIN = 600

/** 回调聚合窗口：快速滚动时 observer 会连续回调，攒一批只发一次 setData */
const FLUSH_DELAY_MS = 50

/**
 * fail-open 守护时长。observe 之后这么久一次回调都没收到，就判定 IntersectionObserver
 * 在当前环境不可用，退回改造前的行为（整列显示封面）并永久停用本模块。
 * 「商品图全白」比「多解码几张图」严重得多。
 */
const FALLBACK_DELAY_MS = 800

/**
 * 新列表首屏直接标可见的条数。
 * 不做这个预置的话，首屏会先渲染占位、等 observer 回调后才换成图，肉眼可见地闪一下。
 */
export const INITIAL_COVER_VISIBLE_COUNT = 6

const FLAG = 'coverVisible'

/** 只依赖 Page 实例的这两个成员，便于单测注入假页面 */
interface PageLike {
  data: Record<string, any>;
  setData(data: Record<string, any>): void;
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
  /** 列表内容变化（换分类 / 翻页追加 / 搜索结果刷新）后必须调用 */
  refresh(): void;
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
  let everGotCallback = false;
  let disabled = false;

  function getList(): any[] | null {
    const list = page.data?.[options.listKey];
    return Array.isArray(list) ? list : null;
  }

  function flush() {
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

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
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

  function refresh() {
    if (disabled) {
      showAll();
      return;
    }

    // observeAll 不会自动跟踪后续新增的节点，列表一变就得整个重建
    disconnect();
    clearTimers();
    pending = {};

    const list = getList();
    if (!list || list.length === 0) return;

    try {
      observer = wx
        .createIntersectionObserver(page as any, { observeAll: true })
        .relativeTo(options.scrollSelector, { top: margin, bottom: margin });
      observer.observe(options.slotSelector, (res) => {
        everGotCallback = true;
        const idx = Number((res as any).dataset?.idx);
        if (!Number.isInteger(idx)) return;
        pending[idx] = res.intersectionRatio > 0;
        scheduleFlush();
      });
    } catch (err) {
      console.warn('[cover-window] observer 创建失败，退回整列显示', err);
      disabled = true;
      disconnect();
      showAll();
      return;
    }

    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      if (everGotCallback) return;
      console.warn('[cover-window] 未收到相交回调，退回整列显示');
      disabled = true;
      disconnect();
      showAll();
    }, FALLBACK_DELAY_MS);
  }

  function dispose() {
    clearTimers();
    disconnect();
    pending = {};
  }

  return { refresh, dispose };
}
