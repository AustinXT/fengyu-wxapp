import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/order', () => ({
  saleOrders: {
    saleOrderId: 'sale_order_id',
    storeId: 'store_id',
    legacySource: 'legacy_source',
    status: 'status',
    clientPhone: 'client_phone',
    customerName: 'customer_name',
    clientUserId: 'client_user_id',
    saleOrderDatetime: 'sale_order_datetime',
    totalAmount: 'total_amount',
    legacyCustomerId: 'legacy_customer_id',
    legacyRawSnapshot: 'legacy_raw_snapshot',
    marketName: 'market_name',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    openid: 'openid',
    phone: 'phone',
    customerId: 'customer_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  isNull: vi.fn((col) => ({ type: 'isNull', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({
      type: 'sql',
      raw: strings.join('?'),
    })),
    { raw: vi.fn() },
  ),
}))

vi.mock('@/lib/workfine-mssql', () => ({
  searchCustomersByPhone: vi.fn(),
  searchCustomerByCustomerId: vi.fn(),
  queryOrdersByCustomerId: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('@/lib/recompute-customer-tags', () => ({
  recomputeCustomerTagsInTx: vi.fn(),
  recomputeMemberLevelOnly: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  listLegacyOrders,
  updateLegacyOrderAmount,
  searchWorkfineCustomer,
  previewWorkfineOrders,
  importWorkfineOrdersByCustomer,
} from './legacy-orders'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { and, isNotNull, isNull } from 'drizzle-orm'
import {
  searchCustomersByPhone,
  searchCustomerByCustomerId,
  queryOrdersByCustomerId,
} from '@/lib/workfine-mssql'

const mockSession = {
  employeeId: 'EMP-001',
  roles: ['manager'],
  permissions: { actions: ['legacy_order:list', 'legacy_order:update_amount'], scopeStoreIds: [] },
} as any

// ──────────────────────────────────────────────────────────────────────────────
// updateLegacyOrderAmount
// ──────────────────────────────────────────────────────────────────────────────

describe('updateLegacyOrderAmount — 参数校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('金额 = 0 → INVALID_PARAMS', async () => {
    await expect(updateLegacyOrderAmount('FY-1', 0, '2026-05-19T00:00:00.000Z')).rejects.toThrow(
      /INVALID_PARAMS/,
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('金额 < 0 → INVALID_PARAMS', async () => {
    await expect(updateLegacyOrderAmount('FY-1', -1, '2026-05-19T00:00:00.000Z')).rejects.toThrow(
      /INVALID_PARAMS/,
    )
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('金额 NaN → INVALID_PARAMS', async () => {
    await expect(
      updateLegacyOrderAmount('FY-1', Number.NaN, '2026-05-19T00:00:00.000Z'),
    ).rejects.toThrow(/INVALID_PARAMS/)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('金额 > 9999999.99 → INVALID_PARAMS', async () => {
    await expect(
      updateLegacyOrderAmount('FY-1', 1e8, '2026-05-19T00:00:00.000Z'),
    ).rejects.toThrow(/INVALID_PARAMS/)
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('updateLegacyOrderAmount — 事务流程', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('SELECT 旧值返回空（CAS 命中失败）→ CONFLICT，不发起 UPDATE', async () => {
    let updateCalled = false
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce([]) // old row not found
          .mockImplementationOnce(async () => {
            updateCalled = true
            return { rowCount: 1 }
          }),
      }
      return await fn(tx)
    })

    await expect(
      updateLegacyOrderAmount('FY-1', 200, '2026-05-19T00:00:00.000Z'),
    ).rejects.toThrow(/CONFLICT/)
    expect(updateCalled).toBe(false)
  })

  it('UPDATE rowCount=0（并发改写）→ CONFLICT', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce([{ total_amount: '100.00' }])
          .mockResolvedValueOnce({ rowCount: 0 }),
      }
      return await fn(tx)
    })

    await expect(
      updateLegacyOrderAmount('FY-1', 200, '2026-05-19T00:00:00.000Z'),
    ).rejects.toThrow(/CONFLICT/)
  })

  it('正常路径 → 写 audit log（精确 from→to），返回 prev/new', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce([{ total_amount: '100.00' }])
          .mockResolvedValueOnce({ rowCount: 1 }),
      }
      return await fn(tx)
    })

    const res = await updateLegacyOrderAmount('FY-1', 200, '2026-05-19T00:00:00.000Z')
    expect(res).toEqual({ success: true, from: '100.00', to: '200.00' })
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'legacy_order.update_amount',
      'sale_order',
      'FY-1',
      expect.objectContaining({
        _t: 'update',
        changes: { totalAmount: { from: '100.00', to: '200.00' } },
      }),
    )
  })

  it('二次修改 → log.from 仍是事务读到的上一次值（不是 original_amount）', async () => {
    // 第一次修改后 total_amount=200，再改成 300。SELECT 读到 200，log 应为 200→300。
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce([{ total_amount: '200.00' }])
          .mockResolvedValueOnce({ rowCount: 1 }),
      }
      return await fn(tx)
    })

    const res = await updateLegacyOrderAmount('FY-1', 300, '2026-05-19T01:00:00.000Z')
    expect(res.from).toBe('200.00')
    expect(res.to).toBe('300.00')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'legacy_order.update_amount',
      'sale_order',
      'FY-1',
      expect.objectContaining({
        changes: { totalAmount: { from: '200.00', to: '300.00' } },
      }),
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// listLegacyOrders — 小程序匹配语义
// ──────────────────────────────────────────────────────────────────────────────

function mockListQueries(rows: Array<{
  saleOrderId: string
  clientUserId: string | null
  clientOpenid: string | null
}>) {
  const orderRow = (r: any) => ({
    order: {
      saleOrderId: r.saleOrderId,
      storeId: 'STORE-1',
      legacySource: 'workfine',
      status: '未审核',
      clientPhone: '13900000000',
      customerName: 'Alice',
      clientUserId: r.clientUserId,
      saleOrderDatetime: new Date('2026-05-01T10:00:00.000Z'),
      totalAmount: '100.00',
      legacyCustomerId: 'LC-1',
      legacyRawSnapshot: { amount: 100 },
      marketName: '市场A',
      updatedAt: new Date('2026-05-01T10:00:00.000Z'),
    },
    storeName: '门店A',
    clientName: r.clientUserId ? 'Alice' : null,
    clientOpenid: r.clientOpenid,
  })

  // 第一次 db.select(...) → count 查询；第二次 → rows 查询
  ;(db.select as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: rows.length }]),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(rows.map(orderRow)),
                }),
              }),
            }),
          }),
        }),
      }),
    })
}

