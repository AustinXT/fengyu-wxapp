/**
 * points-settle 单元测试 — admin 端 settlePointsForOrder
 *
 * 测试范式说明：因 vitest setup 全局 mock 了 drizzle-orm 的 sql tagged template
 * 为 `vi.fn(() => ({}))`，无法通过解析 SQL 文本来分发 mock 结果。
 * 改用 `mockResolvedValueOnce` 链式按调用顺序返回，并通过 `SQL_TEMPLATES`
 * 常量导出 + snapshot 测试守护 SQL 字符串一致性（Phase 2 跨三端比对）。
 */
import { describe, test, expect, vi, afterEach } from 'vitest'

// 必须先 mock 才能 import 被测模块
vi.mock('@/db', () => ({ db: {} }))
vi.mock('drizzle-orm', () => ({
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(), join: vi.fn() }),
}))

import {
  settlePointsForOrder,
  settlePointsSafe,
  ORDER_TYPES_EARN_POINTS,
} from './points-settle'

interface MockTx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: ReturnType<typeof vi.fn>
}

/**
 * 构造 mock tx：按调用顺序返回不同结果
 *
 * 调用顺序：① 取原单 → ② 链净额 → ③ 已发积分 → ④ INSERT point_transactions → ⑤ UPDATE balance
 * 若 settle 在 ①/②/③ 提前 return，后续 mock 不会被消费
 */
function buildMockTx({
  saleOrderType = '销售单',
  clientUserId = 'user-001' as string | null,
  netSettled = 0,
  granted = 0,
  orderNotFound = false,
}: {
  saleOrderType?: string
  clientUserId?: string | null
  netSettled?: number
  granted?: number
  orderNotFound?: boolean
} = {}): MockTx {
  const execute = vi.fn()
  if (orderNotFound) {
    execute.mockResolvedValueOnce([])
  } else {
    execute.mockResolvedValueOnce([
      { client_user_id: clientUserId, sale_order_type: saleOrderType },
    ])
  }
  execute.mockResolvedValueOnce([{ net_settled: netSettled }])
  execute.mockResolvedValueOnce([{ granted }])
  execute.mockResolvedValue({ rowCount: 1 })
  return { execute }
}

