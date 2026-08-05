import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/message', () => ({
  messages: {
    id: 'id',
    recipientType: 'recipient_type',
    recipientId: 'recipient_id',
    title: 'title',
    body: 'body',
    messageType: 'message_type',
    isRead: 'is_read',
    refEntityType: 'ref_entity_type',
    refEntityId: 'ref_entity_id',
    createdAt: 'created_at',
    deletedAt: 'deleted_at',
    deletedBy: 'deleted_by',
  },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
    boundStoreId: 'bound_store_id',
    memberLevel: {
      enumValues: ['初钻', '星钻', '粉钻', '金钻', '黑钻'],
    },
  },
  staffWechatUsers: {
    employeeId: 'employee_id',
    name: 'name',
    storeId: 'staff_store_id',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    parentId: 'parent_id',
    sortOrder: 'sort_order',
    isActive: 'is_active',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  stores: {
    storeId: 'store_id',
    storeName: 'store_name',
    orgNodeId: 'org_node_id',
  },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isAdminScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  isNotNull: vi.fn((a) => ({ type: 'isNotNull', a })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: Object.assign(
    vi.fn(() => ({ type: 'sql' })),
    { raw: vi.fn(() => ({ type: 'sql_raw' })) },
  ),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((table, _name) => table),
}))

import {
  batchSendMessages,
  getMessagesPaginated,
  getCustomersForBatchMessage,
  getOrgNodesForBatchMessage,
  deleteMessage,
} from './messages'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { logOperation } from '@/lib/operation-log'
import { eq } from 'drizzle-orm'
import { isAdminScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['message:send', 'message:list'], scopeStoreIds: [] },
}

/**
 * 构造带 FIFO 行为的 db.select 模拟：
 * 按 `queue` 顺序依次返回链式对象，终端（where / limit / orderBy）resolve 成 rows。
 */
type SelectStep =
  | { terminal: 'where'; rows: any[] }
  | { terminal: 'limit'; rows: any[] }
  | { terminal: 'orderBy'; rows: any[] }
  | { terminal: 'offset'; rows: any[] }

function enqueueSelect(steps: SelectStep[]) {
  let i = 0
  ;(db.select as any).mockImplementation(() => {
    const step = steps[i++]
    if (!step) {
      throw new Error(`db.select called more times than mocked (index=${i - 1})`)
    }
    const chain: any = {}
    const terminalFn = vi.fn().mockResolvedValue(step.rows)

    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.innerJoin = vi.fn().mockReturnValue(chain)
    chain.where = step.terminal === 'where' ? terminalFn : vi.fn().mockReturnValue(chain)
    chain.orderBy =
      step.terminal === 'orderBy' ? terminalFn : vi.fn().mockReturnValue(chain)
    chain.limit = step.terminal === 'limit' ? terminalFn : vi.fn().mockReturnValue(chain)
    chain.offset =
      step.terminal === 'offset' ? terminalFn : vi.fn().mockResolvedValue(step.rows)
    return chain
  })
}

// ── batchSendMessages: 基础校验 ─────────────────────────────────────

