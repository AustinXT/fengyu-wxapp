/**
 * checkout 页面 — #214 支付意图活跃期的页面行为
 *
 * 守护双谱系评审 round-15 报出的两条缺口：
 *  1. 渠道单建好后页面没进冻结态 → 顾客留在本页重试会走 scanAdjust，被服务端
 *     PAYMENT_INTENT_ACTIVE 拒掉，付不了款（正是本 issue 的症状，只是发生在同一页）
 *  2. 冻结期仍按实时卡余额重算展示金额 → 顾客期间充值一笔，页面显示的实付
 *     就与渠道单实际收款分叉（控件锁挡得住手点，挡不住余额自己变）
 */

import { vi } from 'vitest';

const callClientApiMock = vi.fn();
vi.mock('../../../utils/cloud', () => ({
  callClientApi: (...args: any[]) => callClientApiMock(...args),
  bindPhoneWithCloudID: vi.fn(),
  sanitizeErrorMessage: (msg: string) => msg,
}));

vi.mock('@vant/weapp/toast/toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), fail: vi.fn(), clear: vi.fn() }),
}));
vi.mock('@vant/weapp/dialog/dialog', () => ({
  default: { confirm: vi.fn(() => Promise.resolve()), alert: vi.fn(() => Promise.resolve()) },
}));

let pageOptions: any = null;
(globalThis as any).Page = (opts: any) => {
  pageOptions = opts;
};
(globalThis as any).getApp = () => ({
  globalData: { boundStoreId: 'S001', userId: 'u-1', boundStoreName: '门店' },
  isLoggedOut: () => false,
  syncLoginState: async () => 'authenticated',
});

const wxMock: any = (globalThis as any).wx || {};
wxMock.cloud = wxMock.cloud || { callFunction: vi.fn(), CloudID: vi.fn() };
wxMock.requestPayment = vi.fn(async () => ({}));
wxMock.redirectTo = vi.fn();
wxMock.navigateBack = vi.fn();
wxMock.navigateTo = vi.fn();
wxMock.showToast = vi.fn();
wxMock.showModal = vi.fn();
wxMock.setClipboardData = vi.fn();
wxMock.removeStorageSync = vi.fn();
(globalThis as any).wx = wxMock;

beforeAll(async () => {
  await import('../../../pagesOrder/checkout/checkout');
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
    }
  }
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  callClientApiMock.mockReset();
  wxMock.requestPayment.mockReset();
  wxMock.requestPayment.mockResolvedValue({});
});

describe('#214 渠道单建好后页面立即冻结', () => {
  test('支付宝拿到吱口令 → hasActivePaymentIntent=true 且订单号落到 existingOrderNo', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.alipayPay') {
        return Promise.resolve({ alipayShareToken: '¥tok¥', totalAmount: 200, paidAmount: 200 });
      }
      return Promise.resolve({});
    });
    const inst = createPageInstance({ prepaidCardAmount: 0, paidAmount: 200 });

    await inst.doAlipayPay('FY-XSD-WX-2609220001');

    expect(inst.data.hasActivePaymentIntent).toBe(true);
    expect(inst.data.existingOrderNo).toBe('FY-XSD-WX-2609220001');
    expect(inst.data.showAlipayShare).toBe(true);
  });

  test('微信拿到支付参数 → 同样进入冻结态（requestPayment 抛非取消错误时顾客留在本页）', async () => {
    const paymentParams = { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'RSA', paySign: 's' };
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.pay') return Promise.resolve({ paymentParams });
      return Promise.resolve({});
    });
    wxMock.requestPayment.mockRejectedValueOnce(new Error('requestPayment:fail network'));
    const inst = createPageInstance({ prepaidCardAmount: 0, paidAmount: 200 });

    await expect(inst.doWechatPay('FY-XSD-WX-2609220002')).rejects.toThrow(/network/);

    expect(inst.data.hasActivePaymentIntent).toBe(true);
    expect(inst.data.existingOrderNo).toBe('FY-XSD-WX-2609220002');
  });

  test('支付参数获取失败 → 不冻结（服务端没建成场次，顾客应能改方案重试）', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.pay') return Promise.resolve({ paymentParams: null });
      return Promise.resolve({});
    });
    const inst = createPageInstance({ prepaidCardAmount: 0, paidAmount: 200 });

    await inst.doWechatPay('FY-XSD-WX-2609220003');

    expect(inst.data.hasActivePaymentIntent).toBe(false);
    expect(inst.data.existingOrderNo).toBe('');
  });

  test('冻结后再次提交 → 跳过 scanAdjust 直接复用场次（此前会被 PAYMENT_INTENT_ACTIVE 拒掉）', async () => {
    const paymentParams = { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'RSA', paySign: 's' };
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.pay') return Promise.resolve({ paymentParams });
      return Promise.resolve({});
    });
    wxMock.requestPayment.mockRejectedValueOnce(new Error('requestPayment:fail network'));
    const inst = createPageInstance({
      prepaidCardAmount: 0, paidAmount: 200, paymentMethod: '微信', agreed: true,
    });

    await expect(inst.doWechatPay('FY-XSD-WX-2609220004')).rejects.toThrow();
    callClientApiMock.mockClear();
    wxMock.requestPayment.mockResolvedValueOnce({});

    await inst.onSubmitOrder();

    const actions = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(actions).not.toContain('order.scanAdjust');
    expect(actions).not.toContain('order.create');
    expect(actions).toContain('order.pay');
  });
});

