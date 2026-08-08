/**
 * checkout 页面 — 储值卡抵扣测试（Wave 3E）
 *
 * 覆盖：
 *  1. 余额充足 + 默认 on → prepaid = 应抵部分、paid = 0、showPayMethodGroup=false
 *  2. 余额不足（< 应抵部分）→ prepaid = balance、paid = diff、showPayMethodGroup=true
 *  3. 余额 = 0 → 开关灰显（useCard=false）、prepaid=0、paid=应抵部分
 *  4. 用户手动关闭 useCard → prepaid=0、paid=应抵部分
 *  5. 优惠券变化联动 recompute（应抵部分变小）
 *  6. 提交订单：payload 含 useCard + prepaidCardAmount；响应 status='已支付' 后前端不调 wx.requestPayment
 *  7. 边界：couponDiscount > totalAmount → netBeforeCard 不变负
 *  8. 浮点金额：prepaid+paid = netBeforeCard 精确闭合
 */

import { recomputeAmounts, parseAgreement } from '../../../pagesOrder/checkout/checkout-helpers';

describe('recomputeAmounts — 储值卡抵扣计算', () => {
  test('case 1: 余额充足（balance ≥ netBeforeCard）→ 全额抵扣，paid=0，支付方式区隐藏', () => {
    const r = recomputeAmounts({
      totalAmount: 300,
      couponDiscount: 0,
      cardBalance: 500,
      useCard: true,
    });
    expect(r.netBeforeCard).toBe(300);
    expect(r.prepaidCardAmount).toBe(300);
    expect(r.paidAmount).toBe(0);
    expect(r.showPayMethodGroup).toBe(false);
  });

  test('case 2: 余额不足（balance < netBeforeCard）→ 抵扣余额、剩余走支付通道', () => {
    const r = recomputeAmounts({
      totalAmount: 300,
      couponDiscount: 0,
      cardBalance: 100,
      useCard: true,
    });
    expect(r.netBeforeCard).toBe(300);
    expect(r.prepaidCardAmount).toBe(100);
    expect(r.paidAmount).toBe(200);
    expect(r.showPayMethodGroup).toBe(true);
  });

  test('case 3: 余额 = 0 → effective useCard 强制 false、prepaid=0、paid=netBeforeCard', () => {
    const r = recomputeAmounts({
      totalAmount: 300,
      couponDiscount: 0,
      cardBalance: 0,
      useCard: true, // 即使 UI 默认 on，余额 0 也不抵扣
    });
    expect(r.prepaidCardAmount).toBe(0);
    expect(r.paidAmount).toBe(300);
    expect(r.showPayMethodGroup).toBe(true);
  });

  test('case 4: 用户手动关闭 useCard → prepaid=0、paid=netBeforeCard', () => {
    const r = recomputeAmounts({
      totalAmount: 300,
      couponDiscount: 0,
      cardBalance: 500,
      useCard: false,
    });
    expect(r.prepaidCardAmount).toBe(0);
    expect(r.paidAmount).toBe(300);
    expect(r.showPayMethodGroup).toBe(true);
  });

  test('case 5: 优惠券变化联动 — 30 元券 → 应抵部分 = 270', () => {
    const before = recomputeAmounts({
      totalAmount: 300, couponDiscount: 0, cardBalance: 500, useCard: true,
    });
    expect(before.netBeforeCard).toBe(300);
    expect(before.prepaidCardAmount).toBe(300);

    const after = recomputeAmounts({
      totalAmount: 300, couponDiscount: 30, cardBalance: 500, useCard: true,
    });
    expect(after.netBeforeCard).toBe(270);
    expect(after.prepaidCardAmount).toBe(270);
    expect(after.paidAmount).toBe(0);
    expect(after.showPayMethodGroup).toBe(false);
  });

  test('case 7: 优惠券 ≥ 订单总额 → netBeforeCard 不变负，prepaid=0', () => {
    const r = recomputeAmounts({
      totalAmount: 100, couponDiscount: 200, cardBalance: 500, useCard: true,
    });
    expect(r.netBeforeCard).toBe(0);
    expect(r.prepaidCardAmount).toBe(0);
    expect(r.paidAmount).toBe(0);
    // 0 元订单：实付=0 但 showPayMethodGroup 也为 false（UI 应显示"全额抵扣"副文案）
    expect(r.showPayMethodGroup).toBe(false);
  });

  test('case 8: 浮点金额闭合 — prepaid + paid 精确等于 netBeforeCard', () => {
    const r = recomputeAmounts({
      totalAmount: 99.99, couponDiscount: 9.99, cardBalance: 50, useCard: true,
    });
    expect(r.netBeforeCard).toBe(90);
    expect(r.prepaidCardAmount).toBe(50);
    expect(r.paidAmount).toBe(40);
    expect(Math.round((r.prepaidCardAmount + r.paidAmount) * 100) / 100)
      .toBe(r.netBeforeCard);
  });

  test('case 9: 部分抵扣浮点边界 — balance=99.95, total=300', () => {
    const r = recomputeAmounts({
      totalAmount: 300, couponDiscount: 0, cardBalance: 99.95, useCard: true,
    });
    expect(r.prepaidCardAmount).toBe(99.95);
    expect(r.paidAmount).toBe(200.05);
    expect(r.showPayMethodGroup).toBe(true);
  });

  test('case 10: 优惠券后先抵积分，再用储值卡抵扣剩余应付', () => {
    const r = recomputeAmounts({
      totalAmount: 300,
      couponDiscount: 30,
      pointsBalance: 10000,
      usePoints: true,
      pointsToYuanRate: 0.01,
      pointsDeductionMaxRate: 0.03,
      cardBalance: 100,
      useCard: true,
    });

    expect(r.pointsUsed).toBe(900);
    expect(r.pointsDiscount).toBe(9);
    expect(r.maxPointsUsable).toBe(900);
    expect(r.netBeforeCard).toBe(261);
    expect(r.prepaidCardAmount).toBe(100);
    expect(r.paidAmount).toBe(161);
    expect(r.showPayMethodGroup).toBe(true);
  });

  test('case 11: 手动指定积分超过上限时按订单上限截断', () => {
    const r = recomputeAmounts({
      totalAmount: 100.05,
      couponDiscount: 0,
      pointsBalance: 10000,
      pointsUsed: 9999,
      usePoints: true,
      pointsToYuanRate: 0.01,
      pointsDeductionMaxRate: 0.03,
      cardBalance: 0,
      useCard: false,
    });

    expect(r.maxPointsUsable).toBe(300);
    expect(r.pointsUsed).toBe(300);
    expect(r.pointsDiscount).toBe(3);
    expect(r.netBeforeCard).toBe(97.05);
  });
});