describe('ORDER_TYPES_EARN_POINTS', () => {
  test('仅包含 销售单', () => {
    expect(ORDER_TYPES_EARN_POINTS.has('销售单')).toBe(true)
    expect(ORDER_TYPES_EARN_POINTS.has('内部单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('回款单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('退款单')).toBe(false)
    expect(ORDER_TYPES_EARN_POINTS.has('转换单')).toBe(false)
  })
})

describe('settlePointsForOrder — 正向发放', () => {
  test('首次消费 280 元 → delta=+2', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { execute } = buildMockTx({ netSettled: 280, granted: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'FY-XSD-WX-2604240001')
    expect(r).toEqual({ delta: 2, expected: 2, granted: 0 })
    // 3 次 SELECT + 1 次 INSERT + 1 次 UPDATE = 5 次
    expect(execute).toHaveBeenCalledTimes(5)
  })

  test('消费 100 元整 → delta=+1', async () => {
    const { execute } = buildMockTx({ netSettled: 100, granted: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: 1, expected: 1, granted: 0 })
  })

  test('消费 99 元 → delta=0 无写入（floor 截断）', async () => {
    const { execute } = buildMockTx({ netSettled: 99, granted: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: 0, expected: 0, granted: 0 })
    // 仅 3 次 SELECT，无 INSERT/UPDATE
    expect(execute).toHaveBeenCalledTimes(3)
  })
})

describe('settlePointsForOrder — 退款冲销', () => {
  test('退款后冲销：netSettled=190, granted=2 → delta=-1', async () => {
    const { execute } = buildMockTx({ netSettled: 190, granted: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: -1, expected: 1, granted: 2 })
    expect(execute).toHaveBeenCalledTimes(5)
  })

  test('二次退款尾差归零：netSettled=140, granted=1 → delta=0 无写入', async () => {
    const { execute } = buildMockTx({ netSettled: 140, granted: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: 0, expected: 1, granted: 1 })
    expect(execute).toHaveBeenCalledTimes(3)
  })

  test('全额退款：netSettled=0, granted=2 → delta=-2', async () => {
    const { execute } = buildMockTx({ netSettled: 0, granted: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: -2, expected: 0, granted: 2 })
  })
})

describe('settlePointsForOrder — 边界保护', () => {
  test('负净额保护：netSettled=-50, granted=2 → expected=0, delta=-2', async () => {
    const { execute } = buildMockTx({ netSettled: -50, granted: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: -2, expected: 0, granted: 2 })
  })

  test('纯卡抵扣：netSettled=0, granted=0 → delta=0', async () => {
    const { execute } = buildMockTx({ netSettled: 0, granted: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r).toEqual({ delta: 0, expected: 0, granted: 0 })
    expect(execute).toHaveBeenCalledTimes(3)
  })
})

describe('settlePointsForOrder — 跳过分支', () => {
  test('originalSaleOrderId = "" → skipped=no-original-id 不查 pg', async () => {
    const { execute } = buildMockTx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, '')
    expect(r.skipped).toBe('no-original-id')
    expect(execute).toHaveBeenCalledTimes(0)
  })

  test('原单不存在 → skipped=order-not-found（仅 1 次 SELECT）', async () => {
    const { execute } = buildMockTx({ orderNotFound: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'missing-id')
    expect(r.skipped).toBe('order-not-found')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('匿名单 client_user_id = null → skipped=anonymous-order', async () => {
    const { execute } = buildMockTx({ clientUserId: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r.skipped).toBe('anonymous-order')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('内部单 → skipped=order-type-内部单', async () => {
    const { execute } = buildMockTx({ saleOrderType: '内部单' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r.skipped).toBe('order-type-内部单')
  })

  test('退款单 → skipped=order-type-退款单（派生单不是原始发放点）', async () => {
    const { execute } = buildMockTx({ saleOrderType: '退款单' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsForOrder({ execute } as any, 'o1')
    expect(r.skipped).toBe('order-type-退款单')
  })
})

describe('settlePointsSafe — 外层封装', () => {
  const OLD_ENV = process.env.POINTS_ACCRUAL_ENABLED

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.POINTS_ACCRUAL_ENABLED
    } else {
      process.env.POINTS_ACCRUAL_ENABLED = OLD_ENV
    }
  })

  test('feature flag = "false" → skipped=feature-flag-disabled，不查 pg', async () => {
    process.env.POINTS_ACCRUAL_ENABLED = 'false'
    const { execute } = buildMockTx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsSafe({ execute } as any, 'o1', 'admin.confirmOffline')
    expect(r.skipped).toBe('feature-flag-disabled')
    expect(execute).toHaveBeenCalledTimes(0)
  })

  test('feature flag 未设置 → 正常执行', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const { execute } = buildMockTx({ netSettled: 280, granted: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsSafe({ execute } as any, 'o1', 'admin.confirmOffline')
    expect(r.delta).toBe(2)
  })

  test('内部 settle 抛异常 → 捕获并尝试写 operation_logs', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('pg connection lost')) // 第一次 SELECT 抛错
      .mockResolvedValueOnce({ rowCount: 1 })                  // INSERT operation_logs 成功
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsSafe({ execute } as any, 'o1', 'admin.recordPayment')
    expect(r.skipped).toBe('settle-failed')
    expect(r.error).toBe('pg connection lost')
    // 2 次：原 SELECT 抛错 + INSERT operation_logs
    expect(execute).toHaveBeenCalledTimes(2)
  })

  test('operation_logs 写入也失败时不抛出，仍返回 skipped=settle-failed', async () => {
    delete process.env.POINTS_ACCRUAL_ENABLED
    const execute = vi.fn(async () => {
      throw new Error('catastrophic failure')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await settlePointsSafe({ execute } as any, 'o1', 'admin.confirmOffline')
    expect(r.skipped).toBe('settle-failed')
    expect(r.error).toBe('catastrophic failure')
  })
})