describe('#214 冻结期的金额展示口径', () => {
  test('卡余额上涨不改写展示 —— 仍用渠道单冻结的卡额（否则展示实付与实收分叉）', () => {
    const inst = createPageInstance({
      existingOrderNo: 'FY-XSD-WX-2609220005',
      hasActivePaymentIntent: true,
      restoredPrepaidCardAmount: 100,
      unitPrice: 300,
      quantity: 1,
      cardBalance: 300,     // 顾客在意图活跃期充值，余额已够全额抵扣
      useCard: true,
    });

    inst.recomputeAmounts();

    expect(inst.data.prepaidCardAmount).toBe(100);
    expect(inst.data.paidAmount).toBe(200);
    expect(inst.data.showPayMethodGroup).toBe(true);
  });

  test('余额查询失败把 cardBalance 打到 0 → 冻结的抵扣行不能凭空消失', () => {
    const inst = createPageInstance({
      existingOrderNo: 'FY-XSD-WX-2609220006',
      hasActivePaymentIntent: true,
      restoredPrepaidCardAmount: 100,
      unitPrice: 300,
      quantity: 1,
      cardBalance: 0,
      useCard: false,       // loadCardBalance 的失败分支会这么置
    });

    inst.recomputeAmounts();

    expect(inst.data.useCard).toBe(true);
    expect(inst.data.prepaidCardAmount).toBe(100);
    expect(inst.data.paidAmount).toBe(200);
  });

  test('无活动意图时仍按实时余额重算（不影响既有的方案调整路径）', () => {
    const inst = createPageInstance({
      existingOrderNo: 'FY-XSD-WX-2609220007',
      hasActivePaymentIntent: false,
      restoredPrepaidCardAmount: 100,
      unitPrice: 300,
      quantity: 1,
      cardBalance: 300,
      useCard: true,
    });

    inst.recomputeAmounts();

    expect(inst.data.prepaidCardAmount).toBe(300);
    expect(inst.data.paidAmount).toBe(0);
  });

  test('冻结卡额超过应付净额时按净额封顶，实付不为负', () => {
    const inst = createPageInstance({
      existingOrderNo: 'FY-XSD-WX-2609220008',
      hasActivePaymentIntent: true,
      restoredPrepaidCardAmount: 500,
      unitPrice: 300,
      quantity: 1,
      couponDiscount: 50,
      cardBalance: 0,
      useCard: true,
    });

    inst.recomputeAmounts();

    expect(inst.data.prepaidCardAmount).toBe(250);
    expect(inst.data.paidAmount).toBe(0);
    expect(inst.data.showPayMethodGroup).toBe(false);
  });
});
