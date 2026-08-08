import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
  },
}))

vi.mock('@db/prepaid-card', () => ({
  cardTransactions: {
    id: 'id',
    cardId: 'card_id',
    type: 'type',
    amount: 'amount',
    refOrderId: 'ref_order_id',
    createdAt: 'created_at',
  },
  prepaidCards: {
    cardId: 'card_id',
    userId: 'user_id',
    storeId: 'store_id',
    balance: 'balance',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
    memberLevel: 'member_level',
    boundStoreId: 'bound_store_id',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', parentId: 'parent_id', name: 'name', type: 'type' },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  sql: Object.assign(vi.fn((strings: any, ...vals: any[]) => ({ type: 'sql', strings, vals })), { raw: vi.fn(() => ({ type: 'sql_raw' })) }),
}))

import { getCardTransactionsPaginated } from './card-transactions'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { scopeCondition } from '@/lib/permissions'
import { eq, ilike, gte, lte, sql } from 'drizzle-orm'

const adminSession = {
  employeeId: 'ADMIN-001',
  name: 'admin',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
  permissions: { actions: ['card_transaction:list'], scopeStoreIds: [] },
}

const managerSession = {
  employeeId: 'MGR-001',
  name: 'manager',
  phone: '13800000001',
  roles: [{ role: 'manager', scopeId: 'store-node-1', scopeType: '门店' }],
  permissions: { actions: ['card_transaction:list'], scopeStoreIds: ['store-1'] },
}

const mockRow = {
  id: 1,
  cardId: 'FY-CARD-WX-0001',
  userId: 'U-001',
  type: '充值' as const,
  amount: '1000.00',
  balance: '2000.00',
  refOrderId: 'FY-XSD-WX-260415-0001',
  createdAt: new Date('2026-04-15T08:00:00Z'),
  customerName: '张三',
  customerPhone: '13812345678',
  memberLevel: '金钻',
  storeId: 'store-1',
  storeName: '南昌旗舰店',
  marketName: '南昌市场',
}

/**
 * 三查并发的 mock 链：
 *   call#1 = COUNT (terminal = where)
 *   call#2 = DATA  (terminal = offset)
 *   call#3 = SUMMARY (terminal = where)
 */
function mockThreeQueries(opts: {
  count: number
  rows: any[]
  summary: { totalRecharge: string; totalDeduct: string; netChange: string; txnCount: number; userCount: number }
}) {
  let i = 0
  ;(db.select as any).mockImplementation(() => {
    i++
    if (i === 1) {
      // COUNT：select().from().innerJoin().innerJoin().where()
      const where = vi.fn().mockResolvedValue([{ count: opts.count }])
      const innerJoin2 = vi.fn().mockReturnValue({ where })
      const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 })
      const from = vi.fn().mockReturnValue({ innerJoin: innerJoin1 })
      return { from }
    }
    if (i === 2) {
      // DATA: select().from().innerJoin().innerJoin().where().orderBy().limit().offset()
      const offset = vi.fn().mockResolvedValue(opts.rows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const innerJoin2 = vi.fn().mockReturnValue({ where })
      const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 })
      const from = vi.fn().mockReturnValue({ innerJoin: innerJoin1 })
      return { from }
    }
    // SUMMARY
    const where = vi.fn().mockResolvedValue([opts.summary])
    const innerJoin2 = vi.fn().mockReturnValue({ where })
    const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 })
    const from = vi.fn().mockReturnValue({ innerJoin: innerJoin1 })
    return { from }
  })
}

