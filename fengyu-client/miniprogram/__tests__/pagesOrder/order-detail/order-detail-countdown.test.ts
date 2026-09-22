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

describe('order-detail.wxml 的倒计时文案分支 (#215)', () => {
  const wxml = readFileSync(
    resolve(__dirname, '../../../pagesOrder/order-detail/order-detail.wxml'),
    'utf8',
  );

  test('「请在 xx 前完成支付」只在 countdown 非空时渲染', () => {
    // countdown 为空（后端没下发 expire_at）必须落到兜底文案，否则员工单会显示一个空的「请在  前完成支付」
    expect(wxml).toContain('wx:if="{{countdown}}">请在 {{order.expire_time_fmt}} 前完成支付（剩余 {{countdown}}）');
    expect(wxml).toContain('wx:else>请完成支付');
  });
});
