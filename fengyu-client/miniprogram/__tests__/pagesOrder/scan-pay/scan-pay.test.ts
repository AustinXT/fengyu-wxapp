/**
 * scan-pay 页面测试
 * 覆盖：
 *   - scan-pay.logic 纯函数（recompute / decideConfirmRoute）
 *   - 页面行为：通过 Page mock 捕获 Page options，调用其方法验证 setData / API 调用顺序
 */

import { vi } from 'vitest';
import {
  recomputeAmounts,
  decideConfirmRoute,
} from '../../../pagesOrder/scan-pay/scan-pay.logic';

// ====== Mock 微信全局 + Page + utils/cloud ======
const callClientApiMock = vi.fn();
vi.mock('../../../utils/cloud', () => ({
  callClientApi: (...args: any[]) => callClientApiMock(...args),
  bindPhoneWithCloudID: vi.fn(),
  sanitizeErrorMessage: (msg: string) => msg,
}));

// Mock Toast (Vant)
vi.mock('@vant/weapp/toast/toast', () => ({
  default: {
    success: vi.fn(),
    fail: vi.fn(),
  },
}));

let pageOptions: any = null;
(globalThis as any).Page = (opts: any) => {
  pageOptions = opts;
};

// 微信 wx 全局补全
const wxMock: any = (globalThis as any).wx || {};
wxMock.cloud = wxMock.cloud || { callFunction: vi.fn(), CloudID: vi.fn() };
wxMock.requestPayment = vi.fn(async () => ({}));
wxMock.redirectTo = vi.fn();
wxMock.switchTab = vi.fn();
wxMock.showModal = vi.fn();
(globalThis as any).wx = wxMock;

// 触发模块求值（运行 Page() 注册）
beforeAll(async () => {
  await import('../../../pagesOrder/scan-pay/scan-pay');
});

/** 创建一个"页面实例"：把 data 拷一份，方法绑定到该实例 */
function createPageInstance(initialData: any = {}) {
  const instance: any = {
    data: { ...pageOptions.data, ...initialData },
    setData(patch: any) {
      Object.assign(this.data, patch);
    },
  };
  // 把方法挂到实例上
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
  wxMock.requestPayment.mockClear();
  wxMock.redirectTo.mockClear();
  wxMock.switchTab.mockClear();
  wxMock.showModal.mockReset();
});

// ============ 纯逻辑 ============
describe('scan-pay.logic — recomputeAmounts', () => {
  test('useCard=false → prepaid=0, paid=total-coupon', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 50, cardBalance: 200, useCard: false });
    expect(r).toEqual({ payable: 250, prepaidCardAmount: 0, paidAmount: 250 });
  });
  test('useCard=true 且余额充足 → 全额抵扣', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 500, useCard: true });
    expect(r).toEqual({ payable: 300, prepaidCardAmount: 300, paidAmount: 0 });
  });
  test('useCard=true 但余额不足 → 部分抵扣', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 100, useCard: true });
    expect(r).toEqual({ payable: 300, prepaidCardAmount: 100, paidAmount: 200 });
  });
  test('useCard=true 但余额=0 → prepaid=0', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 0, useCard: true });
    expect(r).toEqual({ payable: 300, prepaidCardAmount: 0, paidAmount: 300 });
  });
  // payableBase 覆盖（回款场景：储值卡只抵扣尾款 remaining，而非全额 total-coupon）
  test('payableBase（回款）useCard=false → paid=remaining', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 500, useCard: false, payableBase: 200 });
    expect(r).toEqual({ payable: 200, prepaidCardAmount: 0, paidAmount: 200 });
  });
  test('payableBase（回款）useCard=true 余额充足 → 全额抵扣尾款', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 500, useCard: true, payableBase: 200 });
    expect(r).toEqual({ payable: 200, prepaidCardAmount: 200, paidAmount: 0 });
  });
  test('payableBase（回款）useCard=true 余额不足 → 部分抵扣尾款', () => {
    const r = recomputeAmounts({ totalAmount: 300, couponDiscount: 0, cardBalance: 80, useCard: true, payableBase: 200 });
    expect(r).toEqual({ payable: 200, prepaidCardAmount: 80, paidAmount: 120 });
  });
});

