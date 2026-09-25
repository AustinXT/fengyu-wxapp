import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockBusiness } = vi.hoisted(() => ({
  mockBusiness: {
    approveItemCompanyShipmentCancellation: vi.fn(),
    approveReturnForRestock: vi.fn(),
    cancelSupplyChainPurchaseOrder: vi.fn(),
    createInventoryConversion: vi.fn(),
    getShipmentReceiptProgress: vi.fn(),
    receiveItemCompanyShipment: vi.fn(),
    receiveItemCompanyShipmentInFull: vi.fn(),
    receiveStoreAllocation: vi.fn(),
    receiveStoreAllocationInFull: vi.fn(),
    rejectItemCompanyShipmentCancellation: vi.fn(),
    rejectReturnForRestock: vi.fn(),
  },
}))

/*
 * lib 层整个 mock 掉：本文件测的是**接线**（哪个 action 挂哪道权限闸、入参怎么转发、
 * 业务错误能不能带着 digest 穿到客户端），业务本身由 lib/inventory/business.test.ts 覆盖。
 * 真 import lib 会把 `import 'server-only'` 和 PG 连接一起拖进来。
 */
vi.mock('@/lib/inventory/business', () => mockBusiness)
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  isAdminScope: vi.fn(() => true),
  requireAnyPermission: vi.fn(),
  requirePermission: vi.fn(),
}))
vi.mock('@/lib/action-scope', () => ({
  scopeSessionToActions: vi.fn((session: unknown) => session),
  scopeSessionToAllActions: vi.fn((session: unknown) => session),
}))

import { getSession } from '@/lib/auth'
import { ApiError } from '@/lib/api-error'
import { scopeSessionToActions, scopeSessionToAllActions } from '@/lib/action-scope'
import { requireAnyPermission, requirePermission } from '@/lib/permissions'
import {
  approveItemCompanyShipmentCancellation,
  approveReturnForRestock,
  cancelSupplyChainPurchaseOrder,
  createInventoryConversion,
  receiveItemCompanyShipment,
  receiveItemCompanyShipmentInFull,
  receiveStoreAllocation,
  receiveStoreAllocationInFull,
  rejectItemCompanyShipmentCancellation,
  rejectReturnForRestock,
} from './business'

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部', actions: [] }],
  permissions: { actions: [], scopeStoreIds: [], scopeOrgNodeIds: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockResolvedValue(SESSION as never)
  // clearAllMocks 只清调用记录、不清实现：某条用例把 requirePermission 换成「抛拒绝」后
  // 不复位，后面每条都会被它拒掉。这里显式回到「放行」。
  vi.mocked(requirePermission).mockImplementation(() => {})
  vi.mocked(requireAnyPermission).mockImplementation(() => {})
  vi.mocked(scopeSessionToActions).mockImplementation((session) => session)
  vi.mocked(scopeSessionToAllActions).mockImplementation((session) => session)
})

/**
 * 整单收货（#192 待办区「一键收货」）的**权限边界**。
 *
 * 这是本次改动唯一的越权风险点：如果把两个入口合成一个
 * `withAnyPermission(['inventory:market_operate','inventory:store_operate'])`
 * 再在 impl 里按 docType 分发，只持有 market_operate 的市场角色就能在 scope
 * 覆盖下属门店时替门店收货 —— lib 层只有 `assertLocationWritable`（scope 校验），
 * 没有 action 级校验，拦不住。所以这里逐条钉「走的是哪一种 HOF、闸的是哪个动作」。
 */
