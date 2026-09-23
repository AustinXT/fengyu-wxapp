/**
 * order-detail 页面 — 待支付倒计时（issue #215）
 *
 * 守两件事：
 *  1. 后端不下发 expire_at 时（员工开单单、有在途支付意图的自助单）页面不起倒计时，
 *     文案走 wxml 的兜底分支「请完成支付」，不出现「请在 xx 前完成支付」
 *  2. 「归零重载」不会死循环，且截止点过了之后页面不会承诺「可支付」。
 *     现行口径（17 轮评审收敛，详见 startCountdown 的 jsdoc 口径表）：
 *     权威正数正常计时 / 权威归零 → **只改文案** + 有界重试（收敛靠服务端补关）/
 *     非权威归零 → 每单只重载一次 / 墙钟跳变 → 校准，不改文案也不封。
 *     **本地判到期一律不封支付入口**，只有服务端的 expire_unresolved 才封。
 */

import { vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Toast from '@vant/weapp/toast/toast';

const callClientApiMock = vi.fn();
vi.mock('../../../utils/cloud', () => ({
  callClientApi: (...args: any[]) => callClientApiMock(...args),
  bindPhoneWithCloudID: vi.fn(),
  sanitizeErrorMessage: (msg: string) => msg,
}));

vi.mock('@vant/weapp/toast/toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), fail: vi.fn(), clear: vi.fn() }),
}));

/**
 * 支付确认轮询替身：把每个 poller 的 resolve 暴露出来，
 * 让用例能精确复现「onHide 调 poller.clear() → promise 被 resolve」这条时序。
 */
const pollerControls: Array<{ resolve: (v: any) => void }> = [];
vi.mock('../../../pagesOrder/utils/payment-poll', () => ({
  pollPaymentConfirm: () => {
    let resolveFn: (v: any) => void = () => {};
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    pollerControls.push({ resolve: resolveFn });
    return {
      promise,
      // 与真实实现一致：clear() 是 resolve 而不是 reject
      clear: () => resolveFn({ sessionCompleted: false }),
    };
  },
}));

let pageOptions: any = null;
(globalThis as any).Page = (opts: any) => {
  pageOptions = opts;
};
(globalThis as any).getApp = () => ({
  globalData: { boundStoreId: 'S001', userId: 'u-1', continuePayEnabled: false },
});

const wxMock: any = (globalThis as any).wx || {};
wxMock.navigateTo = vi.fn();
wxMock.navigateBack = vi.fn();
wxMock.showToast = vi.fn();
wxMock.setClipboardData = vi.fn();
wxMock.stopPullDownRefresh = vi.fn();
(globalThis as any).wx = wxMock;

beforeAll(async () => {
  await import('../../../pagesOrder/order-detail/order-detail');
});

/** 用例里创建的页面实例，afterEach 统一收表防止定时器漏到下一条 */
let livePages: any[] = [];

function createPageInstance(initialData: any = {}) {
  const instance: any = {
    data: { ...pageOptions.data, ...initialData },
    setData(patch: any) {
      Object.assign(this.data, patch);
    },
  };
  for (const key of Object.keys(pageOptions)) {
    if (key === 'data') continue;
    if (typeof pageOptions[key] === 'function') {
      instance[key] = pageOptions[key].bind(instance);
    } else {
      instance[key] = pageOptions[key];
    }
  }
  livePages.push(instance);
  return instance;
}

/** loadDetail 用替身，只关心 startCountdown 自身的行为 */
function createPageWithStubbedLoad() {
  const page = createPageInstance();
  const loadDetail = vi.fn(async () => {});
  page.loadDetail = loadDetail;
  return { page, loadDetail };
}

/** 两个并发用例共用：把 callClientApi 变成手动 resolve */
function createPageWithManualApi() {
  const page = createPageInstance();
  const resolvers: Array<(v: any) => void> = [];
  callClientApiMock.mockImplementation(
    () => new Promise((resolve) => { resolvers.push(resolve); }),
  );
  return { page, resolvers };
}

const detailResponse = (status: string) => ({
  order: { sale_order_id: 'FY-215', status },
  items: [],
  payments: [],
});

/** 旧云函数形态：只有绝对时间，没有 expire_in_ms（发版过渡期的回退分支） */
const PENDING_ORDER = (expireAt: string | null) => ({
  sale_order_id: 'FY-215',
  status: '待支付',
  expire_at: expireAt,
}) as any;

/** 新云函数形态：服务端下发剩余毫秒，倒计时按它走 */
const PENDING_ORDER_WITH_REMAINING = (expireInMs: number) => ({
  sale_order_id: 'FY-215',
  status: '待支付',
  expire_at: new Date(Date.now() + expireInMs).toISOString(),
  expire_in_ms: expireInMs,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  pollerControls.length = 0;
});

afterEach(() => {
  for (const p of livePages) {
    if (p._countdownTimer) clearTimeout(p._countdownTimer);
  }
  livePages = [];
});

