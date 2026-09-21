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
import {
  INVENTORY_OPERATION_DOC_QUERY,
  INVENTORY_OPERATION_IDS,
} from '@/lib/inventory/operation-doc-types'
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

  /*
   * 全部 24 个业务逐条验证「映射表 → 传给 engine 的实参」这段**接线**。
   *
   * 映射表本身有 operation-doc-types.test.ts 守着、engine 的过滤有 engine.test.ts 守着，
   * 但两端各自正确不代表中间接对了：漏转发 locationType，转换业务就会串到别层级的转换单；
   * 漏转发 cancellationRequested，撤回业务就会列出全部发货单。两者都不会报错。
   * 所以这里用**精确对象比较**（不是 objectContaining），多传少传都会红。
   */
  it.each(INVENTORY_OPERATION_IDS.map((id) => [id] as const))(
    '%s 的映射被完整转发给 engine',
    async (operationId) => {
      const query = INVENTORY_OPERATION_DOC_QUERY[operationId]
      await listInventoryOperationDocs({ operationId, page: 3, pageSize: 20 })
      expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledWith({
        docTypes: query.docTypes,
        statuses: query.statuses,
        locationType: query.locationType,
        cancellationRequested: query.cancellationRequested,
        page: 3,
        pageSize: 20,
      })
    },
  )

  it('三个带可选条件的业务实参逐字段钉死', async () => {
    // 上面那条是表驱动的自反比较（映射改了实参跟着改），这里把三组**具体值**写死，
    // 防止映射与断言一起被改错还全绿。
    await listInventoryOperationDocs({ operationId: 'supply-chain-purchase-cancel', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      // 类型随 #194 从「供应链采购订单」并成「采购订单」，靠 statuses 与建单业务区分
      docTypes: ['采购订单'], statuses: ['已取消'], locationType: undefined,
      cancellationRequested: undefined, page: 1, pageSize: undefined,
    })

    await listInventoryOperationDocs({ operationId: 'market-conversion', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      docTypes: ['库存转换出库', '库存转换入库'], statuses: undefined, locationType: '市场',
      cancellationRequested: undefined, page: 1, pageSize: undefined,
    })

    await listInventoryOperationDocs({ operationId: 'shipment-cancel-approval', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      docTypes: ['品项公司发货'], statuses: ['已取消'], locationType: undefined,
      cancellationRequested: true, page: 1, pageSize: undefined,
    })
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

  it('通用业务 id 解析为「查这一种单据」', async () => {
    await listInventoryOperationDocs({ operationId: 'generic:市场产品报损', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      docTypes: ['市场产品报损'], statuses: undefined, locationType: undefined,
      cancellationRequested: undefined, page: 1, pageSize: undefined,
    })
  })

  it('拼业务单类型的通用 id 被拒，不能从通用入口绕过专用服务', async () => {
    // '品项公司发货' 是真实 docType，但必须走 createItemCompanyShipment 那套
    // 数量/价格/批次校验；能从这里查出来就说明白名单破了。
    for (const docType of ['品项公司发货', '采购订单', '库存转换出库']) {
      await expect(
        listInventoryOperationDocs({ operationId: `generic:${docType}` }),
      ).rejects.toThrow('INVALID_PARAMS')
    }
    expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
  })

  it('未知业务 id 被拒', async () => {
    await expect(listInventoryOperationDocs({ operationId: 'not-a-business' })).rejects.toThrow('INVALID_PARAMS')
    expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
  })

  it('空串 operationId 被拒', async () => {
    await expect(listInventoryOperationDocs({ operationId: '' })).rejects.toThrow('INVALID_PARAMS')
    expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
  })
})