describe('整单收货入口的权限闸门（#192）', () => {
  it('receiveItemCompanyShipmentInFull 只闸 inventory:market_operate，且不是 any/all 版本', async () => {
    mockBusiness.receiveItemCompanyShipmentInFull.mockResolvedValue({ id: 'MRK-1', shipmentId: 'GFH-1' })
    await receiveItemCompanyShipmentInFull({ shipmentId: 'GFH-1' })

    expect(requirePermission).toHaveBeenCalledTimes(1)
    expect(requirePermission).toHaveBeenCalledWith(SESSION, 'inventory:market_operate')
    // withAnyPermission 走 requireAnyPermission；withAllPermissions 会多次 requirePermission
    // 且改用 scopeSessionToAllActions —— 两条都钉住，换 HOF 必红。
    expect(requireAnyPermission).not.toHaveBeenCalled()
    expect(scopeSessionToAllActions).not.toHaveBeenCalled()
    expect(scopeSessionToActions).toHaveBeenCalledWith(SESSION, ['inventory:market_operate'])
  })

  it('receiveStoreAllocationInFull 只闸 inventory:store_operate，且不是 any/all 版本', async () => {
    mockBusiness.receiveStoreAllocationInFull.mockResolvedValue({ id: 'YRK-1', shipmentId: 'FPH-1' })
    await receiveStoreAllocationInFull({ shipmentId: 'FPH-1' })

    expect(requirePermission).toHaveBeenCalledTimes(1)
    expect(requirePermission).toHaveBeenCalledWith(SESSION, 'inventory:store_operate')
    expect(requireAnyPermission).not.toHaveBeenCalled()
    expect(scopeSessionToAllActions).not.toHaveBeenCalled()
    expect(scopeSessionToActions).toHaveBeenCalledWith(SESSION, ['inventory:store_operate'])
  })

  it('两个整单入口的权限与各自「带明细」的老入口逐字一致', async () => {
    // 规格要求：一键收货不得比部分收货更宽松。两两对照，任一侧被改都会红。
    mockBusiness.receiveItemCompanyShipment.mockResolvedValue({ id: 'MRK-1', shipmentId: 'GFH-1' })
    await receiveItemCompanyShipment({ shipmentId: 'GFH-1', items: [] })
    const marketPartial = vi.mocked(requirePermission).mock.calls.map(([, action]) => action)

    vi.mocked(requirePermission).mockClear()
    mockBusiness.receiveItemCompanyShipmentInFull.mockResolvedValue({ id: 'MRK-1', shipmentId: 'GFH-1' })
    await receiveItemCompanyShipmentInFull({ shipmentId: 'GFH-1' })
    expect(vi.mocked(requirePermission).mock.calls.map(([, action]) => action)).toEqual(marketPartial)

    vi.mocked(requirePermission).mockClear()
    mockBusiness.receiveStoreAllocation.mockResolvedValue({ id: 'YRK-1', shipmentId: 'FPH-1' })
    await receiveStoreAllocation({ shipmentId: 'FPH-1', items: [] })
    const storePartial = vi.mocked(requirePermission).mock.calls.map(([, action]) => action)

    vi.mocked(requirePermission).mockClear()
    mockBusiness.receiveStoreAllocationInFull.mockResolvedValue({ id: 'YRK-1', shipmentId: 'FPH-1' })
    await receiveStoreAllocationInFull({ shipmentId: 'FPH-1' })
    expect(vi.mocked(requirePermission).mock.calls.map(([, action]) => action)).toEqual(storePartial)

    // 两条链路互不相等，防「一起改错成同一个动作」也全绿。
    expect(marketPartial).not.toEqual(storePartial)
  })

  it('权限不足时直接拒，不会进 lib 层', async () => {
    vi.mocked(requirePermission).mockImplementation(() => {
      throw new Error('PERMISSION_DENIED: inventory:store_operate')
    })
    await expect(receiveStoreAllocationInFull({ shipmentId: 'FPH-1' }))
      .rejects.toThrow('PERMISSION_DENIED')
    expect(mockBusiness.receiveStoreAllocationInFull).not.toHaveBeenCalled()
  })

  it('入参原样转发给 lib，action 层不加工也不补默认值', async () => {
    mockBusiness.receiveItemCompanyShipmentInFull.mockResolvedValue({ id: 'MRK-1', shipmentId: 'GFH-1' })
    const input = { shipmentId: 'GFH-1', docDate: '2026-09-21', remark: '待办区一键收货' }
    await receiveItemCompanyShipmentInFull(input)
    expect(mockBusiness.receiveItemCompanyShipmentInFull).toHaveBeenCalledWith(SESSION, input)
  })
})

/**
 * 待办区行内动作的错误形态。
 *
 * 前端的 `isStaleStateError` 靠 `digest` 判「单据状态已变，关弹窗 + 重取列表」。
 * `withPermission` 的 `rethrowWithDigest` 只给 9 项白名单前缀补 digest ——
 * 补漏了，生产构建下 message 被脱敏，用户只会看到通用兜底文案。
 */
describe('待办区行内动作的错误形态', () => {
  it.each([
    ['INVALID_STATE', '当前单据不能审批回库'],
    ['CONFLICT', '退货库存预留已失效，请刷新后重试'],
    ['NOT_FOUND', '库存单据不存在'],
  ] as const)('lib 抛 %s 时带着 digest 穿到客户端', async (prefix, message) => {
    mockBusiness.approveReturnForRestock.mockRejectedValue(new ApiError(prefix, message))
    await expect(approveReturnForRestock({ returnDocId: 'YTH-1' })).rejects.toMatchObject({
      digest: `${prefix}: ${message}`,
    })
  })

  it('非白名单的系统错误不补 digest，避免把技术细节透给前端', async () => {
    mockBusiness.cancelSupplyChainPurchaseOrder.mockRejectedValue(new TypeError('x.y is not a function'))
    await expect(cancelSupplyChainPurchaseOrder({ purchaseOrderId: 'CGD-1', cancellationReason: '短供' }))
      .rejects.toSatisfy((err: unknown) => (err as { digest?: string }).digest === undefined)
  })
})

