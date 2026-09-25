import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}))

vi.mock('@db/pickup', () => ({
  pickupRecords: {
    id: 'id',
    saleItemId: 'sale_item_id',
    pickupQuantity: 'pickup_quantity',
    storeId: 'store_id',
    clientUserId: 'client_user_id',
    confirmedBy: 'confirmed_by',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: {
    saleItemId: 'sale_item_id',
    pickedUpQuantity: 'picked_up_quantity',
    refundedQuantity: 'refunded_quantity',
    convertedQuantity: 'converted_quantity',
  },
}))

vi.mock('@db/org', () => ({ stores: { storeId: 'store_id', storeName: 'store_name' } }))

vi.mock('@db/user', () => ({
  clientWechatUsers: { userId: 'user_id', name: 'name', phone: 'phone' },
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
}))

vi.mock('@db/product', () => ({ productSkus: { skuId: 'sku_id', specName: 'spec_name' } }))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  // 捕获模板文本：原 mock 返回空对象，SQL 写错（比如顺手把 refunded_quantity 一起减掉）
  // 在单测里完全看不见 —— 而这正是 #154 缺陷 1 的形态。
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sqlText: strings.join('?'),
      values,
    })),
    { raw: vi.fn() },
  ),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { deletePickupRecord } from './pickup-records'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['pickup_record:delete'], scopeStoreIds: [] },
}

function mockSelect(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

function setupTx(deleteCount: number, captureExecute?: (sqlArg: any) => void) {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: deleteCount }) }),
      execute: vi.fn().mockImplementation(async (arg: any) => { captureExecute?.(arg); return undefined }),
    }
    return fn(tx)
  })
}

describe('deletePickupRecord — 删除 + 回退已提数量', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('记录不存在 → 拒绝', async () => {
    mockSelect([])
    const result = await deletePickupRecord(404)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('#341 审计快照留存冻结单价与出库金额（删除后唯一可追溯处）', async () => {
    mockSelect([{
      saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1',
      pickupUnitPrice: '88.50', pickupAmount: '177.00',
    }])
    setupTx(1, () => {})
    await deletePickupRecord(1)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'pickup_record.delete', 'pickup_record', '1',
      { snapshot: expect.objectContaining({ pickupUnitPrice: '88.50', pickupAmount: '177.00' }) },
    )
  })

  it('记录存在 → 删除 + 回退计数 + 审计', async () => {
    mockSelect([{ saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1' }])
    let executed = false
    setupTx(1, () => { executed = true })
    const result = await deletePickupRecord(1)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(executed).toBe(true) // 事务内回退 picked_up_quantity
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'pickup_record.delete', 'pickup_record', '1',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  // #154 缺陷 1 的回归锁：issue 给的 4 步时间线是
  //   quantity=10 → 提 3 盒（picked_up=3）→ 折抵 7 盒 → 删掉那条 3 盒的提货记录。
  // 拆列前三类数量共用 picked_up_quantity，这里的无条件减法作用在合计值上，
  // 删完 picked_up=7、pending=10−7=3，顾客能把已折进另一张转换单的 3 盒再提一次。
  // 拆列后本列只记物理提货，等量回退即天然正确——前提是这条 UPDATE **只碰这一列**。
  it('回退语句只减 picked_up_quantity，不触碰已退款/已转换（#154 缺陷 1）', async () => {
    mockSelect([{ saleItemId: 'SI-1', pickupQuantity: 3, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1' }])
    const executed: string[] = []
    setupTx(1, (arg) => { executed.push(arg?.__sqlText ?? '') })

    const result = await deletePickupRecord(1)

    expect(result.success).toBe(true)
    const update = executed.find((t) => t.includes('UPDATE sale_items'))
    expect(update, '未发出回退语句').toBeDefined()
    expect(update).toContain('picked_up_quantity = GREATEST(COALESCE(picked_up_quantity, 0) -')
    // 只要这条语句碰了另外两列，被退款/折抵占用的额度就会被释放回去
    expect(update, '删除提货记录不得改动已退款列').not.toContain('refunded_quantity =')
    expect(update, '删除提货记录不得改动已转换列').not.toContain('converted_quantity =')
    // GREATEST 防越界为负仍须在
    expect(update).toContain(', 0)')
  })

  it('删除 rowCount=0（并发）→ 回滚提示', async () => {
    mockSelect([{ saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'S1', clientUserId: 'U1', confirmedBy: 'E1' }])
    setupTx(0)
    const result = await deletePickupRecord(1)
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