describe('order-detail 待支付倒计时 (#215)', () => {
  test('后端不下发 expire_at（员工开单单）→ 不起倒计时、不装定时器、不重载', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();

    page.startCountdown(PENDING_ORDER(null));

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('下发未来的 expire_at（自助单）→ 渲染 MM:SS 并装定时器', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const future = new Date(Date.now() + 9 * 60 * 1000 + 30 * 1000).toISOString();

    page.startCountdown(PENDING_ORDER(future));

    expect(page.data.countdown).toMatch(/^09:(29|30)$/);
    expect(page._countdownTimer).not.toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('非待支付状态 → 不起倒计时', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();

    page.startCountdown({
      sale_order_id: 'FY-215',
      status: '已关闭',
      expire_at: new Date(Date.now() + 60_000).toISOString(),
    } as any);

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('装表即过期 → 只重载一次，不装定时器', () => {
    // 服务端**只在剩余量严格为正时**才下发 expire_in_ms，所以拿到 0 说明契约被破坏
    //（旧云函数、或补关被并发意图连续挤掉后的降级）—— 按非权威处理，
    // 走带一次性闸门的重载路径，而不是当成「服务端已经处理完了」永不重载。
    const { page, loadDetail } = createPageWithStubbedLoad();

    page.startCountdown(PENDING_ORDER_WITH_REMAINING(0));

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  test('反复装表（模拟 onShow/下拉）也只重载一次 —— 循环不可能形成', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();

    for (let i = 0; i < 10; i++) page.startCountdown(PENDING_ORDER_WITH_REMAINING(0));

    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  test('走着走着归零 → 重载一次并停表（假时钟跑满一拍）', () => {
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = createPageWithStubbedLoad();
      const soon = new Date(Date.now() + 1500).toISOString();

      page.startCountdown(PENDING_ORDER(soon));
      expect(loadDetail).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(loadDetail).toHaveBeenCalledWith('FY-215');
      expect(page._countdownTimer).toBeNull();
      expect(page.data.countdown).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('剩余不足 1 秒时显示 00:01 而不是 00:00', () => {
    // floor 会让 (0,1000) 毫秒这一拍渲染成 00:00，而订单此刻仍是待支付、
    // 「去支付」照样能点 —— 正是验收标准 3 要消灭的矛盾态
    vi.useFakeTimers();
    try {
      const { page } = createPageWithStubbedLoad();
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(1500));
      expect(page.data.countdown).toBe('00:02');

      vi.advanceTimersByTime(1000);   // 还剩 500ms
      expect(page.data.countdown).toBe('00:01');
    } finally {
      vi.useRealTimers();
    }
  });

  test('最后一拍恰好落在截止点上，截止后不会还显示 00:01', () => {
    // 固定 1000ms 的 setInterval 会让最后一拍晚到最多 999ms —— 那段时间页面还写着
    // 「剩余 00:01」而订单已过期，点「去支付」直接被后端拒（codex 评审 round-5 P1）
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = createPageWithStubbedLoad();
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(1500));
      expect(page.data.countdown).toBe('00:02');

      vi.advanceTimersByTime(500);          // 剩 1000ms
      expect(page.data.countdown).toBe('00:01');

      vi.advanceTimersByTime(1000);         // 恰好到截止点
      expect(page.data.countdown).toBe('');
      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page._countdownTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('整分钟边界不跳格：剩余 60s 显示 01:00', () => {
    const { page } = createPageWithStubbedLoad();
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(60_000));
    expect(page.data.countdown).toBe('01:00');
  });

  test('设备时钟比服务端快很多时，倒计时仍按服务端下发的剩余量走', () => {
    // 只比绝对时间的话，手机快 30 分钟就会把一个刚下发的时限判成「已过期」→
    // 自助单彻底看不到倒计时，而服务端根本还没打算关它。
    // ⚠️ 下面这个「已过期的 expire_at + 为正的 expire_in_ms」组合**生产不可达**
    //（两者同源、同条件下发，恒自洽），纯防御性构造，别依赖服务端会发这种形态。
    const { page, loadDetail } = createPageWithStubbedLoad();
    page.startCountdown({
      sale_order_id: 'FY-215',
      status: '待支付',
      // 绝对时间取「设备看来早已过去」的值
      expire_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      expire_in_ms: 9 * 60 * 1000,
    } as any);

    expect(page.data.countdown).toBe('09:00');
    expect(page._countdownTimer).not.toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('expire_in_ms 显式为 null 时回退到绝对时间口径，不当成「剩余 0」', () => {
    // `Number(null)` 是 0 且 isFinite —— 用 Number() 判别会把「字段缺席」
    // 静默当成「没时间了」，倒计时凭空消失
    const { page } = createPageWithStubbedLoad();
    page.startCountdown({
      sale_order_id: 'FY-215',
      status: '待支付',
      expire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      expire_in_ms: null,
    } as any);

    expect(page.data.countdown).toMatch(/^0[45]:/);
    expect(page._countdownTimer).not.toBeNull();
  });

  test('倒计时会扣掉下行耗时（网络残差的一半）', async () => {
    // 服务端给的是「生成响应那一刻」的剩余量，传到手上已经过去一段了；
    // 不扣的话倒计时比真实关单时刻晚，顾客会在还显示剩余时间时被拒付
    const { page, resolvers } = createPageWithManualApi();
    const inflight = page.loadDetail('FY-215');

    await new Promise((r) => setTimeout(r, 120));   // 模拟 120ms 网络耗时
    resolvers[0]({
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() + 60_000).toISOString(),
        expire_in_ms: 60_000,
      },
      items: [], payments: [],
    });
    await inflight;

    // 只扣残差的一半（单向估计）：扣整段会在弱网上行慢时提前封掉还能付的单
    expect(page._lastLoadDownlinkMs).toBeGreaterThanOrEqual(50);
    expect(page._lastLoadDownlinkMs).toBeLessThan(120);
    // 服务端值保持原样（下面那条用例依赖这个区分），扣减体现在本地截止点上
    expect(page.data.order.expire_in_ms).toBe(60_000);
    expect(page._countdownDeadlineAt - Date.now()).toBeLessThan(60_000);
  });

  test('服务端给的剩余量为正、但被 RTT 扣成 0 → 重载一次（服务端还没试过关）', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    page._lastLoadDownlinkMs = 500;            // 下行估计比剩余量还长
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(50));

    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(page.data.countdown).toBe('');
  });

  test('服务端下发 expire_clock 时，截止时刻用它而不是设备时区推导', async () => {
    // 本地 getHours() 取的是设备时区；顾客出境后同一行会变成
    //「请在 03:15 前完成支付（剩余 09:30）」这种自相矛盾的句子
    const { page, resolvers } = createPageWithManualApi();
    const inflight = page.loadDetail('FY-215');
    resolvers[0]({
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() + 60_000).toISOString(),
        expire_in_ms: 60_000,
        expire_clock: '23:45',
      },
      items: [], payments: [],
    });
    await inflight;

    expect(page.data.order.expire_time_fmt).toBe('23:45');
  });

  test('旧云函数回退口径：绝对时间已过期 → 重载一次（不能当成服务端权威的 0）', () => {
    // 旧后端请求开头没关单、却返回了已过期的 expire_at。把它当成「服务端说 0 =
    // 已经试过关单了」来处理，页面就会长期停在「请完成支付 + 去支付」——
    // 只有**权威**的 expire_in_ms 为 0 才允许不重载。
    const { page, loadDetail } = createPageWithStubbedLoad();
    page.startCountdown(PENDING_ORDER(new Date(Date.now() - 1000).toISOString()));

    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(page.data.countdown).toBe('');
  });

  test('回退口径重载回来还是归零 → 不再重载（否则每个 RTT 转一圈的无界循环）', () => {
    // 旧后端对员工单、有在途意图的自助单**永远关不掉**却照发已过期的 expire_at。
    // 权威口径靠服务端补关收敛，回退口径没这个保证，只能按订单号放行一次。
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = () => new Date(Date.now() - 1000).toISOString();

    for (let i = 0; i < 10; i++) page.startCountdown(PENDING_ORDER(past()));

    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  test('换一张单时回退口径各自还能重载一次（守卫按订单号记）', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown({ sale_order_id: 'FY-A', status: '待支付', expire_at: past } as any);
    page.startCountdown({ sale_order_id: 'FY-B', status: '待支付', expire_at: past } as any);

    expect(loadDetail.mock.calls.map((c) => c[0])).toEqual(['FY-A', 'FY-B']);
  });

  test('回退口径不再扣一次 RTT（绝对时间本就是按此刻算的）', () => {
    const { page } = createPageWithStubbedLoad();
    page._lastLoadDownlinkMs = 5000;
    page.startCountdown(PENDING_ORDER(new Date(Date.now() + 60_000).toISOString()));

    // 若误扣 5 秒会变成 00:55
    expect(page.data.countdown).toMatch(/^(00:59|01:00)$/);
  });

  test('隐藏态下 RTT 归零分支不发后台请求', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    page._hidden = true;
    page._lastLoadDownlinkMs = 500;
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(50));

    expect(loadDetail).not.toHaveBeenCalled();
    expect(page.data.countdown).toBe('');
  });

  test('截止点锚在响应到手那一刻，不把视图组装耗时算进倒计时', async () => {
    // 从 API resolve 到 startCountdown 之间还隔着分组疗程卡、映射流水、setData，
    // 用那之后的 Date.now() 当锚点，这段耗时就被凭空加到倒计时上了
    const { page, resolvers } = createPageWithManualApi();
    const inflight = page.loadDetail('FY-215');
    resolvers[0]({
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() + 60_000).toISOString(),
        expire_in_ms: 60_000, expire_clock: '12:34', server_elapsed_ms: 0,
      },
      items: [], payments: [],
    });
    await inflight;

    // 截止点不得晚于「到手时刻 + 服务端给的剩余量」
    expect(page._countdownDeadlineAt).toBeLessThanOrEqual(page._lastLoadReceivedAt + 60_000);
    expect(page._countdownDeadlineAt).toBeGreaterThan(page._lastLoadReceivedAt + 59_000);
  });

  /** 触发一次墙钟回拨，返回 loadDetail 替身 */
  async function triggerClockRollback(loadResult: boolean) {
    const page = createPageInstance();
    const loadDetail = vi.fn(async () => loadResult);
    page.loadDetail = loadDetail;
    page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(120_000));
    vi.setSystemTime(Date.now() - 30_000);
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    return { page, loadDetail };
  }

  test('墙钟**向前**跳过截止点 → 按「时钟不可信」校准，不当成过期、不关支付入口', async () => {
    // 自从归零会封支付入口，把一次系统校时误判成过期就会封掉一张服务端还认可的单
    vi.useFakeTimers();
    try {
      const page = createPageInstance();
      const loadDetail = vi.fn(async () => true);
      page.loadDetail = loadDetail;
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(120_000));

      vi.setSystemTime(Date.now() + 10 * 60 * 1000);   // 向前跳 10 分钟
      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(page.data.payBlockedByExpiry).toBe(false);
      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page.data.countdown).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('只有服务端明说「已过期没关掉」才封支付入口，本地判定不封', async () => {
    const { page, resolvers } = createPageWithManualApi();
    const degraded = {
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() - 1000).toISOString(),
        expire_in_ms: null, expire_clock: null, expire_unresolved: true,
      },
      items: [], payments: [],
    };
    const inflight = page.loadDetail('FY-215');
    resolvers[0](degraded);
    await inflight;

    expect(page.data.payBlockedByExpiry).toBe(true);
    page.onPay();
    expect(wxMock.navigateTo).not.toHaveBeenCalled();
  });

  test('刷新型加载不置 isLoading —— unresolved 轮询不能让整页每圈闪一次', async () => {
    // wxml 的 `wx:if="{{!isLoading}}"` 会把整个 container 摘掉；
    // 刷新也置它的话，5 秒一圈的 unresolved 轮询会让页面看起来是坏的
    const { page, resolvers } = createPageWithManualApi();
    const first = page.loadDetail('FY-215');
    expect(page.data.isLoading).toBe(true);           // 首载：该有骨架屏
    resolvers[0](detailResponse('待支付'));
    await first;
    expect(page.data.isLoading).toBe(false);

    page.loadDetail('FY-215');                         // 刷新
    expect(page.data.isLoading).toBe(false);           // 不再摘掉整页
  });

  test('重试间隔指数退避到 60 秒封顶（unresolved 那条会一直排）', () => {
    vi.useFakeTimers();
    try {
      const { page } = createPageWithStubbedLoad();
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        page._scheduleRefreshRetry('FY-215');
        delays.push(page._refreshRetryDelayMs);
      }
      expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('重试本身再失败 → 仍按退避继续排（链不能断）', async () => {
    // 裸调用的话，重试一失败就没人接着确认了，页面永久停在「正在确认订单状态」
    vi.useFakeTimers();
    try {
      const page = createPageInstance();
      const loadDetail = vi.fn(async () => false);
      page.loadDetail = loadDetail;

      page._refreshOrRetry('FY-215');
      await vi.advanceTimersByTimeAsync(0);
      expect(loadDetail).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);     // 第一次重试，又失败
      expect(loadDetail).toHaveBeenCalledTimes(2);
      expect(page._refreshRetryTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);   // 退避到 10 秒的那次
      expect(loadDetail).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('成功但仍 unresolved → 退避**不**复位（否则永远 5 秒一圈）', async () => {
    const { page, resolvers } = createPageWithManualApi();
    const degraded = {
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() - 1000).toISOString(),
        expire_in_ms: null, expire_clock: null, expire_unresolved: true,
      },
      items: [], payments: [],
    };
    page._refreshRetryDelayMs = 20_000;
    const inflight = page.loadDetail('FY-215');
    resolvers[0](degraded);
    await inflight;

    expect(page._refreshRetryDelayMs).toBe(40_000);   // 由 startCountdown 再排一次，翻倍
  });

  test('onShow 的刷新失败也有兜底（隐藏期跨点那条路指望的就是这一发）', async () => {
    vi.useFakeTimers();
    try {
      const page = createPageInstance();
      const loadDetail = vi.fn(async () => false);
      page.loadDetail = loadDetail;
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });

      page.onShow();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page._refreshRetryTimer).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('成功刷新会取消已排的重试（别在有新鲜数据的页面上白闪一次）', async () => {
    vi.useFakeTimers();
    try {
      const { page, resolvers } = createPageWithManualApi();
      page._scheduleRefreshRetry('FY-215');
      expect(page._refreshRetryTimer).not.toBeNull();

      const inflight = page.loadDetail('FY-215');
      resolvers[0](detailResponse('已关闭'));
      await inflight;

      expect(page._refreshRetryTimer).toBeNull();
      callClientApiMock.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(callClientApiMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('墙钟回拨后校准**失败** → 才排一次有界重试（回拨不关支付入口，失败就没有恢复点了）', async () => {
    vi.useFakeTimers();
    try {
      const { loadDetail } = await triggerClockRollback(false);
      expect(loadDetail).toHaveBeenCalledTimes(1);      // 立刻校准那一次

      await vi.advanceTimersByTimeAsync(5000);
      expect(loadDetail).toHaveBeenCalledTimes(2);      // 有界重试那一次
    } finally {
      vi.useRealTimers();
    }
  });

  test('墙钟回拨后校准**成功** → 不再多打一次（别白闪一次骨架屏）', async () => {
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = await triggerClockRollback(true);
      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page._refreshRetryTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(loadDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('确认轮询收尾的那次刷新失败 → 有界重试（轮询自己会清掉支付意图）', async () => {
    // 渠道终态失败时 order.confirmPayment 会清 lakala_out_order_no，订单因此重新进入
    //「会被自动关闭」的集合。这次刷新拿不到新状态，页面就会长期停在
    //「请完成支付 + 去支付」，到点顾客点下去才被拒（codex 评审 round-14 P1）
    vi.useFakeTimers();
    try {
      const page = createPageInstance();
      const loadDetail = vi.fn(async () => false);   // 收尾刷新失败
      page.loadDetail = loadDetail;
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });

      const confirming = page.confirmAndRefresh('FY-215');
      expect(pollerControls).toHaveLength(1);
      pollerControls[0].resolve({ sessionCompleted: false });
      await confirming;

      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page._refreshRetryTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(5000);
      expect(loadDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('onHide 会清掉待重试的刷新定时器', async () => {
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = await triggerClockRollback(false);
      expect(page._refreshRetryTimer).not.toBeNull();

      page.onHide();
      expect(page._refreshRetryTimer).toBeNull();
      loadDetail.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(loadDetail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('墙钟被回拨 → 停表并回服务端重新校准，不让倒计时被凭空延长', () => {
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = createPageWithStubbedLoad();
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(60_000));
      expect(page._countdownTimer).not.toBeNull();

      // 模拟系统校时往回跳 30 秒
      const base = Date.now();
      vi.setSystemTime(base - 30_000);
      vi.advanceTimersByTime(1000);

      expect(loadDetail).toHaveBeenCalledTimes(1);
      expect(page._countdownTimer).toBeNull();
      expect(page.data.countdown).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('expire_at 解析不出来 → 不装表，不推 NaN:NaN', () => {
    const { page } = createPageWithStubbedLoad();
    page.startCountdown(PENDING_ORDER('不是时间'));

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
  });

  test('倒计时期间切到另一张单 → 旧定时器被清理，不并存两个', () => {
    const { page } = createPageWithStubbedLoad();
    const future = new Date(Date.now() + 60_000).toISOString();

    page.startCountdown({ sale_order_id: 'FY-A', status: '待支付', expire_at: future } as any);
    const firstTimer = page._countdownTimer;
    expect(firstTimer).not.toBeNull();

    page.startCountdown({ sale_order_id: 'FY-B', status: '待支付', expire_at: future } as any);
    expect(page._countdownTimer).not.toBe(firstTimer);
  });
});

describe('order-detail 倒计时的生命周期与并发 (#215)', () => {
  test('onUnload 后请求才回来 → loadDetail 入口早退，不在死实例上重新装表', async () => {
    const { page, resolvers } = createPageWithManualApi();

    const inflight = page.loadDetail('FY-215');
    expect(resolvers).toHaveLength(1);

    page.onUnload();
    expect(page._destroyed).toBe(true);

    resolvers[0](detailResponse('待支付'));
    await inflight;

    expect(page._countdownTimer).toBeNull();
    // 卸载后不再落 setData
    expect(page.data.order).toBeNull();
  });

  test('onUnload 之后新发起的 loadDetail 直接早退', async () => {
    const { page } = createPageWithManualApi();
    page.onUnload();

    await page.loadDetail('FY-215');

    expect(callClientApiMock).not.toHaveBeenCalled();
  });

  test('onHide 停掉倒计时，避免隐藏期间静默归零并发后台重载', () => {
    const { page } = createPageWithStubbedLoad();
    const future = new Date(Date.now() + 60_000).toISOString();

    page.startCountdown(PENDING_ORDER(future));
    expect(page._countdownTimer).not.toBeNull();

    page.onHide();
    expect(page._countdownTimer).toBeNull();
    expect(page.data.countdown).toBe('');
  });

  test('onHide 之后在途响应才回来 → 不重新装表（隐藏页不该有 1Hz 定时器）', async () => {
    const { page, resolvers } = createPageWithManualApi();

    const inflight = page.loadDetail('FY-215');
    page.onHide();
    expect(page._hidden).toBe(true);

    resolvers[0]({
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() + 60_000).toISOString(),
        expire_in_ms: 60_000,
      },
      items: [], payments: [],
    });
    await inflight;

    // 数据照常落盘（onShow 回来时不用空等），但不装表
    expect(page.data.order.status).toBe('待支付');
    expect(page._countdownTimer).toBeNull();
    expect(page.data.countdown).toBe('');
  });

  test('onShow 解除隐藏态，倒计时可以重建', async () => {
    const { page } = createPageWithStubbedLoad();
    page.onHide();
    page.onShow();
    expect(page._hidden).toBe(false);

    page.startCountdown(PENDING_ORDER_WITH_REMAINING(60_000));
    expect(page._countdownTimer).not.toBeNull();
  });

  test('onHide → onShow 那次请求失败，倒计时仍按本地截止点恢复', async () => {
    // 不恢复的话页面就只剩「请完成支付」，到期也不会自动刷新 —— 自助单从此看不到时限
    const { page } = createPageWithStubbedLoad();
    page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(60_000));
    const deadline = page._countdownDeadlineAt;
    expect(deadline).toBeGreaterThan(0);

    page.onHide();
    expect(page._countdownTimer).toBeNull();
    expect(page._countdownDeadlineAt).toBe(deadline);   // onHide 只停表，不丢截止点

    // onShow：loadDetail 失败（替身直接返回），但恢复不依赖它
    page.onShow();
    expect(page._countdownTimer).not.toBeNull();
    expect(page.data.countdown).toMatch(/^(00:5\d|01:00)$/);
  });

  test('轮询启动后被 onHide 打断 → 待确认意图要还回去（否则永远不再主动对账）', async () => {
    // 渠道可能已经扣款而回调延迟；意图被消费掉又不还，就再也不会主动对账，
    // 顾客端会一直显示待支付（codex 评审 round-4 P1）
    const page = createPageInstance();
    page.loadDetail = vi.fn(async () => {});

    const confirming = page.confirmAndRefresh('FY-215');
    expect(pollerControls).toHaveLength(1);

    page.onHide();            // onHide 会调 poller.clear() → resolve 掉 promise
    await confirming;

    expect(page._needConfirm).toBe(true);
    expect(page.loadDetail).not.toHaveBeenCalled();   // 隐藏页不再继续请求
  });

  test('隐藏期间墙钟被回拨 → onShow 丢弃旧截止点，等服务端重新校准', () => {
    // tick 里的回拨检测看不见隐藏期发生的跳变（恢复时 lastTickAt 用的已是调整后的时间），
    // 不丢弃的话倒计时会被回拨量凭空延长，而服务端仍按原截止点关单
    vi.useFakeTimers();
    try {
      const { page } = createPageWithStubbedLoad();
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(120_000));
      expect(page._countdownDeadlineAt).toBeGreaterThan(0);

      page.onHide();
      vi.setSystemTime(Date.now() - 30 * 60 * 1000);   // 隐藏期间回拨 30 分钟
      page.onShow();

      expect(page._countdownDeadlineAt).toBe(0);
      expect(page._countdownTimer).toBeNull();
      expect(page.data.countdown).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('隐藏期间跨过截止点 → onShow 不重复发请求（让紧随其后的加载去刷）', () => {
    vi.useFakeTimers();
    try {
      const { page, loadDetail } = createPageWithStubbedLoad();
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(5_000));

      page.onHide();
      vi.setSystemTime(Date.now() + 10_000);           // 隐藏期间走过了截止点
      loadDetail.mockClear();
      page.resumeCountdown();

      expect(loadDetail).not.toHaveBeenCalled();
      expect(page._countdownDeadlineAt).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('隐藏态下不消耗 paid=1 的待确认意图（下次 onShow 还能补上）', async () => {
    const { page, resolvers } = createPageWithManualApi();
    page._needConfirm = true;
    const inflight = page.loadDetail('FY-215');
    page.onHide();
    resolvers[0](detailResponse('待支付'));
    await inflight;

    expect(page._needConfirm).toBe(true);
    expect(page.data.confirmingPayment).toBe(false);
  });

  test('loadDetail 如实返回成败（调用方据此决定要不要重试）', async () => {
    // 它一度把失败吞掉只返回 void，逼得调用方只能盲目重试 ——
    // 「校准成功也白打一发」和「轮询收尾失败无人兜底」都是那么来的
    const { page, resolvers } = createPageWithManualApi();
    const okRun = page.loadDetail('FY-215');
    resolvers[0](detailResponse('已关闭'));
    expect(await okRun).toBe(true);

    const rejecters: Array<(e: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((_resolve, reject) => { rejecters.push(reject); }),
    );
    const failRun = page.loadDetail('FY-215');
    rejecters[0](new Error('network'));
    expect(await failRun).toBe(false);
  });

  test('single-flight：在途期间再来的加载被合并成一次尾随刷新', async () => {
    // 原先用「后发起者获胜」的 token，但那保证的是**发起顺序**赢、不是**数据新旧**赢：
    // 先发起的请求完全可能后到服务端、读到更新的快照却被判废，一张刚支付成功的单
    // 就会被画回「待支付」。让请求根本不并行，这类乱序就不存在了。
    const { page, resolvers } = createPageWithManualApi();

    const a = page.loadDetail('FY-215');
    const b = page.loadDetail('FY-215');   // 在途期间再来
    const c = page.loadDetail('FY-215');   // 再来一次，仍只合并成一次
    expect(resolvers).toHaveLength(1);     // 同一时刻只有一个在途请求

    resolvers[0](detailResponse('待支付'));
    await Promise.resolve();
    await Promise.resolve();
    // 尾随刷新这时才发出，而且只发一次
    expect(resolvers).toHaveLength(2);

    resolvers[1](detailResponse('已关闭'));
    await Promise.all([a, b, c]);

    // 所有调用方都等到了最终结果
    expect(page.data.order.status).toBe('已关闭');
    expect(page.data.isLoading).toBe(false);
    expect(callClientApiMock).toHaveBeenCalledTimes(2);
  });

  test('await loadDetail 能等到尾随刷新跑完（confirmAndRefresh 依赖这一点）', async () => {
    const { page, resolvers } = createPageWithManualApi();

    const first = page.loadDetail('FY-215');
    page.loadDetail('FY-215');            // 触发尾随刷新
    resolvers[0](detailResponse('待支付'));
    await Promise.resolve();
    await Promise.resolve();
    resolvers[1](detailResponse('已支付'));
    await first;

    // 若 await 只等到第一次，这里读到的会是「待支付」
    expect(page.data.order.status).toBe('已支付');
  });

  test('隐藏期间加载失败 → 不弹「加载失败」（切回来才看到一条陈旧错误提示）', async () => {
    const { page } = createPageWithManualApi();
    const rejecters: Array<(e: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((_resolve, reject) => { rejecters.push(reject); }),
    );

    const inflight = page.loadDetail('FY-215');
    page.onHide();
    rejecters[0](new Error('network'));
    await inflight;

    expect(Toast.fail).not.toHaveBeenCalled();
  });

  test('服务端说「已过期但没关掉」→ 关支付入口，且成功刷新也不解除', async () => {
    // 别用「字段缺席」同时表达「旧云函数」和「新云函数补关失败」：前者不该关支付入口
    //（那些单在旧后端本来就能付），后者必须关（单确实过期了，order.pay 会拒）
    const { page, resolvers } = createPageWithManualApi();
    const degraded = {
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() - 1000).toISOString(),
        expire_in_ms: null, expire_clock: null, expire_unresolved: true,
      },
      items: [], payments: [],
    };
    const inflight = page.loadDetail('FY-215');
    resolvers[0](degraded);
    await inflight;

    // 服务端明说没关掉 → 闸门必须一直关着，哪怕刷新是成功的
    expect(page.data.payBlockedByExpiry).toBe(true);
    // 不该**立刻**再打一发（服务端刚说过它试不动了），但必须排一次延迟的权威刷新 ——
    // 页面此刻写着「正在确认订单状态」，没人去确认这句话就是假的
    expect(callClientApiMock).toHaveBeenCalledTimes(1);
    expect(page._refreshRetryTimer).not.toBeNull();
    // 也不该本地推一个**已经过去**的截止时刻进 data（那是下一个口径分叉的种子）
    expect(page.data.order.expire_time_fmt).toBe('');
  });

  test('旧云函数的非权威归零不关支付入口（那些单在旧后端本来就能付）', async () => {
    const { page, resolvers } = createPageWithManualApi();
    const legacy = {
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() - 1000).toISOString(),
        // 旧云函数：三个新字段全缺席
      },
      items: [], payments: [],
    };
    const inflight = page.loadDetail('FY-215');
    resolvers[0](legacy);
    await new Promise((r) => setTimeout(r, 0));
    resolvers[1]?.(legacy);
    await inflight;

    expect(page.data.payBlockedByExpiry).toBe(false);
  });

  test('时延扣减要先减掉服务端处理耗时，再取一半', async () => {
    // expire_in_ms 是服务端**处理完之后**才算的；把处理耗时也扣掉就是重复计算，
    // 倒计时会提前结束、支付入口提前被关
    const { page, resolvers } = createPageWithManualApi();
    const inflight = page.loadDetail('FY-215');
    await new Promise((r) => setTimeout(r, 150));
    resolvers[0]({
      order: {
        sale_order_id: 'FY-215', status: '待支付',
        expire_at: new Date(Date.now() + 60_000).toISOString(),
        expire_in_ms: 60_000,
        server_elapsed_ms: 140,        // 这 150ms 里绝大部分是服务端处理
      },
      items: [], payments: [],
    });
    await inflight;

    // 只该扣掉「网络那一小段」的一半，而不是整个 150ms
    expect(page._lastLoadDownlinkMs).toBeLessThan(30);
  });

  test('权威剩余量被扣光 → 只改文案，**不**封支付入口', () => {
    // 本地判到期一律只说「正在确认」：一次本地时钟误判不该把顾客的支付通道堵死。
    // 真过期了由服务端拒绝（一条可恢复的错误提示）。
    const { page } = createPageWithStubbedLoad();
    page._lastLoadDownlinkMs = 500;
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(50));

    expect(page.data.expiryPendingConfirm).toBe(true);
    expect(page.data.payBlockedByExpiry).toBe(false);
  });

  test('非权威归零（旧云函数）不关支付入口 —— 那些单在旧后端本来就能付', () => {
    const { page } = createPageWithStubbedLoad();
    page.startCountdown(PENDING_ORDER(new Date(Date.now() - 1000).toISOString()));

    expect(page.data.payBlockedByExpiry).toBe(false);
  });

  test('隐藏期间跨过截止点 → 只改文案（隐藏期分不清真过期还是把钟拨快了）', () => {
    vi.useFakeTimers();
    try {
      const { page } = createPageWithStubbedLoad();
      page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(5_000));
      page.onHide();
      vi.setSystemTime(Date.now() + 10_000);
      page.resumeCountdown();

      expect(page.data.expiryPendingConfirm).toBe(true);
      expect(page.data.payBlockedByExpiry).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('墙钟回拨**不**关支付入口 —— 回拨不等于过期，关了是误伤一笔能付的单', () => {
    vi.useFakeTimers();
    try {
      const { page } = createPageWithStubbedLoad();
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(120_000));
      const base = Date.now();
      vi.setSystemTime(base - 30_000);
      vi.advanceTimersByTime(1000);

      expect(page.data.payBlockedByExpiry).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('归零后那次刷新失败 → 文案停在「正在确认」并继续重试，但不封支付入口', async () => {
    // 页面不退回裸的「请完成支付」（那是在承诺不知真假的事），
    // 但也不封支付入口（本地判定不足以封） —— 靠有界重试去拿服务端的答案
    const { page } = createPageWithManualApi();
    const rejecters: Array<(e: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((_resolve, reject) => { rejecters.push(reject); }),
    );
    page.setData({ order: { sale_order_id: 'FY-215', status: '待支付' } });

    vi.useFakeTimers();
    try {
      page.startCountdown(PENDING_ORDER_WITH_REMAINING(1000));
      vi.advanceTimersByTime(1500);          // 走到归零 → 发刷新
    } finally {
      vi.useRealTimers();
    }
    expect(page.data.expiryPendingConfirm).toBe(true);

    rejecters[0]?.(new Error('network'));
    await new Promise((r) => setTimeout(r, 0));

    // 文案还在、重试已排，但支付入口没被本地判断堵死
    expect(page.data.expiryPendingConfirm).toBe(true);
    expect(page.data.payBlockedByExpiry).toBe(false);
    expect(page._refreshRetryTimer).not.toBeNull();
    page.onPay();
    expect(wxMock.navigateTo).toHaveBeenCalled();
  });

  test('任何一次成功的刷新都解除「时限已到」闸门', async () => {
    const { page, resolvers } = createPageWithManualApi();
    page.setData({ payBlockedByExpiry: true });

    const inflight = page.loadDetail('FY-215');
    resolvers[0](detailResponse('已关闭'));
    await inflight;

    expect(page.data.payBlockedByExpiry).toBe(false);
  });
});

describe('order-detail.wxml 的倒计时文案分支 (#215)', () => {
  const wxml = readFileSync(
    resolve(__dirname, '../../../pagesOrder/order-detail/order-detail.wxml'),
    'utf8',
  );

  test('待支付状态区是 countdown → 待确认 → 兜底 三段同一条分支链', () => {
    // 松断言（三行各自存在）会被文件里任何位置的同名分支满足。这里钉的是**同链且有序**：
    //  - countdown 为空（后端没下发 expire_at）不能还显示「请在  前完成支付」
    //  - 时限已到但状态未确认时，必须落到「正在确认」而不是「请完成支付」
    const chain = /wx:if="\{\{countdown\}\}">请在 \{\{order\.expire_time_fmt\}\} 前完成支付（剩余 \{\{countdown\}\}）[\s\S]{0,400}?wx:elif="\{\{expiryPendingConfirm \|\| payBlockedByExpiry\}\}">支付时限已到，正在确认订单状态[\s\S]{0,200}?wx:else>请完成支付/;
    expect(wxml).toMatch(chain);
  });

  test('「时限已到、状态未确认」期间支付按钮必须 disabled', () => {
    // 归零后那次刷新失败时，页面不知道这单关没关 —— 放行只会让顾客跳到结算页
    // 再吃一个「订单已超时」（评审 round-9 P1）
    const payBtn = /bindtap="onPay"[\s\S]{0,200}?disabled="\{\{payBlockedByExpiry\}\}"/;
    expect(wxml).toMatch(payBtn);
  });

  test('线下付款分支在倒计时分支之前（记录既有排布，不代表口径已确认）', () => {
    // ⚠️ 这条只是**如实记录当前 DOM 排布**，不是本 PR 确认的产品口径。
    //
    // 线下**自助**单同样满足 `opened_by IS NULL AND lakala_out_order_no IS NULL`，
    // 后端照发 expire_at，`closeExpiredOrder` 也照样在 T+10 把它关掉；
    // 但状态区被「请到店付款，等待店长确认收款」占住，顾客从头到尾看不到任何时限。
    // 这是**既有行为**（分支顺序早于本 issue），却与本 issue「让顾客看到的支付时限
    // 与订单实际关闭规则一致」的目标相抵触 —— 顾客正往门店走的路上单子就没了。
    //
    // 改法有两种（显示时限 / 线下单不自动关闭），都属业务口径，已在 issue #215
    // 评论里列给甲方拍板，**本 PR 不擅自改**。拍板后连这条断言一起调整。
    const offlineAt = wxml.indexOf("order.payment_method === '线下'");
    const countdownAt = wxml.indexOf('wx:if="{{countdown}}"');
    expect(offlineAt).toBeGreaterThanOrEqual(0);
    expect(countdownAt).toBeGreaterThan(offlineAt);
  });
});