/**
 * 待办区「(待办类型, 状态) → 调哪个 action」的派发表。
 *
 * UI 侧按这张表接线；这里把每条的**权限闸**钉死，免得哪天有人顺手把审批类
 * 改成 `withAnyPermission` 放宽（专用 reject 的服务端 required 校验在 lib 层，
 * 拦不住权限口径变化）。
 */
describe('待办区行内动作的权限派发表', () => {
  const RETURN_APPROVE_ACTIONS = ['inventory:supply_chain_approve', 'inventory:market_approve']
  const CANCELLATION_ACTIONS = ['inventory:supply_chain_approve', 'inventory:shipment_cancel_approve']

  it('退货审批 / 驳回走 OR 双审批角色', async () => {
    mockBusiness.approveReturnForRestock.mockResolvedValue({ id: 'MTR-1', returnDocId: 'YTH-1' })
    await approveReturnForRestock({ returnDocId: 'YTH-1', auditRemark: null })
    expect(requireAnyPermission).toHaveBeenCalledWith(SESSION, RETURN_APPROVE_ACTIONS)

    vi.mocked(requireAnyPermission).mockClear()
    mockBusiness.rejectReturnForRestock.mockResolvedValue({ success: true })
    await rejectReturnForRestock({ returnDocId: 'YTH-1', auditRemark: '不同意' })
    expect(requireAnyPermission).toHaveBeenCalledWith(SESSION, RETURN_APPROVE_ACTIONS)
    expect(requirePermission).not.toHaveBeenCalled()
  })

  it('撤回审批 / 驳回要求 AND 两项权限同时由一条角色授权提供', async () => {
    mockBusiness.approveItemCompanyShipmentCancellation.mockResolvedValue({ success: true })
    await approveItemCompanyShipmentCancellation({ shipmentId: 'GFH-1', auditRemark: null })
    expect(vi.mocked(requirePermission).mock.calls.map(([, action]) => action)).toEqual(CANCELLATION_ACTIONS)
    expect(scopeSessionToAllActions).toHaveBeenCalledWith(SESSION, CANCELLATION_ACTIONS)

    vi.mocked(requirePermission).mockClear()
    mockBusiness.rejectItemCompanyShipmentCancellation.mockResolvedValue({ success: true })
    await rejectItemCompanyShipmentCancellation({ shipmentId: 'GFH-1', auditRemark: '不同意撤回' })
    expect(vi.mocked(requirePermission).mock.calls.map(([, action]) => action)).toEqual(CANCELLATION_ACTIONS)
    expect(requireAnyPermission).not.toHaveBeenCalled()
  })

  it('关闭采购订单只闸供应链审批权', async () => {
    mockBusiness.cancelSupplyChainPurchaseOrder.mockResolvedValue({ success: true })
    await cancelSupplyChainPurchaseOrder({ purchaseOrderId: 'CGD-1', cancellationReason: '供应商短供' })
    expect(requirePermission).toHaveBeenCalledTimes(1)
    expect(requirePermission).toHaveBeenCalledWith(SESSION, 'inventory:supply_chain_approve')
    expect(requireAnyPermission).not.toHaveBeenCalled()
  })
})

describe('库存转换仅供应链可做（#343）', () => {
  it('createInventoryConversion 只闸 inventory:supply_chain_operate，不再是 any 版本', async () => {
    mockBusiness.createInventoryConversion.mockResolvedValue({ outboundId: 'ZHC-1', inboundId: 'ZHR-1' })
    await createInventoryConversion({ locationId: 'HQ', sources: [], targets: [] })

    expect(requirePermission).toHaveBeenCalledTimes(1)
    expect(requirePermission).toHaveBeenCalledWith(SESSION, 'inventory:supply_chain_operate')
    // 早先是 withAnyPermission([供应链, 市场, 门店])，任一即可 —— 退回去必红
    expect(requireAnyPermission).not.toHaveBeenCalled()
    expect(scopeSessionToActions).toHaveBeenCalledWith(SESSION, ['inventory:supply_chain_operate'])
  })

  it('只有市场 / 门店权限的会话调用被拒（PERMISSION_DENIED），不进业务函数', async () => {
    vi.mocked(requirePermission).mockImplementation(() => {
      throw new ApiError('PERMISSION_DENIED', '缺少权限')
    })
    await expect(createInventoryConversion({ locationId: 'M1', sources: [], targets: [] }))
      .rejects.toThrow('PERMISSION_DENIED')
    expect(mockBusiness.createInventoryConversion).not.toHaveBeenCalled()
  })
})
