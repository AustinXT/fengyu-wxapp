/**
 * recharge.ts 工具函数测试
 * 覆盖：matchTier 边界、formatAmount 输出
 */

import {
  matchTier,
  formatAmount,
  RECHARGE_MIN_AMOUNT,
  RECHARGE_MAX_AMOUNT,
} from '../../../pagesProfile/card-recharge/recharge';

describe('matchTier — 金额校验', () => {
  test('低于最低限额抛错', () => {
    expect(() => matchTier(499)).toThrow(/最低充值金额/);
    expect(() => matchTier(0)).toThrow(/最低充值金额/);
    expect(() => matchTier(-100)).toThrow(/最低充值金额/);
  });

  test('高于最高限额抛错', () => {
    expect(() => matchTier(100001)).toThrow(/单次充值上限/);
    expect(() => matchTier(99999999)).toThrow(/单次充值上限/);
  });

  test('小数位 > 2 抛错', () => {
    expect(() => matchTier(500.123)).toThrow(/2 位小数/);
    expect(() => matchTier(999.999)).toThrow(/2 位小数/);
  });

  test('NaN/Infinity 抛错', () => {
    expect(() => matchTier(NaN)).toThrow(/格式错误/);
    expect(() => matchTier(Infinity)).toThrow(/格式错误/);
    expect(() => matchTier('500' as any)).toThrow(/格式错误/);
  });

  test('边界值 RECHARGE_MIN/MAX 不抛错', () => {
    expect(() => matchTier(RECHARGE_MIN_AMOUNT)).not.toThrow();
    expect(() => matchTier(RECHARGE_MAX_AMOUNT)).not.toThrow();
  });
});

describe('matchTier — 档位匹配', () => {
  test('500 → 9.9 折，实付 495', () => {
    expect(matchTier(500)).toEqual({ discount: 0.99, payAmount: 495 });
  });

  test('999 → 9.9 折，实付 989.01', () => {
    expect(matchTier(999)).toEqual({ discount: 0.99, payAmount: 989.01 });
  });

  test('1000 → 9.8 折，实付 980', () => {
    expect(matchTier(1000)).toEqual({ discount: 0.98, payAmount: 980 });
  });

  test('1500 → 9.8 折，实付 1470', () => {
    expect(matchTier(1500)).toEqual({ discount: 0.98, payAmount: 1470 });
  });

  test('4999 → 9.8 折，实付 4899.02', () => {
    expect(matchTier(4999)).toEqual({ discount: 0.98, payAmount: 4899.02 });
  });

  test('5000 → 9.5 折，实付 4750', () => {
    expect(matchTier(5000)).toEqual({ discount: 0.95, payAmount: 4750 });
  });

  test('10000 → 9.5 折，实付 9500', () => {
    expect(matchTier(10000)).toEqual({ discount: 0.95, payAmount: 9500 });
  });

  test('50000 → 9.5 折，实付 47500', () => {
    expect(matchTier(50000)).toEqual({ discount: 0.95, payAmount: 47500 });
  });

  test('实付始终 ≤ 面值（"送钱"语义）', () => {
    [500, 999, 1000, 4999, 5000, 100000].forEach((face) => {
      const { payAmount } = matchTier(face);
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
