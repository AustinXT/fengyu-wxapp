/**
 * recharge.ts 工具函数测试
 * 覆盖：matchTier 边界、formatAmount 输出
 *
 * 2026-05-21 三端统一：cfg 入参由 API 注入，本测试用 mock cfg 复现生产 system_configs 种子
 */

import {
  matchTier,
  formatAmount,
  RechargeConfig,
} from '../../../pagesProfile/card-recharge/recharge';

// 镜像 migration 0043_pretty_shaman.sql 中的 recharge.* 种子
const CFG: RechargeConfig = {
  tiers: [
    { faceValue: 500, payAmount: 495, discount: 0.99 },
    { faceValue: 1000, payAmount: 980, discount: 0.98 },
    { faceValue: 5000, payAmount: 4750, discount: 0.95 },
  ],
  minAmount: 500,
  maxAmount: 100000,
};

describe('matchTier — 金额校验', () => {
  test('低于最低限额抛错', () => {
    expect(() => matchTier(499, CFG)).toThrow(/最低充值金额/);
    expect(() => matchTier(0, CFG)).toThrow(/最低充值金额/);
    expect(() => matchTier(-100, CFG)).toThrow(/最低充值金额/);
  });

  test('高于最高限额抛错', () => {
    expect(() => matchTier(100001, CFG)).toThrow(/单次充值上限/);
    expect(() => matchTier(99999999, CFG)).toThrow(/单次充值上限/);
  });

  test('小数位 > 2 抛错', () => {
    expect(() => matchTier(500.123, CFG)).toThrow(/2 位小数/);
    expect(() => matchTier(999.999, CFG)).toThrow(/2 位小数/);
  });

  test('NaN/Infinity 抛错', () => {
    expect(() => matchTier(NaN, CFG)).toThrow(/格式错误/);
    expect(() => matchTier(Infinity, CFG)).toThrow(/格式错误/);
    expect(() => matchTier('500' as any, CFG)).toThrow(/格式错误/);
  });

  test('边界值 cfg.minAmount/maxAmount 不抛错', () => {
    expect(() => matchTier(CFG.minAmount, CFG)).not.toThrow();
    expect(() => matchTier(CFG.maxAmount, CFG)).not.toThrow();
  });
});

describe('matchTier — 档位匹配', () => {
  test('500（精确命中）→ 实付 495 折扣 0.99', () => {
    expect(matchTier(500, CFG)).toEqual({ discount: 0.99, payAmount: 495 });
  });

  test('999（非命中，按 500 档比例 0.99）→ 实付 989.01', () => {
    expect(matchTier(999, CFG)).toEqual({ discount: 0.99, payAmount: 989.01 });
  });

  test('1000（精确命中）→ 实付 980 折扣 0.98', () => {
    expect(matchTier(1000, CFG)).toEqual({ discount: 0.98, payAmount: 980 });
  });

  test('1500（非命中，按 1000 档比例 0.98）→ 实付 1470', () => {
    expect(matchTier(1500, CFG)).toEqual({ discount: 0.98, payAmount: 1470 });
  });

  test('4999（非命中，按 1000 档比例 0.98）→ 实付 4899.02', () => {
    expect(matchTier(4999, CFG)).toEqual({ discount: 0.98, payAmount: 4899.02 });
  });

  test('5000（精确命中）→ 实付 4750 折扣 0.95', () => {
    expect(matchTier(5000, CFG)).toEqual({ discount: 0.95, payAmount: 4750 });
  });

  test('10000（非命中，按 5000 档比例 0.95）→ 实付 9500', () => {
    expect(matchTier(10000, CFG)).toEqual({ discount: 0.95, payAmount: 9500 });
  });

  test('50000（非命中，按 5000 档比例 0.95）→ 实付 47500', () => {
    expect(matchTier(50000, CFG)).toEqual({ discount: 0.95, payAmount: 47500 });
  });

  test('实付始终 ≤ 面值（"送钱"语义）', () => {
    [500, 999, 1000, 4999, 5000, 100000].forEach((face) => {
      const { payAmount } = matchTier(face, CFG);
      expect(payAmount).toBeLessThanOrEqual(face);
    });
  });
});

describe('formatAmount', () => {
  test('整数去除小数位', () => {
    expect(formatAmount(500)).toBe('500');
    expect(formatAmount(495)).toBe('495');
    expect(formatAmount(0)).toBe('0');
  });

  test('保留 2 位小数', () => {
    expect(formatAmount(989.01)).toBe('989.01');
    expect(formatAmount(4899.02)).toBe('4899.02');
  });

  test('四舍五入到 2 位', () => {
    expect(formatAmount(989.005)).toBe('989.01');
    expect(formatAmount(989.014)).toBe('989.01');
  });

  test('非有限数 → "0"', () => {
    expect(formatAmount(NaN)).toBe('0');
    expect(formatAmount(Infinity)).toBe('0');
  });
});
