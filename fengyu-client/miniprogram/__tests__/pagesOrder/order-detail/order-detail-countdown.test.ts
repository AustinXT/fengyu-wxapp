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

const callClientApiMock = vi.fn();
vi.mock('../../../utils/cloud', () => ({
  callClientApi: (...args: any[]) => callClientApiMock(...args),
  bindPhoneWithCloudID: vi.fn(),
  sanitizeErrorMessage: (msg: string) => msg,
}));

vi.mock('@vant/weapp/toast/toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), fail: vi.fn(), clear: vi.fn() }),
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

const PENDING_ORDER = (expireAt: string | null) => ({
  sale_order_id: 'FY-215',
  status: '待支付',
  expire_at: expireAt,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
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

  test('装表时就已过期 → 只清 UI，不重载、不装定时器', () => {
    // 这次 detail 响应本身刚跑过服务端的懒清理，再打一次拿到的还是同一个答案。
    // 这一条正是死循环的结构性断点。
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown(PENDING_ORDER(past));

    expect(page.data.countdown).toBe('');
    expect(page._countdownTimer).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
  });

  test('反复装表（模拟 onShow/下拉）也不会累积重载 —— 循环不可能形成', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    for (let i = 0; i < 10; i++) page.startCountdown(PENDING_ORDER(past));

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

  test('线下付款分支优先于倒计时分支', () => {
    // 线下自助单同样会拿到 expire_at，但状态区必须先显示「请到店付款」，
    // 不能被倒计时那条抢走
    const offlineAt = wxml.indexOf("order.payment_method === '线下'");
    const countdownAt = wxml.indexOf('wx:if="{{countdown}}"');
    expect(offlineAt).toBeGreaterThanOrEqual(0);
    expect(countdownAt).toBeGreaterThan(offlineAt);
  });
});