describe('batchSendMessages — 基础校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('空标题 → 拒绝', async () => {
    const result = await batchSendMessages({ title: '', userIds: ['U-001'] })
    expect(result.success).toBe(false)
    expect(result.message).toContain('标题')
  })

  it('全空白标题 → 拒绝', async () => {
    const result = await batchSendMessages({ title: '   ', userIds: ['U-001'] })
    expect(result.success).toBe(false)
    expect(result.message).toContain('标题')
  })

  it('标题超 200 字 → 拒绝', async () => {
    const longTitle = 'a'.repeat(201)
    const result = await batchSendMessages({ title: longTitle, userIds: ['U-001'] })
    expect(result.success).toBe(false)
    expect(result.message).toContain('200')
  })

  it('分类超 50 字 → 拒绝', async () => {
    const result = await batchSendMessages({
      title: 'OK',
      messageType: 'x'.repeat(51),
      userIds: ['U-001'],
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('50')
  })

  it('未提供 userIds 与 filters → 拒绝', async () => {
    const result = await batchSendMessages({ title: '通知' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('接收人')
  })
})

// ── batchSendMessages: 精确投递（userIds） ─────────────────────────

describe('batchSendMessages — 精确投递 userIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('userIds 超过 1000 → 拒绝', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `U-${i}`)
    const result = await batchSendMessages({ title: '通知', userIds: ids })
    expect(result.success).toBe(false)
    expect(result.message).toContain('1000')
  })

  it('所有 userId 均不存在 → 拒绝', async () => {
    // 仅一次 select → 查存在性 → 返回空
    enqueueSelect([{ terminal: 'where', rows: [] }])
    const result = await batchSendMessages({
      title: '通知',
      userIds: ['U-NOT-EXIST-1', 'U-NOT-EXIST-2'],
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('存在+去重 → INSERT + 审计', async () => {
    // 1 次 select → 校验存在性
    enqueueSelect([
      { terminal: 'where', rows: [{ userId: 'U-001' }, { userId: 'U-002' }] },
    ])
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    ;(db.insert as any).mockReturnValue({ values: valuesFn })

    const result = await batchSendMessages({
      title: '  春节活动通知  ', // 测 trim
      body: '  正文  ',
      messageType: 'promotion',
      userIds: ['U-001', 'U-002', 'U-001'], // 含重复
    })

    expect(result.success).toBe(true)
    expect(result.count).toBe(2)
    expect(db.insert).toHaveBeenCalledTimes(1)

    const inserted = valuesFn.mock.calls[0][0]
    expect(inserted).toHaveLength(2)
    expect(inserted[0].recipientType).toBe('客户')
    expect(inserted[0].title).toBe('春节活动通知') // trim 生效
    expect(inserted[0].body).toBe('正文')
    expect(inserted[0].messageType).toBe('promotion')
    expect(inserted[0].isRead).toBe(false)

    // 审计日志写入
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'message.batchSend',
      'message',
      'batch',
      expect.objectContaining({ count: 2, mode: 'userIds' }),
    )
  })

  it('部分 userId 存在 → 只发给存在的', async () => {
    enqueueSelect([{ terminal: 'where', rows: [{ userId: 'U-001' }] }])
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    ;(db.insert as any).mockReturnValue({ values: valuesFn })

    const result = await batchSendMessages({
      title: '通知',
      userIds: ['U-001', 'U-NOT-EXIST'],
    })
    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
    expect(valuesFn.mock.calls[0][0]).toHaveLength(1)
  })

  it('空正文/分类 → 存储为 null', async () => {
    enqueueSelect([{ terminal: 'where', rows: [{ userId: 'U-001' }] }])
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    ;(db.insert as any).mockReturnValue({ values: valuesFn })

    await batchSendMessages({ title: '通知', body: '   ', messageType: '', userIds: ['U-001'] })

    const inserted = valuesFn.mock.calls[0][0]
    expect(inserted[0].body).toBeNull()
    expect(inserted[0].messageType).toBeNull()
  })
})

// ── batchSendMessages: 筛选投递（filters） ────────────────────────

describe('batchSendMessages — 筛选投递 filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('filters 命中为 0 → 拒绝', async () => {
    // count 查询返回 0
    enqueueSelect([{ terminal: 'where', rows: [{ count: 0 }] }])
    const result = await batchSendMessages({
      title: '通知',
      filters: { memberLevel: '黑钻' },
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('没有匹配')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('filters 命中 > 1000 → 拒绝', async () => {
    enqueueSelect([{ terminal: 'where', rows: [{ count: 1500 }] }])
    const result = await batchSendMessages({
      title: '通知',
      filters: { memberLevel: '黑钻' },
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('1500')
    expect(result.message).toContain('1000')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('filters 正常命中 → count + 展开 + INSERT', async () => {
    // 1) count 查询 → 返回 3
    // 2) 展开 userId 列表 → 返回 3 条
    enqueueSelect([
      { terminal: 'where', rows: [{ count: 3 }] },
      {
        terminal: 'where',
        rows: [{ userId: 'U-001' }, { userId: 'U-002' }, { userId: 'U-003' }],
      },
    ])
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    ;(db.insert as any).mockReturnValue({ values: valuesFn })

    const result = await batchSendMessages({
      title: '促销消息',
      filters: { memberLevel: '黑钻' },
    })
    expect(result.success).toBe(true)
    expect(result.count).toBe(3)
    expect(valuesFn.mock.calls[0][0]).toHaveLength(3)
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'message.batchSend',
      'message',
      'batch',
      expect.objectContaining({ count: 3, mode: 'filters' }),
    )
  })

  it('filters orgNodeId=门店 → 解析为单门店 storeId → count → 展开', async () => {
    // 1) resolveOrgNodeToStoreIds: 查节点类型 → 门店
    // 2) resolveOrgNodeToStoreIds: 查该节点对应 storeId
    // 3) count 查询
    // 4) 展开 userId 列表
    enqueueSelect([
      { terminal: 'limit', rows: [{ type: '门店', parentId: 'market-1' }] },
      { terminal: 'limit', rows: [{ storeId: 'S-001' }] },
      { terminal: 'where', rows: [{ count: 1 }] },
      { terminal: 'where', rows: [{ userId: 'U-001' }] },
    ])
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    ;(db.insert as any).mockReturnValue({ values: valuesFn })

    const result = await batchSendMessages({
      title: '门店通知',
      filters: { orgNodeId: 'store-node-1' },
    })
    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
  })

  it('filters orgNodeId=门店节点无对应 store → 拒绝（空筛选）', async () => {
    // 1) 查节点类型 → 门店
    // 2) 查 storeId → 返回空
    enqueueSelect([
      { terminal: 'limit', rows: [{ type: '门店', parentId: 'market-1' }] },
      { terminal: 'limit', rows: [] },
    ])
    const result = await batchSendMessages({
      title: '通知',
      filters: { orgNodeId: 'orphan-store' },
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('暂无顾客')
  })
})

// ── getCustomersForBatchMessage ─────────────────────────────────────

describe('getCustomersForBatchMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无筛选 → 返回 count + rows', async () => {
    enqueueSelect([
      { terminal: 'where', rows: [{ count: 2 }] },
      {
        terminal: 'offset',
        rows: [
          {
            userId: 'U-001',
            name: '张三',
            phone: '13800000001',
            storeName: '总店',
            memberLevel: '黑钻',
          },
          {
            userId: 'U-002',
            name: '李四',
            phone: '13800000002',
            storeName: null,
            memberLevel: null,
          },
        ],
      },
    ])

    const result = await getCustomersForBatchMessage({})
    expect(result.total).toBe(2)
    expect(result.data).toHaveLength(2)
    expect(result.data[0].storeName).toBe('总店')
    expect(result.data[1].storeName).toBeNull()
  })

  it('orgNodeId=市场 → 展开为多门店 → 正常返回', async () => {
    enqueueSelect([
      // resolveOrgNodeToStoreIds: 查节点 → 市场类型
      { terminal: 'limit', rows: [{ type: '市场', parentId: null }] },
      // resolveOrgNodeToStoreIds: innerJoin 查该市场下 storeIds
      { terminal: 'where', rows: [{ storeId: 'S-001' }, { storeId: 'S-002' }] },
      // count
      { terminal: 'where', rows: [{ count: 1 }] },
      // 列表
      {
        terminal: 'offset',
        rows: [
          {
            userId: 'U-001',
            name: '张三',
            phone: '13800000001',
            storeName: 'S-001 门店',
            memberLevel: '金钻',
          },
        ],
      },
    ])

    const result = await getCustomersForBatchMessage({ orgNodeId: 'market-1' })
    expect(result.total).toBe(1)
    expect(result.data[0].userId).toBe('U-001')
  })

  it('orgNodeId 无效节点 → 当作不过滤继续查询', async () => {
    enqueueSelect([
      // resolveOrgNodeToStoreIds: 查节点 → 未找到（返回 null 等价于不过滤）
      { terminal: 'limit', rows: [] },
      // count
      { terminal: 'where', rows: [{ count: 0 }] },
      // 列表
      { terminal: 'offset', rows: [] },
    ])
    const result = await getCustomersForBatchMessage({ orgNodeId: 'ghost' })
    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })
})

// ── getMessagesPaginated — 门店范围 ──────────────────────────────────

describe('getMessagesPaginated — 门店范围', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('使用已展开的 scopeStoreIds，并同时限制客户和员工接收人', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'manager', scopeId: 'market-node-1', scopeType: '市场' }],
      permissions: { actions: ['message:list'], scopeStoreIds: ['store-allowed'] },
    })
    ;(isAdminScope as any).mockReturnValueOnce(false)
    enqueueSelect([
      { terminal: 'where', rows: [{ count: 0 }] },
      { terminal: 'offset', rows: [] },
    ])

    await getMessagesPaginated({ page: 1 })

    expect(eq).toHaveBeenCalledWith('bound_store_id', 'store-allowed')
    expect(eq).toHaveBeenCalledWith('staff_store_id', 'store-allowed')
  })
})