describe('scan-pay.logic — decideConfirmRoute', () => {
  test('paid=0 → confirmPrepaidFull', () => {
    expect(decideConfirmRoute(0, '微信')).toBe('confirmPrepaidFull');
  });
  test('paid>0 + 微信 → wechatPay', () => {
    expect(decideConfirmRoute(100, '微信')).toBe('wechatPay');
  });
  test('paid>0 + 线下 → offlinePay', () => {
    expect(decideConfirmRoute(100, '线下')).toBe('offlinePay');
  });
});

// ============ 页面行为 ============
describe('scan-pay 页面行为', () => {
  test('预选全额抵扣：进入页 useCard=on, prepaid=total, paid=0；点确认调 confirmPrepaidFull', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-001', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '张三', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 300, paidAmount: 0,
            paymentMethod: '无', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 500, cardId: 'c1' });
      if (action === 'order.confirmPrepaidFull') return Promise.resolve({ status: '已支付' });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-001');

    expect(inst.data.useCard).toBe(true);
    expect(inst.data.prepaidCardAmount).toBe(300);
    expect(inst.data.paidAmount).toBe(0);
    expect(inst.data.showPayMethodGroup).toBe(false);

    inst.data.orderNo = 'FY-001';
    await inst.onSubmit();

    const calls = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('order.confirmPrepaidFull');
    expect(calls).not.toContain('order.pay');
    expect(calls).not.toContain('order.offlinePay');
  });

  test('顾客关掉抵扣：scanAdjust 入参 useCard=false，paid=total；点确认调 pay + requestPayment', async () => {
    callClientApiMock.mockImplementation((action: string, payload: any) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-002', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '李四', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 300, paidAmount: 0,
            paymentMethod: '无', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 500, cardId: 'c1' });
      if (action === 'order.scanAdjust') return Promise.resolve({ saleOrderId: payload.saleOrderId });
      if (action === 'order.pay') return Promise.resolve({ paymentParams: { timeStamp: '1', paySign: 'sig' } });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-002');
    inst.data.orderNo = 'FY-002';

    // 顾客关掉储值卡开关
    await inst.onUseCardChange({ detail: false });
    expect(inst.data.useCard).toBe(false);
    expect(inst.data.paidAmount).toBe(300);
    expect(inst.data.showPayMethodGroup).toBe(true);

    const adjustCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.scanAdjust');
    expect(adjustCall).toBeDefined();
    expect(adjustCall![1]).toMatchObject({ saleOrderId: 'FY-002', useCard: false });

    // 点确认支付
    await inst.onSubmit();
    const calls = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('order.pay');
    expect(wxMock.requestPayment).toHaveBeenCalledTimes(1);
  });

  test('顾客部分抵扣 + 微信：confirm 调 pay + wx.requestPayment', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-003', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 100, paidAmount: 200,
            paymentMethod: '微信', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 100, cardId: 'c1' });
      if (action === 'order.pay') return Promise.resolve({ paymentParams: { timeStamp: '1', paySign: 'sig' } });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-003');
    inst.data.orderNo = 'FY-003';
    expect(inst.data.useCard).toBe(true);
    expect(inst.data.paidAmount).toBe(200);
    expect(inst.data.paymentMethod).toBe('微信');

    await inst.onSubmit();
    const calls = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('order.pay');
    expect(wxMock.requestPayment).toHaveBeenCalledTimes(1);
  });

  test('顾客部分抵扣 + 线下：confirm 调 offlinePay', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-004', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 100, paidAmount: 200,
            paymentMethod: '微信', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 100, cardId: 'c1' });
      if (action === 'order.scanAdjust') return Promise.resolve({});
      if (action === 'order.offlinePay') return Promise.resolve({ status: '待支付' });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-004');
    inst.data.orderNo = 'FY-004';

    // 顾客切到线下
    await inst.onPayMethodChange({ detail: '线下' });
    expect(inst.data.paymentMethod).toBe('线下');

    await inst.onSubmit();
    const calls = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('order.offlinePay');
    expect(calls).not.toContain('order.pay');
    expect(wxMock.requestPayment).not.toHaveBeenCalled();
  });

  test('INSUFFICIENT_BALANCE → 弹框含两按钮（关闭抵扣重付 / 取消订单）', async () => {
    let payCalls = 0;
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-005', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 300, paidAmount: 0,
            paymentMethod: '无', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 500, cardId: 'c1' });
      if (action === 'order.confirmPrepaidFull') {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足');
      }
      if (action === 'order.scanAdjust') return Promise.resolve({});
      if (action === 'order.pay') {
        payCalls += 1;
        return Promise.resolve({ paymentParams: { timeStamp: '1' } });
      }
      return Promise.resolve({});
    });

    // showModal 用户点"关闭抵扣重付"（confirm=true）
    wxMock.showModal.mockImplementation((opts: any) => {
      opts.success({ confirm: true, cancel: false });
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-005');
    inst.data.orderNo = 'FY-005';

    await inst.onSubmit();

    // 弹框被调起，参数含两按钮文案
    expect(wxMock.showModal).toHaveBeenCalledTimes(1);
    const modalArg = wxMock.showModal.mock.calls[0][0];
    expect(modalArg.confirmText).toBe('关闭抵扣重付');
    expect(modalArg.cancelText).toBe('取消订单');

    // 关闭抵扣 → useCard=false → 重新调 pay
    expect(inst.data.useCard).toBe(false);
    expect(payCalls).toBe(1);
  });

  // ====== 2026-05-19 dirty-read 修复 ======
  test('pushAdjust 后 balanceUpdatedAt 写入 data（来自 scanAdjust.balanceSnapshot.updatedAt）', async () => {
    const snapTs = '2026-05-19T10:00:00.000Z';
    callClientApiMock.mockImplementation((action: string, payload: any) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-VER-1', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 300, paidAmount: 0,
            paymentMethod: '无', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 500, cardId: 'c1' });
      if (action === 'order.scanAdjust') {
        return Promise.resolve({
          saleOrderId: payload.saleOrderId,
          prepaidCardAmount: 300,
          paidAmount: 0,
          balanceSnapshot: { cardId: 'c1', balance: 500, updatedAt: snapTs },
        });
      }
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-VER-1');
    inst.data.orderNo = 'FY-VER-1';

    // 切换抵扣开关 → 触发 pushAdjust
    await inst.onUseCardChange({ detail: false });
    expect(inst.data.balanceUpdatedAt).toBe(snapTs);

    // 关掉抵扣后再开回 → pushAdjust 再次写入版本号
    await inst.onUseCardChange({ detail: true });
    expect(inst.data.balanceUpdatedAt).toBe(snapTs);
  });

  test('confirmPrepaidFull 抛 CONFLICT → 调用 handleBalanceConflict + 重拉 card.balance', async () => {
    const snapTs = '2026-05-19T10:00:00.000Z';
    let balanceCalls = 0;
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-VER-2', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 300, paidAmount: 0,
            paymentMethod: '无', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') {
        balanceCalls += 1;
        // 第一次 onLoad 阶段返回 500，CONFLICT 后第二次返回 80
        return Promise.resolve({ balance: balanceCalls === 1 ? 500 : 80, cardId: 'c1' });
      }
      if (action === 'order.scanAdjust') {
        return Promise.resolve({
          balanceSnapshot: { cardId: 'c1', balance: 500, updatedAt: snapTs },
        });
      }
      if (action === 'order.confirmPrepaidFull') {
        const err: any = new Error('CONFLICT: 储值卡余额已变动，请刷新页面后重新选择抵扣金额');
        err.errorType = 'CONFLICT';
        throw err;
      }
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-VER-2');
    inst.data.orderNo = 'FY-VER-2';
    // 模拟前端已记下版本号
    inst.data.balanceUpdatedAt = snapTs;

    await inst.onSubmit();

    // confirmPrepaidFull 抛 CONFLICT → handleBalanceConflict 被走到
    // 表现：再次调用 card.balance（balanceCalls=2）+ data.cardBalance 更新为 80 + balanceUpdatedAt 重置 null
    expect(balanceCalls).toBe(2);
    expect(inst.data.cardBalance).toBe(80);
    expect(inst.data.balanceUpdatedAt).toBeNull();
    // 不应进入 INSUFFICIENT_BALANCE 弹框分支
    expect(wxMock.showModal).not.toHaveBeenCalled();
  });

  test('余额为 0：储值卡开关灰显且无法切 on（disabled wxml binding + onUseCardChange 拦截）', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-006', status: '待支付', storeId: 's1', storeName: '门店A',
            openerName: '王五', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 0, paidAmount: 300,
            paymentMethod: '微信', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 0, cardId: null });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-006');

    expect(inst.data.cardBalance).toBe(0);
    expect(inst.data.useCard).toBe(false);

    // 模拟用户尝试切到 on（即使 disabled，也写个守卫验证）
    await inst.onUseCardChange({ detail: true });
    expect(inst.data.useCard).toBe(false);
    expect(inst.data.prepaidCardAmount).toBe(0);
    expect(inst.data.paidAmount).toBe(300);
    // 不应触发 scanAdjust
    const adjustCalls = callClientApiMock.mock.calls.filter((c: any[]) => c[0] === 'order.scanAdjust');
    expect(adjustCalls).toHaveLength(0);
  });
});

