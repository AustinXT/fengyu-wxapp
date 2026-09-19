import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEngine } = vi.hoisted(() => ({
  mockEngine: {
    approveInventoryCoreDoc: vi.fn(),
    confirmInventoryCoreReceive: vi.fn(),
    createInventoryCoreDoc: vi.fn(),
    getInventoryCoreDocById: vi.fn(),
    listInventoryCoreDocs: vi.fn(),
    rejectInventoryCoreDoc: vi.fn(),
  },
}))

vi.mock('@/lib/inventory/engine', () => mockEngine)
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  isAdminScope: vi.fn(() => true),
  requireAnyPermission: vi.fn(),
  requirePermission: vi.fn(),
}))

import { getSession } from '@/lib/auth'
import { listInventoryOperationDocs } from './docs'

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部', actions: ['inventory:list'] }],
  permissions: { actions: ['inventory:list'], scopeStoreIds: [], scopeOrgNodeIds: [] },
}

/**
 * `listInventoryOperationDocs` 的入参闸门（#190）。
 *
 * 这个 action 的全部安全价值在于「客户端只能说自己是哪个业务，说不了查什么单据类型」。
 * 闸门一旦 fail-open，返回的就是 scope 内**全部**库存单据 —— 页面看起来完全正常，
 * 只是列出了别的业务的单，没有任何报错能提示这件事。
 */
describe('listInventoryOperationDocs 入参闸门', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue(SESSION as never)
    mockEngine.listInventoryCoreDocs.mockResolvedValue({
      data: [], total: 0, pageSize: 20, canViewPrice: true, priceVisibility: 'all',
    })
  })

  it('合法业务 id 按映射表解析出收窄条件', async () => {
    await listInventoryOperationDocs({ operationId: 'supply-chain-purchase-cancel', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledWith(
      expect.objectContaining({ docTypes: ['供应链采购订单'], statuses: ['已取消'] }),
    )
  })

  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    '原型链上的键 %s 被拒，不会退化成「不加任何过滤」',
    async (operationId) => {
      // 映射表是普通对象字面量，`MAP['constructor']` 拿到的是 Object 构造函数 —— truthy，
      // `if (!query) throw` 拦不住；而它的 docTypes/statuses 全是 undefined，
      // engine 里每个 `if (filters.xxx)` 分支都不进 → 返回 scope 内全部单据。
      await expect(listInventoryOperationDocs({ operationId })).rejects.toThrow('INVALID_PARAMS')
      expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
    },
  )

  it('未知业务 id 被拒', async () => {
    await expect(listInventoryOperationDocs({ operationId: 'not-a-business' })).rejects.toThrow('INVALID_PARAMS')
    expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
  })

  it('空串 operationId 被拒', async () => {
    await expect(listInventoryOperationDocs({ operationId: '' })).rejects.toThrow('INVALID_PARAMS')
    expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
  })
})