// ── getOrgNodesForBatchMessage ──────────────────────────────────────

describe('getOrgNodesForBatchMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回组织树节点（ISO 日期字符串化）', async () => {
    enqueueSelect([
      {
        terminal: 'orderBy',
        rows: [
          {
            id: 'hq-1',
            name: '总部',
            type: '总部',
            parentId: null,
            sortOrder: 0,
            isActive: true,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-02-01T00:00:00Z'),
          },
        ],
      },
    ])

    const result = await getOrgNodesForBatchMessage()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('hq-1')
    expect(result[0].type).toBe('总部')
    expect(result[0].createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

// ── deleteMessage — 软删流程 ─────────────────────────────────────────

describe('deleteMessage — 软删', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('消息不存在 / 已删 → 拒绝（不进入 update）', async () => {
    enqueueSelect([{ terminal: 'limit', rows: [] }])
    const result = await deleteMessage(123)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或已被删除')
    expect(db.update).not.toHaveBeenCalled()
    expect(logOperation).not.toHaveBeenCalled()
  })

  it('未删消息 → 写入审计日志 + 软删 + 成功', async () => {
    enqueueSelect([{
      terminal: 'limit',
      rows: [{
        id: 123, recipientType: '客户', recipientId: 'C-1',
        title: '订单已确认', messageType: 'order', isRead: false,
        createdAt: new Date('2026-05-18T10:00:00Z'),
      }],
    }])
    setupUpdate(1)
    const result = await deleteMessage(123)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'message.delete',
      'message',
      '123',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
    expect(db.update).toHaveBeenCalledTimes(1)
  })

  it('软删 update rowCount=0 → 并发冲突提示', async () => {
    enqueueSelect([{
      terminal: 'limit',
      rows: [{
        id: 123, recipientType: '客户', recipientId: 'C-1',
        title: 'x', messageType: null, isRead: false, createdAt: new Date(),
      }],
    }])
    setupUpdate(0)
    const result = await deleteMessage(123)
    expect(result.success).toBe(false)
    expect(result.message).toContain('请刷新重试')
  })
})
