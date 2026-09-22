/**
 * order-detail 页面 — 待支付倒计时（issue #215）
 *
 * 守两件事：
 *  1. 后端不下发 expire_at 时（员工开单单、有在途支付意图的自助单）页面不起倒计时，
 *     文案走 wxml 的兜底分支「请完成支付」，不出现「请在 xx 前完成支付」
 *  2. 倒计时归零后的自动重载**每张单只触发一次**。这条重载原本靠「后端懒清理会把订单
 *     置为已关闭」才能终止；一旦出现「归零但订单仍可支付」的矛盾态，
 *     loadDetail → startCountdown → 归零 → loadDetail 就按网络 RTT 空转，持续打 order.detail
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
(globalThis as any).wx = wxMock;

beforeAll(async () => {
  await import('../../../pagesOrder/order-detail/order-detail');
});

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
  return instance;
}

/** 只关心 startCountdown 的行为，loadDetail 替身记调用次数 */
function createPageWithStubbedLoad() {
  const page = createPageInstance();
  const loadDetail = vi.fn(async () => {});
  page.loadDetail = loadDetail;
  return { page, loadDetail };
}

const PENDING_ORDER = (expireAt: string | null) => ({
  sale_order_id: 'FY-215',
  status: '待支付',
  expire_at: expireAt,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

    clearInterval(page._countdownTimer);
  });

  test('首 tick 就已过期 → 重载一次，且不留定时器空转', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown(PENDING_ORDER(past));

    expect(page.data.countdown).toBe('');
    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(loadDetail).toHaveBeenCalledWith('FY-215');
    // 归零后还装定时器 = 1 秒后白跑一次 tick
    expect(page._countdownTimer).toBeNull();
  });

  test('归零重载回来仍是「待支付 + 已过期」→ 不再重载（否则按 RTT 死循环）', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    // 第一次：归零 → 触发重载
    page.startCountdown(PENDING_ORDER(past));
    expect(loadDetail).toHaveBeenCalledTimes(1);

    // 模拟重载后后端仍返回同一张待支付单（矛盾态），loadDetail 结尾会再次 startCountdown
    for (let i = 0; i < 5; i++) {
      page.startCountdown(PENDING_ORDER(past));
    }

    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(page.data.countdown).toBe('');
  });

  test('换一张单仍允许各自重载一次（守卫按订单号记，不是全局一次）', () => {
    const { page, loadDetail } = createPageWithStubbedLoad();
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown({ sale_order_id: 'FY-A', status: '待支付', expire_at: past } as any);
    page.startCountdown({ sale_order_id: 'FY-B', status: '待支付', expire_at: past } as any);

    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(loadDetail.mock.calls.map((c) => c[0])).toEqual(['FY-A', 'FY-B']);
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

  test('倒计时期间切到另一张单 → 旧定时器被清理，不并存两个', () => {
    const { page } = createPageWithStubbedLoad();
    const future = new Date(Date.now() + 60_000).toISOString();

    page.startCountdown({ sale_order_id: 'FY-A', status: '待支付', expire_at: future } as any);
    const firstTimer = page._countdownTimer;
    expect(firstTimer).not.toBeNull();

    page.startCountdown({ sale_order_id: 'FY-B', status: '待支付', expire_at: future } as any);
    expect(page._countdownTimer).not.toBe(firstTimer);

    clearInterval(page._countdownTimer);
  });
});

describe('order-detail 倒计时的生命周期与并发 (#215)', () => {
  test('重载失败 → 把一次性守卫还回去，不白烧掉唯一的自动恢复机会', async () => {
    const page = createPageInstance();
    // 弱网：loadDetail 内部 catch 掉异常并返回 false
    page.loadDetail = vi.fn(async () => false);
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown(PENDING_ORDER(past));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.loadDetail).toHaveBeenCalledTimes(1);
    expect(page._expiredReloadedOrderId).toBeNull();

    // 守卫已归还 → 下一次（onShow 触发的）归零仍允许重载
    page.startCountdown(PENDING_ORDER(past));
    expect(page.loadDetail).toHaveBeenCalledTimes(2);
  });

  test('重载成功 → 守卫保持已烧状态，不再重载', async () => {
    const page = createPageInstance();
    page.loadDetail = vi.fn(async () => true);
    const past = new Date(Date.now() - 1000).toISOString();

    page.startCountdown(PENDING_ORDER(past));
    await Promise.resolve();
    await Promise.resolve();

    expect(page._expiredReloadedOrderId).toBe('FY-215');
    page.startCountdown(PENDING_ORDER(past));
    expect(page.loadDetail).toHaveBeenCalledTimes(1);
  });

  test('onUnload 后请求才回来 → 不在死实例上重新装表', () => {
    const page = createPageInstance();
    page.loadDetail = vi.fn(async () => true);
    const future = new Date(Date.now() + 60_000).toISOString();

    page.onUnload();
    expect(page._destroyed).toBe(true);

    // 模拟在途 loadDetail 返回后调 startCountdown
    page.startCountdown(PENDING_ORDER(future));
    expect(page._countdownTimer).toBeNull();
    expect(page.loadDetail).not.toHaveBeenCalled();
  });

  test('onHide 停掉倒计时，避免隐藏期间静默归零烧掉守卫', () => {
    const page = createPageInstance();
    page.loadDetail = vi.fn(async () => true);
    const future = new Date(Date.now() + 60_000).toISOString();

    page.startCountdown(PENDING_ORDER(future));
    expect(page._countdownTimer).not.toBeNull();

    page.onHide();
    expect(page._countdownTimer).toBeNull();
    expect(page.data.countdown).toBe('');
    expect(page._expiredReloadedOrderId).toBeNull();
  });

  test('并发 loadDetail：被抢先的那次不许落 setData（旧响应不能盖新响应）', async () => {
    const page = createPageInstance();
    const resolvers: Array<(v: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    const closed = { order: { sale_order_id: 'FY-215', status: '已关闭' }, items: [], payments: [] };
    const pending = { order: { sale_order_id: 'FY-215', status: '待支付' }, items: [], payments: [] };

    const first = page.loadDetail('FY-215');   // seq=1
    const second = page.loadDetail('FY-215');  // seq=2（更新的一次）
    expect(resolvers).toHaveLength(2);

    // 更新的那次先回（已关闭），随后旧的那次才回（待支付）
    resolvers[1](closed);
    expect(await second).toBe(true);
    resolvers[0](pending);
    expect(await first).toBe(false);

    expect(page.data.order.status).toBe('已关闭');
    expect(page.data.isLoading).toBe(false);
  });

  test('被抢先的那次不许提前关掉 loading', async () => {
    const page = createPageInstance();
    const resolvers: Array<(v: any) => void> = [];
    callClientApiMock.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    const first = page.loadDetail('FY-215');
    page.loadDetail('FY-215');

    // 旧的那次先回 → 它必须既不落 setData，也不把 loading 关掉（新的还在飞）
    resolvers[0]({ order: { sale_order_id: 'FY-215', status: '待支付' }, items: [], payments: [] });
    expect(await first).toBe(false);
    expect(page.data.isLoading).toBe(true);
  });
});

describe('order-detail.wxml 的倒计时文案分支 (#215)', () => {
  const wxml = readFileSync(
    resolve(__dirname, '../../../pagesOrder/order-detail/order-detail.wxml'),
    'utf8',
  );

  test('「请在 xx 前完成支付」与兜底文案是同一个 wx:if/wx:else 对', () => {
    // 松断言（两行各自存在）会被文件里任何同名分支满足。这里钉的是**成对且相邻**：
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