describe('listLegacyOrders — hasMiniprogramAccount 派生', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['legacy_order:list'], scopeStoreIds: [] },
    })
  })

  it('clientOpenid 非空 → hasMiniprogramAccount=true', async () => {
    mockListQueries([{ saleOrderId: 'FY-1', clientUserId: 'U-1', clientOpenid: 'oABC...' }])
    const res = await listLegacyOrders({})
    expect(res.data).toHaveLength(1)
    expect(res.data[0].hasMiniprogramAccount).toBe(true)
    expect(res.data[0].clientUserId).toBe('U-1')
  })

  it('clientUserId 非空但 openid 为 null（WorkFine 幽灵顾客）→ hasMiniprogramAccount=false', async () => {
    mockListQueries([{ saleOrderId: 'FY-2', clientUserId: 'U-2', clientOpenid: null }])
    const res = await listLegacyOrders({})
    expect(res.data[0].hasMiniprogramAccount).toBe(false)
    expect(res.data[0].clientUserId).toBe('U-2')
  })

  it('clientUserId 为 null → hasMiniprogramAccount=false', async () => {
    mockListQueries([{ saleOrderId: 'FY-3', clientUserId: null, clientOpenid: null }])
    const res = await listLegacyOrders({})
    expect(res.data[0].hasMiniprogramAccount).toBe(false)
    expect(res.data[0].clientUserId).toBeNull()
  })
})

