import { evaluateCouponAfterCartChange } from '../../utils/coupon-evaluator'

describe('evaluateCouponAfterCartChange', () => {
  test('原券已不在可用列表 → cleared', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-2', discount: 30 },
    ])
    expect(result).toEqual({ kind: 'cleared' })
  })

  test('空列表 → cleared', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [])
    expect(result).toEqual({ kind: 'cleared' })
  })

  test('null 列表 → cleared', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, null)
    expect(result).toEqual({ kind: 'cleared' })
  })

  test('原券仍在列表且 discount 相同 → noop', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-1', discount: 50 },
      { couponId: 'cp-2', discount: 30 },
    ])
    expect(result).toEqual({ kind: 'noop' })
  })

  test('原券仍在列表但 discount 变大（品项券 cart 扩容）→ updated', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-1', discount: 80 },
    ])
    expect(result).toEqual({ kind: 'updated', discount: 80 })
  })

  test('原券仍在列表但 discount 变小（品项券 cart 缩减）→ updated', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-1', discount: 20 },
    ])
    expect(result).toEqual({ kind: 'updated', discount: 20 })
  })

  test('后端 discount 以 string 返回 → Number 归一化后判定', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-1', discount: '50' },
    ])
    expect(result).toEqual({ kind: 'noop' })
  })

  test('后端 discount 为非法值 → 转 0 走 updated 分支', () => {
    const result = evaluateCouponAfterCartChange('cp-1', 50, [
      { couponId: 'cp-1', discount: 'abc' as unknown as number },
    ])
    expect(result).toEqual({ kind: 'updated', discount: 0 })
  })
})
