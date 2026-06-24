import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}))

vi.mock('@db/lakala', () => ({
  lakalaMerchants: {
    id: 'id',
    merchantName: 'merchant_name',
    merchantNo: 'merchant_no',
    termNo: 'term_no',
    enabled: 'enabled',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
    lakalaMerchantId: 'lakala_merchant_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  ne: vi.fn((a, b) => ({ type: 'ne', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn(() => ({})) })), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ requirePermission: vi.fn() }))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn(), logUpdate: vi.fn() }))
vi.mock('@/lib/pg-error', () => ({ pgErrorCode: vi.fn(() => null) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// crypto 不 mock：ksuid 用真实 randomBytes（纯函数无副作用），id 形如 lm_xxxx

import {
  getMerchantsPaginated,
  getMerchantById,
  createMerchant,
  updateMerchant,
  deleteMerchant,
} from './merchants'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'E1',
  name: 'Admin',
  roles: [{ role: 'admin', scopeId: null, scopeType: '总部' }],
  permissions: {
    actions: ['merchant:list', 'merchant:create', 'merchant:update', 'merchant:delete', 'store:lakala_config'],
    scopeStoreIds: [],
  },
}

/** 链式 select mock：任何 from/where/join/limit/offset 链最终 await 都解析为给定 rows */
function selectChain(rows: any[]) {
  const chain: any = {}
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'groupBy', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject)
  return chain
}

/** 按调用顺序 mock db.select */
function mockSelectSequence(...rowSets: any[][]) {
  for (const rows of rowSets) {
    ;(db.select as any).mockReturnValueOnce(selectChain(rows))
  }
}

function mockInsert() {
  const values = vi.fn().mockResolvedValue({})
  ;(db.insert as any).mockReturnValue({ values })
  return values
}

function mockUpdate(count: number) {
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
  return { set, where }
}

function mockDelete() {
  const where = vi.fn().mockResolvedValue({})
  ;(db.delete as any).mockReturnValue({ where })
  return where
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getSession as any).mockResolvedValue(mockSession)
})

describe('createMerchant', () => {
  it('商户名为空 → 拒绝', async () => {
    const r = await createMerchant({ merchantName: '  ', merchantNo: null, termNo: null, enabled: false })
    expect(r.success).toBe(false)
    expect(r.message).toContain('商户名称必填')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('启用但无商户号 → 拒绝', async () => {
    const r = await createMerchant({ merchantName: '凤仪韵', merchantNo: null, termNo: 'T1', enabled: true })
    expect(r.success).toBe(false)
    expect(r.message).toContain('商户号必填')
  })

  it('启用但无终端号 → 拒绝', async () => {
    const r = await createMerchant({ merchantName: '凤仪韵', merchantNo: '8222900', termNo: null, enabled: true })
    expect(r.success).toBe(false)
    expect(r.message).toContain('终端号')
  })

  it('商户号已被占用 → 拒绝', async () => {
    mockSelectSequence([{ id: 'lm_other' }]) // dup 校验命中
    const r = await createMerchant({ merchantName: '凤仪韵', merchantNo: '8222900', termNo: null, enabled: false })
    expect(r.success).toBe(false)
    expect(r.message).toContain('已被其他商户占用')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('合法输入 → 新建成功（insert 被调）', async () => {
    mockSelectSequence([]) // dup 校验未命中
    const values = mockInsert()
    const r = await createMerchant({ merchantName: '凤仪韵', merchantNo: '8222900', termNo: 'D9261078', enabled: true })
    expect(r.success).toBe(true)
    expect(r.id).toMatch(/^lm_/)
    expect(values).toHaveBeenCalled()
  })
})

describe('updateMerchant', () => {
  it('商户不存在 → 拒绝', async () => {
    mockSelectSequence([]) // before 查无
    const r = await updateMerchant('lm_1', { merchantName: 'M', merchantNo: null, termNo: null, enabled: false })
    expect(r.success).toBe(false)
    expect(r.message).toContain('商户不存在')
  })

  it('乐观锁冲突（count=0）→ 提示刷新', async () => {
    mockSelectSequence([{ id: 'lm_1', merchantName: 'old' }], []) // before, dup
    mockUpdate(0)
    const r = await updateMerchant(
      'lm_1',
      { merchantName: 'M', merchantNo: '8222900', termNo: 'T', enabled: false },
      '2026-06-24T00:00:00.000Z',
    )
    expect(r.success).toBe(false)
    expect(r.message).toContain('已被其他人修改')
  })

  it('合法更新 → 成功（update 被调）', async () => {
    mockSelectSequence([{ id: 'lm_1', merchantName: 'old' }], []) // before, dup
    const { set } = mockUpdate(1)
    const r = await updateMerchant('lm_1', { merchantName: 'M', merchantNo: '8222900', termNo: 'T', enabled: false })
    expect(r.success).toBe(true)
    expect(set).toHaveBeenCalled()
  })
})

describe('deleteMerchant', () => {
  it('仍被门店关联 → 拒绝（不删）', async () => {
    mockSelectSequence([{ id: 'lm_1', merchantName: 'M', merchantNo: '1' }], [{ cnt: 2 }]) // before, count
    const r = await deleteMerchant('lm_1')
    expect(r.success).toBe(false)
    expect(r.message).toContain('门店关联')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('无门店关联 → 删除成功', async () => {
    mockSelectSequence([{ id: 'lm_1', merchantName: 'M', merchantNo: '1' }], [{ cnt: 0 }]) // before, count
    const where = mockDelete()
    const r = await deleteMerchant('lm_1')
    expect(r.success).toBe(true)
    expect(where).toHaveBeenCalled()
  })
})

describe('getMerchantById', () => {
  it('不存在 → 返回 null', async () => {
    mockSelectSequence([]) // 主查无
    const r = await getMerchantById('lm_missing')
    expect(r).toBeNull()
  })

  it('存在 → 返回详情 + 关联门店', async () => {
    mockSelectSequence(
      [{ id: 'lm_1', merchantName: '凤仪韵', merchantNo: '8222900', termNo: 'T', enabled: true, createdAt: new Date(), updatedAt: new Date() }],
      [{ storeId: 'S1', storeName: '莲塘店', marketName: '南昌' }],
    )
    const r = await getMerchantById('lm_1')
    expect(r?.id).toBe('lm_1')
    expect(r?.linkedStores).toHaveLength(1)
    expect(r?.linkedStores[0].storeName).toBe('莲塘店')
  })
})

describe('getMerchantsPaginated', () => {
  it('返回分页数据 + total', async () => {
    mockSelectSequence(
      [{ count: 1 }], // countQuery
      [{ id: 'lm_1', merchantName: '凤仪韵', merchantNo: '8222900', termNo: 'T', enabled: true, createdAt: new Date(), updatedAt: new Date(), storeCount: 2 }], // dataQuery
    )
    const r = await getMerchantsPaginated({})
    expect(r.total).toBe(1)
    expect(r.data).toHaveLength(1)
    expect(r.data[0].storeCount).toBe(2)
  })
})