// ============ 回款（部分支付）场景：走 order.repay ============
describe('scan-pay 回款（部分支付）场景', () => {
  // 部分支付：total=300、已到账 100 → remaining=200
  function mockRepay(orderNo: string, balance: number, repayResp: any) {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo, status: '部分支付', storeId: 's1', storeName: '门店A',
            openerName: '店长', orderType: '销售单',
            totalAmount: 300, prepaidCardAmount: 0, payableAmount: 300,
            received: 100, refundedAmount: 0,
            paymentMethod: '微信', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance, cardId: balance > 0 ? 'c1' : null });
      if (action === 'order.repay') return Promise.resolve(repayResp);
      return Promise.resolve({});
    });
  }

  test('默认（未勾卡）：remaining=200、isRepayment=true；确认走 order.repay(微信全额)，不走 pay/scanAdjust', async () => {
    mockRepay('FY-R1', 500, { paymentParams: { paySign: 'x' } });
    const inst = createPageInstance();
    await inst.loadOrder('FY-R1');
    inst.data.orderNo = 'FY-R1';
    expect(inst.data.isRepayment).toBe(true);
    expect(inst.data.useCard).toBe(false);
    expect(inst.data.remaining).toBe(200);
    expect(inst.data.paidAmount).toBe(200);
    expect(inst.data.paymentMethod).toBe('微信');

    await inst.onSubmit();
    const repayCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.repay');
    expect(repayCall).toBeDefined();
    expect(repayCall![1]).toMatchObject({ saleOrderId: 'FY-R1', paymentMethod: '微信', repayAmount: 200, prepaidCardAmount: 0 });
    expect(wxMock.requestPayment).toHaveBeenCalledTimes(1);
    const calls = callClientApiMock.mock.calls.map((c: any[]) => c[0]);
    expect(calls).not.toContain('order.scanAdjust');
    expect(calls).not.toContain('order.pay');
  });

  test('转换单已冻结本次部分回款：页面显示500且走 order.pay 显式提交500，不放大为剩余1500', async () => {
    callClientApiMock.mockImplementation((action: string) => {
      if (action === 'order.scanDetail') {
        return Promise.resolve({
          order: {
            orderNo: 'FY-CONV-CAP', status: '部分支付', storeId: 's1', storeName: '门店A',
            openerName: '店长', orderType: '转换单',
            totalAmount: 2000, prepaidCardAmount: 0, payableAmount: 2000,
            received: 500, refundedAmount: 0, firstPaymentAmount: 500,
            paymentMethod: '微信', couponDiscount: 0,
          },
          items: [],
        });
      }
      if (action === 'card.balance') return Promise.resolve({ balance: 0, cardId: null });
      if (action === 'order.pay') return Promise.resolve({ paymentParams: { paySign: 'x' } });
      return Promise.resolve({});
    });

    const inst = createPageInstance();
    await inst.loadOrder('FY-CONV-CAP');
    inst.data.orderNo = 'FY-CONV-CAP';

    expect(inst.data.isRepayment).toBe(true);
    expect(inst.data.remaining).toBe(1500);
    expect(inst.data.paidAmount).toBe(500);

    await inst.onSubmit();

    const payCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.pay');
    expect(payCall?.[1]).toEqual({ saleOrderId: 'FY-CONV-CAP', payAmount: 500 });
    expect(callClientApiMock.mock.calls.map((c: any[]) => c[0])).not.toContain('order.repay');
    expect(wxMock.requestPayment).toHaveBeenCalledTimes(1);
  });

  test('勾卡(余额不足尾款)：抵扣 80、付 120；order.repay(微信+卡混合)，回款不调 scanAdjust', async () => {
    mockRepay('FY-R2', 80, { paymentParams: { paySign: 'x' } });
    const inst = createPageInstance();
    await inst.loadOrder('FY-R2');
    inst.data.orderNo = 'FY-R2';

    await inst.onUseCardChange({ detail: true });
    expect(inst.data.prepaidCardAmount).toBe(80);
    expect(inst.data.paidAmount).toBe(120);
    expect(callClientApiMock.mock.calls.filter((c: any[]) => c[0] === 'order.scanAdjust')).toHaveLength(0);

    await inst.onSubmit();
    const repayCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.repay');
    expect(repayCall![1]).toMatchObject({ paymentMethod: '微信', repayAmount: 120, prepaidCardAmount: 80 });
    expect(wxMock.requestPayment).toHaveBeenCalledTimes(1);
  });

  test('勾卡(余额覆盖全部尾款)：paid=0；order.repay(纯储值卡)，不调起微信支付', async () => {
    mockRepay('FY-R3', 500, { status: '已支付', paymentMethod: '储值卡' });
    const inst = createPageInstance();
    await inst.loadOrder('FY-R3');
    inst.data.orderNo = 'FY-R3';

    await inst.onUseCardChange({ detail: true });
    expect(inst.data.prepaidCardAmount).toBe(200);
    expect(inst.data.paidAmount).toBe(0);
    expect(inst.data.showPayMethodGroup).toBe(false);

    await inst.onSubmit();
    const repayCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.repay');
    expect(repayCall![1]).toMatchObject({ paymentMethod: '储值卡', repayAmount: 0, prepaidCardAmount: 200 });
    expect(wxMock.requestPayment).not.toHaveBeenCalled();
  });

  test('切支付宝：order.repay(支付宝) + 吱口令弹窗', async () => {
    mockRepay('FY-R4', 0, { alipayShareToken: 'ZHI-XXX' });
    const inst = createPageInstance();
    await inst.loadOrder('FY-R4');
    inst.data.orderNo = 'FY-R4';

    await inst.onPayMethodChange({ detail: '支付宝' });
    expect(inst.data.paymentMethod).toBe('支付宝');

    await inst.onSubmit();
    const repayCall = callClientApiMock.mock.calls.find((c: any[]) => c[0] === 'order.repay');
    expect(repayCall![1]).toMatchObject({ paymentMethod: '支付宝', repayAmount: 200, prepaidCardAmount: 0 });
    expect(inst.data.showAlipayShare).toBe(true);
    expect(inst.data.alipayShareToken).toBe('ZHI-XXX');
    expect(wxMock.requestPayment).not.toHaveBeenCalled();
  });
});
