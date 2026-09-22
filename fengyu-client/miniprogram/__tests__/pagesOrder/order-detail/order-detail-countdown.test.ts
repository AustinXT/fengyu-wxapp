/**
 * order-detail 页面 — 待支付倒计时（issue #215）
 *
 * 守两件事：
 *  1. 后端不下发 expire_at 时（员工开单单、有在途支付意图的自助单）页面不起倒计时，
 *     文案走 wxml 的兜底分支「请完成支付」，不出现「请在 xx 前完成支付」
 *  2. 「归零重载」不会死循环。断点是**区分装表时机**：装表时已过期只清 UI 不重载，
 *     走着走着归零才重载一次 —— 重载回来必然落进前一条，两跳内收敛，无需任何状态
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
    if (p._countdownTimer) clearInterval(p._countdownTimer);
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

  test('服务端权威地说剩 0 → 只清 UI，不重载、不装定时器', () => {
    // 服务端那边补关复检与剩余量计算共用同一个 nowMs，所以「权威的 0」严格蕴含
    // 「它已经试过关单了」，再打一次拿到的还是同一个答案。
    // 这一条正是死循环的结构性断点 —— 注意**只有权威口径**才享受这个待遇，
    // 旧云函数的绝对时间回退算出的 0 仍必须重载（见下面那条用例）。
    const { page, loadDetail } = createPageWithStubbedLoad();

    page.startCountdown(PENDING_ORDER_WITH_REMAINING(0));

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('反复装表（模拟 onShow/下拉）也不会累积重载 —— 循环不可能形成', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();

    for (let i = 0; i < 10; i++) page.startCountdown(PENDING_ORDER_WITH_REMAINING(0));

    expect(loadDetail).not.toHaveBeenCalled();
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
    // 自助单彻底看不到倒计时，而服务端根本还没打算关它
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

  test('倒计时会扣掉本次请求的往返耗时', async () => {
    // 服务端给的是「生成响应那一刻」的剩余量，传到手上已经过去一段了；
    // 不扣的话倒计时比真实关单时刻晚一个 RTT，顾客会在还显示剩余时间时被拒付
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

    expect(page._lastLoadRttMs).toBeGreaterThanOrEqual(100);
    // 服务端值保持原样（下面那条用例依赖这个区分），扣减体现在本地截止点上
    expect(page.data.order.expire_in_ms).toBe(60_000);
    expect(page._countdownDeadlineAt - Date.now()).toBeLessThan(60_000);
  });

  test('服务端说剩 0 → 不重载；服务端说剩 50ms 但被 RTT 扣成 0 → 必须重载一次', () => {
    // 这两种「0」处理完全相反：前者意味着服务端已经试过关单了（那边共用同一个 nowMs
    // 保证这点），再打一次拿到的还是同一个答案；后者服务端根本还没试过关，
    // 混为一谈的话页面会永久停在「待支付 / 请完成支付 / 去支付」
    const a = createPageWithStubbedLoad();
    a.page._lastLoadRttMs = 0;
    a.page.startCountdown(PENDING_ORDER_WITH_REMAINING(0));
    expect(a.loadDetail).not.toHaveBeenCalled();
    expect(a.page.data.countdown).toBe('');

    const b = createPageWithStubbedLoad();
    b.page._lastLoadRttMs = 500;          // 本次 RTT 比剩余量还长
    b.page.startCountdown(PENDING_ORDER_WITH_REMAINING(50));
    expect(b.loadDetail).toHaveBeenCalledTimes(1);
    expect(b.page.data.countdown).toBe('');
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
    page._lastLoadRttMs = 5000;
    page.startCountdown(PENDING_ORDER(new Date(Date.now() + 60_000).toISOString()));

    // 若误扣 5 秒会变成 00:55
    expect(page.data.countdown).toMatch(/^(00:59|01:00)$/);
  });

  test('隐藏态下 RTT 归零分支不发后台请求', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    page._hidden = true;
    page._lastLoadRttMs = 500;
    page.startCountdown(PENDING_ORDER_WITH_REMAINING(50));

    expect(loadDetail).not.toHaveBeenCalled();
    expect(page.data.countdown).toBe('');
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

  test('被抢先的那次失败 → 不弹「加载失败」（否则错误提示与正确数据并存）', async () => {
    const { page, resolvers } = createPageWithManualApi();
    const rejecters: Array<(e: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((resolve, reject) => { resolvers.push(resolve); rejecters.push(reject); }),
    );

    const first = page.loadDetail('FY-215');   // token=1
    const second = page.loadDetail('FY-215');  // token=2
    resolvers[1](detailResponse('已关闭'));
    await second;

    rejecters[0](new Error('network'));
    await first;

    expect(Toast.fail).not.toHaveBeenCalled();
    expect(page.data.order.status).toBe('已关闭');
  });

  test('卸载后才失败的请求 → 既不弹 Toast 也不动 loading', async () => {
    const { page } = createPageWithManualApi();
    const rejecters: Array<(e: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((_resolve, reject) => { rejecters.push(reject); }),
    );

    const inflight = page.loadDetail('FY-215');
    page.onUnload();
    rejecters[0](new Error('network'));
    await inflight;

    expect(Toast.fail).not.toHaveBeenCalled();
    expect(page.data.isLoading).toBe(true);  // 未被死实例改写
  });

  test('并发 loadDetail：被抢先的那次不许落 setData（旧响应不能盖新响应）', async () => {
    const { page, resolvers } = createPageWithManualApi();

    const first = page.loadDetail('FY-215');   // token=1
    const second = page.loadDetail('FY-215');  // token=2（更新的一次）
    expect(resolvers).toHaveLength(2);

    // 更新的那次先回（已关闭），随后旧的那次才回（待支付）
    resolvers[1](detailResponse('已关闭'));
    await second;
    resolvers[0](detailResponse('待支付'));
    await first;

    expect(page.data.order.status).toBe('已关闭');
    expect(page.data.isLoading).toBe(false);
  });

  test('被抢先的那次不许提前关掉 loading', async () => {
    const { page, resolvers } = createPageWithManualApi();

    const first = page.loadDetail('FY-215');
    page.loadDetail('FY-215');

    // 旧的那次先回 → 既不落 setData，也不把 loading 关掉（新的还在飞）
    resolvers[0](detailResponse('待支付'));
    await first;

    expect(page.data.isLoading).toBe(true);
  });
});

describe('order-detail.wxml 的倒计时文案分支 (#215)', () => {
  const wxml = readFileSync(
    resolve(__dirname, '../../../pagesOrder/order-detail/order-detail.wxml'),
    'utf8',
  );

  test('「请在 xx 前完成支付」与兜底文案是同一个 wx:if/wx:else 对', () => {
    // 松断言（两行各自存在）会被文件里任何位置的同名分支满足。这里钉的是**成对且相邻**：
    // countdown 为空（后端没下发 expire_at）必须落到兜底文案，
    // 否则员工单会显示一个空的「请在  前完成支付」
    const pair = /wx:if="\{\{countdown\}\}">请在 \{\{order\.expire_time_fmt\}\} 前完成支付（剩余 \{\{countdown\}\}）[\s\S]{0,120}?wx:else>请完成支付/;
    expect(wxml).toMatch(pair);
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