describe('listLegacyOrders — matched/unmatched 筛选器走 openid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['legacy_order:list'], scopeStoreIds: [] },
    })
  })

  it('matched=matched → and(...) 包含 isNotNull(openid)', async () => {
    mockListQueries([])
    await listLegacyOrders({ matched: 'matched' })

    // isNotNull 应被调用，且参数指向 openid 字段
    expect(isNotNull).toHaveBeenCalled()
    const calls = (isNotNull as any).mock.calls.map((c: any[]) => c[0])
    expect(calls).toContainEqual('openid')
    // 不应该再用 isNotNull 套 client_user_id
    expect(calls).not.toContainEqual('client_user_id')
  })

  it('matched=unmatched → and(...) 包含 isNull(openid)', async () => {
    mockListQueries([])
    await listLegacyOrders({ matched: 'unmatched' })

    expect(isNull).toHaveBeenCalled()
    const calls = (isNull as any).mock.calls.map((c: any[]) => c[0])
    expect(calls).toContainEqual('openid')
    expect(calls).not.toContainEqual('client_user_id')
  })

  it('未指定 matched → 既不调 isNotNull 也不调 isNull（针对 openid/client_user_id）', async () => {
    mockListQueries([])
    await listLegacyOrders({})

    const isNotNullCalls = (isNotNull as any).mock.calls.map((c: any[]) => c[0])
    const isNullCalls = (isNull as any).mock.calls.map((c: any[]) => c[0])
    expect(isNotNullCalls).not.toContainEqual('openid')
    expect(isNullCalls).not.toContainEqual('openid')
    // and(...) 仍被调用以拼接其他条件
    expect(and).toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Manual pull workflow: searchWorkfineCustomer / previewWorkfineOrders / import
// ──────────────────────────────────────────────────────────────────────────────

const pullSession = {
  employeeId: 'EMP-001',
  roles: ['manager'],
  permissions: { actions: ['legacy_order:pull'], scopeStoreIds: [] },
} as any

describe('searchWorkfineCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(db.select as any).mockReset()
    ;(db.transaction as any).mockReset()
    ;(getSession as any).mockResolvedValue(pullSession)
  })

  it('无 phone / customerId → INVALID_PARAMS', async () => {
    await expect(searchWorkfineCustomer({})).rejects.toThrow(/INVALID_PARAMS/)
    expect(searchCustomersByPhone).not.toHaveBeenCalled()
    expect(searchCustomerByCustomerId).not.toHaveBeenCalled()
  })

  it('phone 路：调 searchCustomersByPhone，PG 命中标记 existsInPg=true', async () => {
    ;(searchCustomersByPhone as any).mockResolvedValue([
      { customerId: 'WF-1', name: '张三', phone: '13800138000' },
    ])
    // db.select chain for phone lookup, then customer_id lookup
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'PG-USR-1', phone: '13800138000' }]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })

    const res = await searchWorkfineCustomer({ phone: '13800138000' })
    expect(searchCustomersByPhone).toHaveBeenCalledWith('13800138000')
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ existsInPg: true, pgUserId: 'PG-USR-1' })
  })

  it('customerId 路：调 searchCustomerByCustomerId；空结果返回空数组', async () => {
    ;(searchCustomerByCustomerId as any).mockResolvedValue(null)
    const res = await searchWorkfineCustomer({ customerId: 'WF-NOPE' })
    expect(searchCustomerByCustomerId).toHaveBeenCalledWith('WF-NOPE')
    expect(res).toEqual([])
    // 无候选时不查 PG
    expect(db.select).not.toHaveBeenCalled()
  })

  it('PG 未命中 → existsInPg=false / pgUserId=null', async () => {
    ;(searchCustomerByCustomerId as any).mockResolvedValue({
      customerId: 'WF-X',
      name: '李四',
      phone: null,
    })
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })

    const res = await searchWorkfineCustomer({ customerId: 'WF-X' })
    expect(res[0].existsInPg).toBe(false)
    expect(res[0].pgUserId).toBeNull()
  })
})

describe('previewWorkfineOrders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(db.select as any).mockReset()
    ;(db.transaction as any).mockReset()
    ;(getSession as any).mockResolvedValue(pullSession)
  })

  it('空 customerId → INVALID_PARAMS', async () => {
    await expect(previewWorkfineOrders({ workfineCustomerId: '' })).rejects.toThrow(/INVALID_PARAMS/)
  })

  it('WorkFine 无订单 → orders=[]', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([])
    const res = await previewWorkfineOrders({ workfineCustomerId: 'WF-1' })
    expect(res.orders).toEqual([])
  })

  it('正常路径 → 标记 alreadyImported + storeMatched', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([
      {
        legacyOrderNo: 'O-1',
        saleDate: '2023-01-01',
        marketName: '市场',
        storeName: '门店A',
        customerName: '张三',
        amount: 100,
        legacyCustomerId: 'WF-1',
        phone: '13800138000',
      },
      {
        legacyOrderNo: 'O-2',
        saleDate: '2023-02-01',
        marketName: '市场',
        storeName: '门店未匹配',
        customerName: '张三',
        amount: 200,
        legacyCustomerId: 'WF-1',
        phone: '13800138000',
      },
    ])
    // first select: existing sale_orders by saleOrderId
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ saleOrderId: 'O-1' }]),
        }),
      })
      // second select: stores by storeName
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ storeName: '门店A' }]),
        }),
      })

    const res = await previewWorkfineOrders({ workfineCustomerId: 'WF-1' })
    expect(res.orders).toHaveLength(2)
    expect(res.orders[0]).toMatchObject({ legacyOrderNo: 'O-1', alreadyImported: true, storeMatched: true })
    expect(res.orders[1]).toMatchObject({ legacyOrderNo: 'O-2', alreadyImported: false, storeMatched: false })
  })
})