describe('getCardTransactionsPaginated — 服务端分页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(scopeCondition as any).mockReturnValue(undefined)
  })

  it('空筛选 → 返回 data + total + summary（金额 Number 化）', async () => {
    mockThreeQueries({
      count: 1,
      rows: [mockRow],
      summary: {
        totalRecharge: '1000.00',
        totalDeduct: '0',
        netChange: '1000.00',
        txnCount: 1,
        userCount: 1,
      },
    })

    const result = await getCardTransactionsPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe(1)
    expect(result.data[0].cardId).toBe('FY-CARD-WX-0001')
    expect(result.data[0].type).toBe('充值')
    expect(result.data[0].amount).toBe(1000)
    expect(result.data[0].balance).toBe(2000)
    expect(result.data[0].customerName).toBe('张三')
    expect(result.data[0].createdAt).toBe('2026-04-15T08:00:00.000Z')
    expect(result.summary.totalRecharge).toBe(1000)
    expect(result.summary.totalDeduct).toBe(0)
    expect(result.summary.netChange).toBe(1000)
    expect(result.summary.txnCount).toBe(1)
    expect(result.summary.userCount).toBe(1)
  })

  it('type=充值 → eq 被调用', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ type: '充值' })

    expect(eq).toHaveBeenCalledWith('type', '充值')
  })

  it('type=扣款 → eq 被调用', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ type: '扣款' })

    expect(eq).toHaveBeenCalledWith('type', '扣款')
  })

  it('非法 type（如 `退款`）→ 不触发 type 上的 eq', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ type: '退款' as any })

    // type 非法，不能出现 eq('type', '退款')
    const typeEqCalls = (eq as any).mock.calls.filter((c: any[]) => c[0] === 'type' && c[1] === '退款')
    expect(typeEqCalls).toHaveLength(0)
  })

  it('storeId 筛选 → eq(bound_store_id, ...) 被调用（跨店共享后按顾客绑定门店近似）', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ storeId: 'store-2' })

    // prepaid_cards.store_id 已 DROP，filter 退回到 client_wechat_users.bound_store_id
    expect(eq).toHaveBeenCalledWith('bound_store_id', 'store-2')
  })

  it('marketId 筛选 → 生成参数化组织节点子树条件', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ marketId: 'market-1' })

    expect((sql as any).mock.calls.some((args: unknown[]) => args.includes('market-1'))).toBe(true)
  })

  it('search 筛选 → ilike(name) + ilike(phone) + 转义 %/_', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ search: '李_100%' })

    // 验证转义后的 pattern
    expect(ilike).toHaveBeenCalledWith('name', '%李\\_100\\%%')
    expect(ilike).toHaveBeenCalledWith('phone', '%李\\_100\\%%')
  })

  it('日期区间 → gte(startDate 00:00:00) + lte(endDate 23:59:59) 北京字面', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ startDate: '2026-04-01', endDate: '2026-04-15' })

    const gteCall = (gte as any).mock.calls.find((c: any[]) => c[0] === 'created_at')
    const lteCall = (lte as any).mock.calls.find((c: any[]) => c[0] === 'created_at')
    expect(gteCall).toBeTruthy()
    expect(lteCall).toBeTruthy()
    // 日期串拼北京字面 00:00:00 / 23:59:59 ::timestamp（不经 new Date——date-only UTC 午夜解析会 +8h）
    expect((gteCall[1] as any).vals[0]).toBe('2026-04-01 00:00:00')
    expect((lteCall[1] as any).vals[0]).toBe('2026-04-15 23:59:59')
  })

  it('非 admin scope 条件生效 → scopeCondition 返回的 SQL 被加入 where', async () => {
    ;(getSession as any).mockResolvedValue(managerSession)
    ;(scopeCondition as any).mockReturnValue({ type: 'inArray', col: 'store_id', vals: ['store-1'] })

    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated()

    expect(scopeCondition).toHaveBeenCalled()
  })

  it('admin scope → scopeCondition 返回 undefined，不过滤', async () => {
    ;(getSession as any).mockResolvedValue(adminSession)
    ;(scopeCondition as any).mockReturnValue(undefined)

    mockThreeQueries({
      count: 3,
      rows: [],
      summary: { totalRecharge: '3000', totalDeduct: '500', netChange: '2500', txnCount: 3, userCount: 2 },
    })

    const result = await getCardTransactionsPaginated()

    expect(result.total).toBe(3)
    expect(result.summary.totalRecharge).toBe(3000)
    expect(result.summary.totalDeduct).toBe(500)
    expect(result.summary.netChange).toBe(2500)
  })

  it('page=3, pageSize=10 → 仍触发 3 次 select', async () => {
    mockThreeQueries({
      count: 50,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    const result = await getCardTransactionsPaginated({ page: 3, pageSize: 10 })

    expect(result.total).toBe(50)
    expect(db.select).toHaveBeenCalledTimes(3)
  })

  it('非法 pageSize → 回退默认 20', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    const result = await getCardTransactionsPaginated({ pageSize: 999 })

    // 仅确认不抛异常，结果结构正常
    expect(result.total).toBe(0)
  })

  it('summary 基于 amount 符号（负数扣款返回为正值）', async () => {
    const deductRow = {
      ...mockRow,
      id: 2,
      type: '扣款' as const,
      amount: '-500.00',
      balance: '1500.00',
    }
    mockThreeQueries({
      count: 2,
      rows: [mockRow, deductRow],
      summary: {
        totalRecharge: '1000.00',
        totalDeduct: '500.00',   // CASE WHEN amount<0 THEN -amount，已转正
        netChange: '500.00',
        txnCount: 2,
        userCount: 1,
      },
    })

    const result = await getCardTransactionsPaginated()

    expect(result.data[1].amount).toBe(-500)
    expect(result.data[1].type).toBe('扣款')
    expect(result.summary.totalRecharge).toBe(1000)
    expect(result.summary.totalDeduct).toBe(500)
    expect(result.summary.netChange).toBe(500)
  })

  // ── type='扣款' 筛选（ticket §3.4 A4）────────────────────────────
  it('type=扣款 筛选 → 返回的数据映射为 AdminCardTransaction，type 正确', async () => {
    const deductRow = {
      ...mockRow,
      id: 100,
      type: '扣款' as const,
      amount: '-300.00',
      balance: '200.00',
      refOrderId: 'FY-XSD-WX-260423-0001',
    }
    mockThreeQueries({
      count: 1,
      rows: [deductRow],
      summary: {
        totalRecharge: '0',
        totalDeduct: '300.00',
        netChange: '-300.00',
        txnCount: 1,
        userCount: 1,
      },
    })

    const result = await getCardTransactionsPaginated({ type: '扣款' })

    expect(eq).toHaveBeenCalledWith('type', '扣款')
    expect(result.total).toBe(1)
    expect(result.data[0].type).toBe('扣款')
    expect(result.data[0].amount).toBe(-300)
    expect(result.summary.totalDeduct).toBe(300)
  })

  it('type=扣款 + search 同时筛选 → 两个条件都传入 WHERE', async () => {
    mockThreeQueries({
      count: 0,
      rows: [],
      summary: { totalRecharge: '0', totalDeduct: '0', netChange: '0', txnCount: 0, userCount: 0 },
    })

    await getCardTransactionsPaginated({ type: '扣款', search: '张' })

    expect(eq).toHaveBeenCalledWith('type', '扣款')
    expect(ilike).toHaveBeenCalledWith('name', '%张%')
  })
})
