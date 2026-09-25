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
    '%s 的 produced 段被完整转发给 engine',
    async (operationId) => {
      const { produced } = INVENTORY_OPERATION_DOC_QUERY[operationId]
      await listInventoryOperationDocs({ operationId, page: 3, pageSize: 20 })
      // produced 永远是第 1 次调用：两段都查时顺序固定（produced → inbox），
      // 倒过来的话前端拿到的两组会对调，列表看起来正常、内容全错。
      expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(1, {
        docTypes: produced.docTypes,
        statuses: produced.statuses,
        locationType: produced.locationType,
        scopeRole: produced.scopeRole,
        cancellationRequested: produced.cancellationRequested,
        pendingItemScope: produced.pendingItemScope,
        page: 3,
        pageSize: 20,
      })
    },
  )

  it.each(INVENTORY_OPERATION_IDS.map((id) => [id] as const))(
    '%s 的 inbox 段：有就恰好查 2 次，没有就只查 1 次且返回 null',
    async (operationId) => {
      const { inbox } = INVENTORY_OPERATION_DOC_QUERY[operationId]
      const result = await listInventoryOperationDocs({ operationId, page: 3, inboxPage: 2, pageSize: 20 })
      if (!inbox) {
        // ⚠️ 无 inbox 的业务不许图省事查两次：每次多一次 COUNT +
        // syncInventoryLocations + getSession。
        expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledTimes(1)
        expect(result.inbox).toBeNull()
        return
      }
      expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledTimes(2)
      expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, {
        docTypes: inbox.docTypes,
        statuses: inbox.statuses,
        locationType: inbox.locationType,
        scopeRole: inbox.scopeRole,
        cancellationRequested: inbox.cancellationRequested,
        pendingItemScope: inbox.pendingItemScope,
        page: 2,
        pageSize: 20,
      })
      expect(result.inbox).not.toBeNull()
    },
  )

  it('两段分页独立、pageSize 共用', async () => {
    // inbox 与 produced 各自翻页：共用一个 page 的话，用户翻产出区第 3 页，
    // 待办区也跟着跳到第 3 页（大概率空白）。
    await listInventoryOperationDocs({ operationId: 'market-receipt', page: 3, inboxPage: 2, pageSize: 20 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 3, pageSize: 20 }))
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, pageSize: 20 }))
  })

  it('两段各自回传 engine 的 pageSize / canViewPrice，不互相覆盖', async () => {
    // engine 会把非白名单页长夹回 20 并回传实际值；两段必须各拿各的，
    // 前端按各自的 pageSize 算总页数（共用一个会让某一段的最后几页翻不到）。
    mockEngine.listInventoryCoreDocs
      .mockResolvedValueOnce({ data: [{ id: 'P1' }], total: 41, pageSize: 20, canViewPrice: true, priceVisibility: 'all' })
      .mockResolvedValueOnce({ data: [{ id: 'I1' }], total: 6, pageSize: 20, canViewPrice: false, priceVisibility: 'none' })
    const result = await listInventoryOperationDocs({ operationId: 'store-receipt', page: 1 })
    expect(result.produced).toEqual({ data: [{ id: 'P1' }], total: 41, pageSize: 20, canViewPrice: true, priceVisibility: 'all' })
    expect(result.inbox).toEqual({ data: [{ id: 'I1' }], total: 6, pageSize: 20, canViewPrice: false, priceVisibility: 'none' })
  })

  it('三个带可选条件的业务实参逐字段钉死', async () => {
    // 上面那条是表驱动的自反比较（映射改了实参跟着改），这里把三组**具体值**写死，
    // 防止映射与断言一起被改错还全绿。
    await listInventoryOperationDocs({ operationId: 'supply-chain-purchase-cancel', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(1, {
      // 类型随 #194 从「供应链采购订单」并成「采购订单」，靠 statuses 与建单业务区分
      docTypes: ['采购订单'], statuses: ['已取消'], locationType: undefined, scopeRole: undefined,
      cancellationRequested: undefined, pendingItemScope: undefined, page: 1, pageSize: undefined,
    })
    // 关闭采购的 inbox 刻意不带 pendingItemScope（关闭作用于整单，见映射表注释），
    // 但**带** scopeRole=target（cancelSupplyChainPurchaseOrder 断的是 order.targetOrgNodeId）
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, {
      docTypes: ['采购订单'], statuses: ['待收货'], locationType: undefined, scopeRole: 'target',
      cancellationRequested: undefined, pendingItemScope: undefined, page: undefined, pageSize: undefined,
    })

    vi.clearAllMocks()
    await listInventoryOperationDocs({ operationId: 'supply-chain-conversion', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      docTypes: ['库存转换出库', '库存转换入库'], statuses: undefined, locationType: '总部', scopeRole: undefined,
      cancellationRequested: undefined, pendingItemScope: undefined, page: 1, pageSize: undefined,
    })

    vi.clearAllMocks()
    await listInventoryOperationDocs({ operationId: 'shipment-cancel-approval', page: 1 })
    // 同 docType 两段，只靠 statuses 互斥 —— 两条实参都钉死
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(1, {
      docTypes: ['品项公司发货'], statuses: ['已取消'], locationType: undefined, scopeRole: undefined,
      cancellationRequested: true, pendingItemScope: undefined, page: 1, pageSize: undefined,
    })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, {
      // scopeRole='source' 是全表唯一一条按发货方收窄的 inbox（审批要回滚总部库存）
      docTypes: ['品项公司发货'], statuses: ['待审批'], locationType: undefined, scopeRole: 'source',
      cancellationRequested: true, pendingItemScope: undefined, page: undefined, pageSize: undefined,
    })

    vi.clearAllMocks()
    await listInventoryOperationDocs({ operationId: 'supply-chain-receipt', page: 1 })
    // pendingItemScope 必须真的转发到 engine：漏转的话已收满（存量口径异常）的采购订单也会进待办区
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, {
      docTypes: ['采购订单'], statuses: ['待收货'], locationType: undefined, scopeRole: 'target',
      cancellationRequested: undefined, pendingItemScope: 'supply-chain', page: undefined, pageSize: undefined,
    })
  })

  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    '原型链上的键 %s 被拒，不会退化成「不加任何过滤」',
    async (operationId) => {
      // 映射表是普通对象字面量，`MAP['constructor']` 拿到的是 Object 构造函数 —— truthy，
      // `if (!query) throw` 拦不住；而它的 produced/docTypes/statuses 全是 undefined，
      // engine 里每个 `if (filters.xxx)` 分支都不进 → 返回 scope 内全部单据。
      // （两段式之后 `query.produced` 是 undefined，最好的情况是 TypeError；
      //   但靠异常兜底是运气，白名单前置闸才是这条防线本身。）
      await expect(listInventoryOperationDocs({ operationId })).rejects.toThrow('INVALID_PARAMS')
      expect(mockEngine.listInventoryCoreDocs).not.toHaveBeenCalled()
    },
  )

  it('通用业务 id 解析为「查这一种单据」，无 inbox 时只查一次', async () => {
    const result = await listInventoryOperationDocs({ operationId: 'generic:市场产品报损', page: 1 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledTimes(1)
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenLastCalledWith({
      docTypes: ['市场产品报损'], statuses: undefined, locationType: undefined, scopeRole: undefined,
      cancellationRequested: undefined, pendingItemScope: undefined, page: 1, pageSize: undefined,
    })
    expect(result.inbox).toBeNull()
  })

  it('门店调拨（generic:分院调货出库）带 inbox：产出不限状态、待办只要待收货', async () => {
    // 门店层最大的一批待办（dev 库 6 条）挂在这张通用卡上，不在 store-receipt。
    // 两段刻意同 docType 重叠：这张卡自己建单也自己收货。
    await listInventoryOperationDocs({ operationId: 'generic:分院调货出库', page: 1, inboxPage: 2 })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenCalledTimes(2)
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(1, {
      docTypes: ['分院调货出库'], statuses: undefined, locationType: undefined, scopeRole: undefined,
      cancellationRequested: undefined, pendingItemScope: undefined, page: 1, pageSize: undefined,
    })
    expect(mockEngine.listInventoryCoreDocs).toHaveBeenNthCalledWith(2, {
      // scopeRole='target' = #192 P1：不带它，发货门店会把自己发出去的单列成「待我处理」
      docTypes: ['分院调货出库'], statuses: ['待收货'], locationType: undefined, scopeRole: 'target',
      cancellationRequested: undefined, pendingItemScope: undefined, page: 2, pageSize: undefined,
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