describe('importWorkfineOrdersByCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(db.select as any).mockReset()
    ;(db.transaction as any).mockReset()
    ;(getSession as any).mockResolvedValue(pullSession)
  })

  it('空 selectedOrderNos → INVALID_PARAMS', async () => {
    await expect(
      importWorkfineOrdersByCustomer({ workfineCustomerId: 'WF-1', selectedOrderNos: [] }),
    ).rejects.toThrow(/INVALID_PARAMS/)
  })

  it('> 500 条 → INVALID_PARAMS', async () => {
    const arr = Array.from({ length: 501 }, (_, i) => `O-${i}`)
    await expect(
      importWorkfineOrdersByCustomer({ workfineCustomerId: 'WF-1', selectedOrderNos: arr }),
    ).rejects.toThrow(/INVALID_PARAMS/)
  })

  it('选中订单 WorkFine 已不存在 → 0 行导入', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([])
    const res = await importWorkfineOrdersByCustomer({
      workfineCustomerId: 'WF-1',
      selectedOrderNos: ['O-NOPE'],
    })
    expect(res).toMatchObject({ insertedCount: 0, skippedAlreadyExist: 0, skippedNoStore: 0 })
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('门店未匹配 → 该行 skippedNoStore++，不 INSERT', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([
      {
        legacyOrderNo: 'O-A',
        saleDate: '2023-01-01',
        marketName: '市场',
        storeName: '幽灵门店',
        customerName: '张三',
        amount: 100,
        legacyCustomerId: 'WF-1',
        phone: '13800138000',
      },
    ])
    // lookup queries: phone, customerId, stores
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })

    let txExecuteCalls = 0
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation(async () => {
          txExecuteCalls++
          return { rowCount: 1 }
        }),
      }
      return await fn(tx)
    })

    const res = await importWorkfineOrdersByCustomer({
      workfineCustomerId: 'WF-1',
      selectedOrderNos: ['O-A'],
    })
    expect(res).toMatchObject({ insertedCount: 0, skippedNoStore: 1 })
    // 只有 logOperation 的 execute，没有 INSERT execute（logOperation 自己是 mock 不走 tx.execute）
    expect(txExecuteCalls).toBe(0)
  })

  it('正常路径：INSERT 成功 → insertedCount=1，affectedPhone 返回', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([
      {
        legacyOrderNo: 'O-OK',
        saleDate: '2023-01-01',
        marketName: '市场',
        storeName: '门店A',
        customerName: '张三',
        amount: 998,
        legacyCustomerId: 'WF-1',
        phone: '13800138000',
      },
    ])
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'PG-USR-1', phone: '13800138000' }]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ storeId: 'STORE-1', storeName: '门店A' }]),
        }),
      })

    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }
      return await fn(tx)
    })

    const res = await importWorkfineOrdersByCustomer({
      workfineCustomerId: 'WF-1',
      selectedOrderNos: ['O-OK'],
    })
    expect(res).toMatchObject({
      insertedCount: 1,
      skippedAlreadyExist: 0,
      skippedNoStore: 0,
      affectedPhone: '13800138000',
    })
    expect(logOperation).toHaveBeenCalledWith(
      pullSession,
      'legacy_order.pull',
      'client_user',
      'PG-USR-1',
      expect.objectContaining({ inserted: 1, skippedNoStore: 0, affectedPhone: '13800138000' }),
    )
  })

  it('ON CONFLICT 命中 (rowCount=0) → skippedAlreadyExist++', async () => {
    ;(queryOrdersByCustomerId as any).mockResolvedValue([
      {
        legacyOrderNo: 'O-DUP',
        saleDate: '2023-01-01',
        marketName: '市场',
        storeName: '门店A',
        customerName: '张三',
        amount: 100,
        legacyCustomerId: 'WF-1',
        phone: null,
      },
    ])
    // phone is null → phone query skipped；只剩 customerId 和 stores 两次 select
    ;(db.select as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ storeId: 'STORE-1', storeName: '门店A' }]),
        }),
      })

    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({ rowCount: 0 }), // ON CONFLICT DO NOTHING
      }
      return await fn(tx)
    })

    const res = await importWorkfineOrdersByCustomer({
      workfineCustomerId: 'WF-1',
      selectedOrderNos: ['O-DUP'],
    })
    expect(res).toMatchObject({ insertedCount: 0, skippedAlreadyExist: 1, skippedNoStore: 0 })
  })
})