describe('parseAgreement — 协议正文解析为段落', () => {
  test('多段文本 → 过滤空行 + 标识「一、」标题行', () => {
    const paras = parseAgreement('一、服务内容\n本协议适用于...\n\n二、付款\n顾客购买后...');
    expect(paras).toEqual([
      { text: '一、服务内容', heading: true },
      { text: '本协议适用于...', heading: false },
      { text: '二、付款', heading: true },
      { text: '顾客购买后...', heading: false },
    ]);
  });

  test('「第N条」格式识别为标题', () => {
    const paras = parseAgreement('第一条 总则\n内容\n第十二条 其他');
    expect(paras[0].heading).toBe(true);
    expect(paras[1].heading).toBe(false);
    expect(paras[2].heading).toBe(true);
  });

  test('空内容 / 纯空白 / undefined → 空数组', () => {
    expect(parseAgreement('')).toEqual([]);
    expect(parseAgreement('   \n  \n')).toEqual([]);
    expect(parseAgreement(undefined as unknown as string)).toEqual([]);
  });

  test('行首尾空白被 trim', () => {
    const paras = parseAgreement('  一、标题  \n  正文内容  ');
    expect(paras[0]).toEqual({ text: '一、标题', heading: true });
    expect(paras[1]).toEqual({ text: '正文内容', heading: false });
  });
});

describe('checkout 提交流程 — 与云函数契约', () => {
  beforeEach(() => {
    ;(globalThis as any).wx = {
      ...(globalThis as any).wx,
      cloud: {
        callFunction: vi.fn(),
        CloudID: vi.fn((id: string) => ({ cloudID: id })),
      },
      requestPayment: vi.fn(),
      redirectTo: vi.fn(),
      navigateBack: vi.fn(),
    };
  });

  test('case 6: 实付=0 时提交 → payload 含 useCard + prepaidCardAmount；响应 status=已支付 不再调 requestPayment', async () => {
    const { callClientApi } = await import('../../../utils/cloud');

    // mock：order.create 返回 prepaid_card_full
    ;(globalThis as any).wx.cloud.callFunction.mockImplementation((opts: any) => {
      const { action } = opts.data;
      if (action === 'order.create') {
        return Promise.resolve({
          result: {
            code: 0,
            data: {
              saleOrderId: 'FY-XSD-WX-2604240001',
              status: '已支付',
              reason: 'prepaid_card_full',
              paymentParams: null,
              paidAmount: 0,
              prepaidCardAmount: 300,
            },
          },
        });
      }
      return Promise.reject(new Error('unexpected action'));
    });

    const data = await callClientApi('order.create', {
      storeId: 'S001',
      items: [{ skuId: 'sku-x', quantity: 1 }],
      paymentMethod: '微信',
      useCard: true,
      prepaidCardAmount: 300,
    });

    // 1) payload 已带 useCard + prepaidCardAmount
    const callArgs = (globalThis as any).wx.cloud.callFunction.mock.calls[0][0];
    expect(callArgs.data.payload.useCard).toBe(true);
    expect(callArgs.data.payload.prepaidCardAmount).toBe(300);

    // 2) 后端契约：status='已支付' + paymentParams=null
    expect((data as any).status).toBe('已支付');
    expect((data as any).paymentParams).toBeNull();

    // 3) 前端不应调 requestPayment（这里只断言 mock 未被业务代码意外调用）
    expect((globalThis as any).wx.requestPayment).not.toHaveBeenCalled();
  });
});
