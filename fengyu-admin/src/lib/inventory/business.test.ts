import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  allocateMarketReportSourceLinks,
  approveItemCompanyShipmentCancellation,
  assertSkuAvailableToMarket,
  cancelSupplyChainPurchaseOrder,
  cancelItemCompanyShipment,
  createItemCompanyShipment,
  createItemCompanyReplenishment,
  createMarketStaffPurchase,
  createMarketReplenishment,
  createPurchaseOrderFromItemCompanyReplenishment,
  createPurchaseOrderFromMarketReplenishment,
  createReturnForRestock,
  createSelfPurchasedReceipt,
  createStoreAllocation,
  createStoreReplenishmentRequest,
  createSupplyChainStaffPurchase,
  listMarketEmployeeOptions,
  listSupplyChainEmployeeOptions,
  quoteMarketReplenishmentPrice,
  quoteMarketReplenishmentPrices,
  receiveItemCompanyShipment,
  receiveSupplyChainPurchaseOrder,
  rejectItemCompanyShipmentCancellation,
  requestItemCompanyShipmentCancellation,
} from './business'
import { db } from '@/db'

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: [], scopeStoreIds: [] },
} as never

const NO_PRICE_SESSION = {
  employeeId: 'E-STORE',
  name: '门店库存员',
  phone: '13800000009',
  roles: [{ role: 'inventory_store_operator', scopeId: 'S1', scopeType: '门店', actions: ['inventory:store_operate'], scopeStoreIds: ['S1'], scopeOrgNodeIds: ['S1'] }],
  permissions: { actions: ['inventory:store_operate'], scopeStoreIds: ['S1'] },
} as never

const PRICE_SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场', actions: ['inventory:market_price_view'], scopeStoreIds: [], scopeOrgNodeIds: ['M1'] }],
  permissions: { actions: ['inventory:market_price_view'], scopeStoreIds: [] },
} as never

const SELF_PURCHASE_SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['inventory:self_purchase_receive'], scopeStoreIds: [] },
} as never

const CANCELLATION_REQUEST_SESSION = {
  employeeId: 'E-M1',
  name: '撤回申请人',
  phone: '13800000001',
  roles: [{ role: 'finance', scopeId: 'M1', scopeType: '市场' }],
  permissions: { actions: ['inventory:shipment_cancel_request'], scopeStoreIds: [] },
} as never

const CANCELLATION_APPROVER_SESSION = {
  employeeId: 'E-HQ',
  name: '撤回审批人',
  phone: '13800000002',
  roles: [{ role: 'finance', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['inventory:shipment_cancel_approve'], scopeStoreIds: [] },
} as never

function storeRequestItemRow(fulfilledQuantity = '0') {
  return {
    id: 1,
    doc_id: 'DBH-1',
    lot_id: null,
    sku_id: 'SKU-1',
    sku_name: '测试 SKU',
    spec_name: null,
    supplier: null,
    product_series: null,
    batch_no: '',
    expiry_date: null,
    is_gift: false,
    quantity: '5',
    stock_snapshot: null,
    request_quantity: '5',
    fulfilled_quantity: fulfilledQuantity,
    standard_unit_price: null,
    unit_discount: null,
    actual_unit_price: null,
    amount: null,
    supply_chain_unit_cost: null,
    market_standard_unit_price: null,
    market_unit_discount: null,
    market_actual_unit_price: null,
    store_standard_unit_price: null,
    store_unit_discount: null,
    store_actual_unit_price: null,
    reason: null,
    remark: null,
  }
}

function itemCompanyShipmentRow(input: {
  status: '待收货' | '待审批'
  cancellationRequestReason?: string | null
}) {
  return {
    id: 'GFH-1',
    doc_type: '品项公司发货',
    status: input.status,
    source_org_node_id: 'HQ',
    target_org_node_id: 'M1',
    market_id: 'M1',
    supplier_id: 'SUP-1',
    supplier_name: '供应商',
    cancellation_request_reason: input.cancellationRequestReason ?? null,
    cancellation_requested_by: null,
    cancellation_requested_at: null,
  }
}

function shipmentSourceLotRow() {
  return {
    id: 101,
    location_id: 'HQ',
    sku_id: 'SKU-1',
    sku_name: '测试 SKU',
    spec_name: null,
    supplier: null,
    product_series: null,
    batch_no: 'B-001',
    expiry_date: null,
    is_gift: false,
    quantity_on_hand: '0',
    supply_chain_unit_cost: '10',
    market_standard_unit_price: '100',
    market_unit_discount: '0',
    market_actual_unit_price: '100',
    store_standard_unit_price: '120',
    store_unit_discount: '0',
    store_actual_unit_price: '120',
  }
}

function marketSkuRow(skuId: string, marketPurchasePrice = '100') {
  return {
    sku_id: skuId,
    product_code: `P-${skuId}`,
    product_name: `测试 ${skuId}`,
    spec_name: null,
    supplier: null,
    product_series: null,
    source_type: '供应链',
    owner_market_id: null,
    supply_chain_purchase_price: null,
    market_purchase_price: marketPurchasePrice,
    store_purchase_price: null,
    market_staff_purchase_price: null,
    item_company_purchase_price: null,
  }
}

function promotionRow(input: {
  planId: string
  planNo: string
  skuId: string
  discount: string
  ruleType?: '单品阶梯' | '组合'
  minQuantity?: string | null
  maxQuantity?: string | null
  scopeMarketId?: string | null
}) {
  return {
    plan_id: input.planId,
    plan_no: input.planNo,
    plan_name: input.planNo,
    rule_type: input.ruleType ?? '单品阶梯',
    scope_market_id: input.scopeMarketId ?? 'M1',
    created_at: '2026-08-01T00:00:00.000Z',
    sku_id: input.skuId,
    market_unit_discount: input.discount,
    report_min_quantity: input.minQuantity ?? null,
    report_max_quantity: input.maxQuantity ?? null,
  }
}

function renderSql(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      if (!chunk) return ''
      return Array.isArray(chunk.value) ? chunk.value.join('') : String(chunk)
    })
    .join('')
}

function initializedCutoverExecutor(txExecute: (query: unknown) => Promise<unknown>) {
  return async (query: unknown) => {
    const rendered = renderSql(query)
    if (rendered.includes('inventory_cutover_states')) {
      return rendered.includes('SELECT status') ? [{ status: '已初始化' }] : []
    }
    return txExecute(query)
  }
}

function mockQuoteTransaction(skus: ReturnType<typeof marketSkuRow>[], promotions: unknown[]) {
  const txExecute = vi.fn()
    .mockResolvedValueOnce([{
      location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
    }])
  for (const sku of skus) txExecute.mockResolvedValueOnce([sku])
  txExecute.mockResolvedValueOnce(promotions)
  vi.mocked(db.execute).mockResolvedValue([] as never)
  vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))
  return txExecute
}

describe('inventory business action input guards', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('拒绝没有明细的专用建单入口', async () => {
    await expect(createStoreReplenishmentRequest(SESSION, {
      storeId: 'S1', marketId: 'M1', items: [],
    })).rejects.toThrow('门店报货至少需要一条明细')
    await expect(createMarketReplenishment(SESSION, {
      marketId: 'M1', supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('市场报货至少需要一条明细')
    await expect(createItemCompanyReplenishment(SESSION, {
      supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('品项公司报货需求至少需要一条明细')
    await expect(createPurchaseOrderFromItemCompanyReplenishment(SESSION, {
      companyRequestId: 'ZBH-1', supplierId: 'SUP-1', supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('采购订单至少需要一条明细')
    await expect(createItemCompanyShipment(SESSION, {
      purchaseOrderId: 'CGD-1', sourceOrgNodeId: 'HQ', items: [],
    })).rejects.toThrow('品项公司发货至少需要一条明细')
    await expect(receiveSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'PCG-1', supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('供应链采购入库至少需要一条明细')
    await expect(createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', sourceMarketId: 'M1', items: [],
    })).rejects.toThrow('分院配货至少需要一条明细')
    await expect(createReturnForRestock(SESSION, {
      sourceOrgNodeId: 'S1', targetOrgNodeId: 'M1', items: [],
    })).rejects.toThrow('退货至少需要一条明细')
    await expect(createSupplyChainStaffPurchase(SESSION, {
      locationId: 'HQ', employeeId: 'E-HQ', items: [],
    })).rejects.toThrow('供应链员工购至少需要一条明细')
  })

  it('拒绝空收货、零采购量和空撤回原因', async () => {
    await expect(receiveItemCompanyShipment(SESSION, {
      shipmentId: 'GFH-1', items: [],
    })).rejects.toThrow('收货至少需要一条明细')
    await expect(quoteMarketReplenishmentPrice(SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 0,
    })).rejects.toThrow('采购数量必须大于 0')
    await expect(cancelItemCompanyShipment(SESSION, {
      shipmentId: 'GFH-1', cancellationReason: '',
    })).rejects.toThrow('缺少撤回原因')
    await expect(cancelSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'PCG-1', cancellationReason: '',
    })).rejects.toThrow('缺少关闭原因')
  })

  it('拥有撤回申请权限的用户提交品项公司发货撤回申请只变更状态，不回滚库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([itemCompanyShipmentRow({ status: '待收货' })])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      .mockResolvedValueOnce([{
        ...storeRequestItemRow(), doc_id: 'GFH-1', lot_id: 101, quantity: '5',
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(requestItemCompanyShipmentCancellation(CANCELLATION_REQUEST_SESSION, {
      shipmentId: 'GFH-1', cancellationReason: '物流信息异常',
    })).resolves.toEqual({ success: true })

    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).toContain("SET status = '待审批'")
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
    expect(queries).not.toContain('UPDATE inventory_doc_items purchase_item')
  })

  it('待审批的品项公司发货单不能收货', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([itemCompanyShipmentRow({
        status: '待审批', cancellationRequestReason: '物流信息异常',
      })])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(receiveItemCompanyShipment(CANCELLATION_REQUEST_SESSION, {
      shipmentId: 'GFH-1', items: [{ shipmentItemId: 1, receivedQuantity: 1 }],
    })).rejects.toThrow('当前单据不能收货')

    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
  })

  it('仅有撤回申请权限的用户不能自行审批品项公司发货撤回申请', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([itemCompanyShipmentRow({
        status: '待审批', cancellationRequestReason: '物流信息异常',
      })])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(approveItemCompanyShipmentCancellation(CANCELLATION_REQUEST_SESSION, {
      shipmentId: 'GFH-1', auditRemark: '自行审批',
    })).rejects.toThrow('缺少品项发货撤回审批权限')

    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
  })

  it('拥有撤回审批权限的用户审批后恢复总部库存并回退采购订单履约数量', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([itemCompanyShipmentRow({
        status: '待审批', cancellationRequestReason: '物流信息异常',
      })])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([{
        ...storeRequestItemRow(), doc_id: 'GFH-1', lot_id: 101, quantity: '5',
      }])
      .mockResolvedValueOnce([shipmentSourceLotRow()])
      .mockResolvedValue([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(approveItemCompanyShipmentCancellation(CANCELLATION_APPROVER_SESSION, {
      shipmentId: 'GFH-1', auditRemark: '核验通过',
    })).resolves.toEqual({ success: true })

    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).not.toContain('UPDATE inventory_stock_lots')
    expect(queries).toContain('INSERT INTO inventory_movements')
    expect(queries).toContain('UPDATE inventory_doc_items purchase_item')
    expect(queries).toContain("SET status = '已取消'")
  })

  it('拥有撤回审批权限的用户驳回后恢复待收货，不产生库存回滚', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([itemCompanyShipmentRow({
        status: '待审批', cancellationRequestReason: '物流信息异常',
      })])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValue([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(rejectItemCompanyShipmentCancellation(CANCELLATION_APPROVER_SESSION, {
      shipmentId: 'GFH-1', auditRemark: '发货信息无误',
    })).resolves.toEqual({ success: true })

    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).toContain("SET status = '待收货'")
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
  })

  it('无价格查看权限时拒绝门店配货折扣且不访问数据库', async () => {
    vi.clearAllMocks()

    await expect(createStoreAllocation(NO_PRICE_SESSION, {
      storeRequestId: 'DBH-1',
      sourceMarketId: 'M1',
      items: [{ requestItemId: 1, lotId: 1, quantity: 1, storeUnitDiscount: 0.01 }],
    })).rejects.toThrow('PERMISSION_DENIED: 无权设置门店单价优惠')

    expect(db.execute).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('福利报价要求价格查看权限', async () => {
    await expect(quoteMarketReplenishmentPrice(NO_PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 1,
    })).rejects.toThrow('无权查看市场报货价格')
  })

  it('市场自采和转让店 SKU 仅能在归属市场使用', () => {
    expect(() => assertSkuAvailableToMarket({
      sourceType: '供应链', ownerMarketId: null, productName: '供应链产品',
    }, 'M2')).not.toThrow()
    for (const sourceType of ['市场自采', '转让店'] as const) {
      expect(() => assertSkuAvailableToMarket({
        sourceType, ownerMarketId: 'M1', productName: '市场专属产品',
      }, 'M2')).toThrow('仅可在归属市场使用')
    }
  })

  it('市场报货仅占用实际采购覆盖的门店报货数量', () => {
    expect(allocateMarketReportSourceLinks([
      { id: 2, quantity: 4 },
      { id: 1, quantity: 5 },
    ], 6)).toEqual([
      { sourceItemId: 1, quantity: 5 },
      { sourceItemId: 2, quantity: 1 },
    ])
    expect(allocateMarketReportSourceLinks([
      { id: 1, quantity: 5 },
      { id: 2, quantity: 4 },
    ], 12)).toEqual([
      { sourceItemId: 1, quantity: 5 },
      { sourceItemId: 2, quantity: 4 },
    ])
  })

  it('无门店员工按组织树追溯市场并拒绝跨市场员工购', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      .mockResolvedValueOnce([{
        employee_id: 'E002', name: '市场二员工', store_id: null, org_node_id: 'D2', store_market_id: null,
      }])
      .mockResolvedValueOnce([{ id: 'M2' }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createMarketStaffPurchase(SESSION, {
      marketId: 'M1', employeeId: 'E002', items: [{ lotId: 1, quantity: 1 }],
    })).rejects.toThrow('员工不属于当前市场')
    expect(txExecute).toHaveBeenCalledTimes(3)
  })

  it('员工购候选项只返回所选市场组织树中的在职员工', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }] as never)
      .mockResolvedValueOnce([
        { employee_id: 'E001', name: '员工甲' },
        { employee_id: 'E002', name: null },
      ] as never)

    await expect(listMarketEmployeeOptions(SESSION, 'M1')).resolves.toEqual([
      { employeeId: 'E001', name: '员工甲' },
      { employeeId: 'E002', name: 'E002' },
    ])
    expect(renderSql(vi.mocked(db.execute).mock.calls[3][0])).toContain('employee.is_resigned = false')
  })

  it('供应链员工购候选项排除市场链路和门店员工', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }] as never)
      .mockResolvedValueOnce([{ employee_id: 'E-HQ', name: '总部员工' }] as never)

    await expect(listSupplyChainEmployeeOptions(SESSION, 'HQ')).resolves.toEqual([
      { employeeId: 'E-HQ', name: '总部员工' },
    ])
    const query = renderSql(vi.mocked(db.execute).mock.calls[3][0])
    expect(query).toContain('employee.store_id IS NULL')
    expect(query).toContain("type IN ('市场', '门店')")
  })

  it('自采入库必须引用有效且启用的供应商实体', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      .mockResolvedValueOnce([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createSelfPurchasedReceipt(SELF_PURCHASE_SESSION, {
      marketId: 'M1',
      supplierId: 'SUP-NOT-FOUND',
      items: [{ skuId: 'SELF-SKU', quantity: 1 }],
    })).rejects.toThrow('供应商不存在或已停用')
    expect(txExecute).toHaveBeenCalledTimes(2)
  })

  it('已由市场库存履约的门店报货不能再次进入市场报货', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([storeRequestItemRow('5')])
      .mockResolvedValueOnce([{
        id: 'DBH-1', doc_type: '门店报货', status: '已完成',
        source_org_node_id: 'S1', target_org_node_id: 'M1', market_id: 'M1',
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([{ quantity: '0' }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createMarketReplenishment(SESSION, {
      marketId: 'M1',
      supplyChainLocationId: 'HQ',
      items: [{ skuId: 'SKU-1', sourceRequestItemIds: [1], purchaseQuantity: 5 }],
    })).rejects.toThrow('已全部履约或已汇总')
  })

  it('品项公司报货需求拒绝非供应链 SKU', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([{
        ...marketSkuRow('SELF-SKU'),
        source_type: '市场自采',
        owner_market_id: 'M1',
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createItemCompanyReplenishment(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ skuId: 'SELF-SKU', quantity: 1 }],
    })).rejects.toThrow('品项公司报货只能选择供应链 SKU')
  })

  it('品项公司报货需求要求已维护供应链采购价', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([{
        ...marketSkuRow('SKU-NO-COST'),
        supply_chain_purchase_price: null,
        item_company_purchase_price: null,
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createItemCompanyReplenishment(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ skuId: 'SKU-NO-COST', quantity: 1 }],
    })).rejects.toThrow('未设置供应链采购价')
  })

  it('品项公司采购订单只接受已完成的需求单', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([{
      id: 'ZBH-1', doc_type: '品项公司报货需求', status: '草稿',
      source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
      supplier_id: null, supplier_name: null,
    }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrderFromItemCompanyReplenishment(SESSION, {
      companyRequestId: 'ZBH-1', supplierId: 'SUP-1', supplyChainLocationId: 'HQ',
      items: [{ companyRequestItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购订单必须引用有效的品项公司报货需求单')
  })

  it('品项公司报货需求同节点归一化形态（source=target=总部）可通过供应链主体校验', async () => {
    // insertDocHeader 对同节点单据类型做 source=target 归一化，落库 source 不是 null；
    // 第二个响应留给 locationForUpdate 并返回空，用于证明已越过血缘守卫。
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '已完成',
        source_org_node_id: 'HQ', target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrderFromItemCompanyReplenishment(SESSION, {
      companyRequestId: 'ZBH-1', supplierId: 'SUP-1', supplyChainLocationId: 'HQ',
      items: [{ companyRequestItemId: 1, quantity: 1 }],
    })).rejects.toThrow('库存主体不存在或已停用')
  })

  it('品项公司报货需求 source 指向非总部主体仍被血缘守卫拒绝', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([{
      id: 'ZBH-1', doc_type: '品项公司报货需求', status: '已完成',
      source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: null,
      supplier_id: null, supplier_name: null,
    }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrderFromItemCompanyReplenishment(SESSION, {
      companyRequestId: 'ZBH-1', supplierId: 'SUP-1', supplyChainLocationId: 'HQ',
      items: [{ companyRequestItemId: 1, quantity: 1 }],
    })).rejects.toThrow('品项公司报货需求的供应链主体不一致')
  })

  it('关闭部分收货的供应链采购订单会释放未收需求数量', async () => {
    const purchaseOrderItem = {
      ...storeRequestItemRow(),
      doc_id: 'PCG-1',
      supply_chain_unit_cost: '100',
      quantity: '10',
      fulfilled_quantity: '8',
    }
    const requestItem = {
      ...storeRequestItemRow(),
      id: 10,
      doc_id: 'ZBH-1',
      supply_chain_unit_cost: '100',
      quantity: '10',
      fulfilled_quantity: '10',
    }
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        id: 'PCG-1', doc_type: '供应链采购订单', status: '待收货',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: 'SUP-1', supplier_name: '供应商',
      }])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      .mockResolvedValueOnce([{ from_doc_id: 'ZBH-1' }])
      .mockResolvedValueOnce([{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '已完成',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([purchaseOrderItem])
      .mockResolvedValueOnce([{ from_item_id: 10, to_item_id: 1, quantity: '10' }])
      .mockResolvedValueOnce([{ quantity: '8' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([requestItem])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(cancelSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'PCG-1', cancellationReason: '供应商短供',
    })).resolves.toEqual({ success: true })
  })

  it('市场报货不能转换为供应链采购订单', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([{
      id: 'MBH-1', doc_type: '市场报货', status: '已完成',
      source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
      supplier_id: null, supplier_name: null,
    }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrderFromItemCompanyReplenishment(SESSION, {
      companyRequestId: 'MBH-1', supplierId: 'SUP-1', supplyChainLocationId: 'HQ',
      items: [{ companyRequestItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购订单必须引用有效的品项公司报货需求单')
  })

  it('供应链采购订单不能进入品项公司发货，市场采购订单不能直接供应链入库', async () => {
    const shipmentExecutor = vi.fn().mockResolvedValueOnce([{
      id: 'PCG-1', doc_type: '供应链采购订单', status: '待收货',
      source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
      supplier_id: 'SUP-1', supplier_name: '供应商',
    }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(shipmentExecutor),
    } as never))
    await expect(createItemCompanyShipment(SESSION, {
      purchaseOrderId: 'PCG-1', sourceOrgNodeId: 'HQ',
      items: [{ purchaseOrderItemId: 1, lotId: 1, quantity: 1 }],
    })).rejects.toThrow('品项公司发货必须引用有效采购订单')

    const receiptExecutor = vi.fn().mockResolvedValueOnce([{
      id: 'CGD-1', doc_type: '采购订单', status: '已完成',
      source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
      supplier_id: 'SUP-1', supplier_name: '供应商',
    }])
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(receiptExecutor),
    } as never))
    await expect(receiveSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'CGD-1', supplyChainLocationId: 'HQ',
      items: [{ purchaseOrderItemId: 1, quantity: 1 }],
    })).rejects.toThrow('供应链采购入库必须引用待收货的供应链采购订单')
  })

  it('福利报价始终以 SKU 市场进货价为基础，不接受方案中的基础价快照', async () => {
    mockQuoteTransaction([marketSkuRow('SKU-1')], [promotionRow({
      planId: 'PROMO-1', planNo: 'PROMO-1', skuId: 'SKU-1', discount: '10',
    })])

    await expect(quoteMarketReplenishmentPrice(PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 1,
    })).resolves.toMatchObject({
      marketStandardUnitPrice: 100,
      marketUnitDiscount: 10,
      marketActualUnitPrice: 90,
    })
  })

  it('组合福利缺少任一产品时不优惠', async () => {
    mockQuoteTransaction([marketSkuRow('SKU-1')], [
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-1', discount: '10',
        ruleType: '组合', minQuantity: '2',
      }),
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-2', discount: '20',
        ruleType: '组合', minQuantity: '1',
      }),
    ])

    await expect(quoteMarketReplenishmentPrice(PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 2,
      basketItems: [{ skuId: 'SKU-1', quantity: 2 }],
    })).resolves.toMatchObject({
      marketUnitDiscount: 0,
      marketActualUnitPrice: 100,
      promotionPlanId: null,
    })
  })

  it('组合内所有产品和数量都命中时对方案产品应用优惠', async () => {
    mockQuoteTransaction([
      marketSkuRow('SKU-1'),
      marketSkuRow('SKU-2', '200'),
    ], [
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-1', discount: '10',
        ruleType: '组合', minQuantity: '2',
      }),
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-2', discount: '20',
        ruleType: '组合', minQuantity: '1',
      }),
    ])

    await expect(quoteMarketReplenishmentPrice(PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 2,
      basketItems: [{ skuId: 'SKU-1', quantity: 2 }, { skuId: 'SKU-2', quantity: 1 }],
    })).resolves.toMatchObject({
      marketUnitDiscount: 10,
      marketActualUnitPrice: 90,
      promotionPlanNo: 'COMBO-1',
      promotionRuleType: '组合',
    })
  })

  it('组合和单品阶梯同时命中时组合福利优先', async () => {
    mockQuoteTransaction([
      marketSkuRow('SKU-1'),
      marketSkuRow('SKU-2'),
    ], [
      promotionRow({
        planId: 'SINGLE-1', planNo: 'SINGLE-1', skuId: 'SKU-1', discount: '30',
        ruleType: '单品阶梯', minQuantity: '2',
      }),
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-1', discount: '10',
        ruleType: '组合', minQuantity: '2',
      }),
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-2', discount: '5',
        ruleType: '组合', minQuantity: '1',
      }),
    ])

    await expect(quoteMarketReplenishmentPrice(PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 2,
      basketItems: [{ skuId: 'SKU-1', quantity: 2 }, { skuId: 'SKU-2', quantity: 1 }],
    })).resolves.toMatchObject({
      marketUnitDiscount: 10,
      promotionPlanNo: 'COMBO-1',
      promotionRuleType: '组合',
    })
  })

  it('批量报价按业务优先级推荐并允许改选合规单品方案', async () => {
    mockQuoteTransaction([marketSkuRow('SKU-1')], [
      promotionRow({
        planId: 'TIER-HIGH', planNo: 'TIER-HIGH', skuId: 'SKU-1', discount: '5',
        minQuantity: '4',
      }),
      promotionRow({
        planId: 'TIER-LOW', planNo: 'TIER-LOW', skuId: 'SKU-1', discount: '20',
        minQuantity: '1',
      }),
    ])

    await expect(quoteMarketReplenishmentPrices(PRICE_SESSION, {
      marketId: 'M1',
      items: [{ skuId: 'SKU-1', quantity: 5 }],
      selections: [{ skuId: 'SKU-1', promotionPlanId: 'TIER-LOW' }],
    })).resolves.toMatchObject({
      totalStandardAmount: 500,
      totalDiscountAmount: 100,
      totalActualAmount: 400,
      items: [{
        recommendedPromotionPlanId: 'TIER-HIGH',
        promotionPlanId: 'TIER-LOW',
        selectionMode: '人工选择',
      }],
    })
  })

  it('人工选择组合福利时必须覆盖全部组成商品', async () => {
    mockQuoteTransaction([
      marketSkuRow('SKU-1'),
      marketSkuRow('SKU-2'),
    ], [
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-1', discount: '10',
        ruleType: '组合', minQuantity: '1',
      }),
      promotionRow({
        planId: 'COMBO-1', planNo: 'COMBO-1', skuId: 'SKU-2', discount: '10',
        ruleType: '组合', minQuantity: '1',
      }),
      promotionRow({
        planId: 'SINGLE-1', planNo: 'SINGLE-1', skuId: 'SKU-1', discount: '5',
        minQuantity: '1', scopeMarketId: null,
      }),
    ])

    await expect(quoteMarketReplenishmentPrices(PRICE_SESSION, {
      marketId: 'M1',
      items: [{ skuId: 'SKU-1', quantity: 1 }, { skuId: 'SKU-2', quantity: 1 }],
      selections: [{ skuId: 'SKU-1', promotionPlanId: 'SINGLE-1' }],
    })).rejects.toThrow('组合福利必须整组选择')
  })
})

/**
 * 采购订单位于流程图供应链泳道（市场报货单汇总 → 采购订单 → 品项公司发货），
 * 由供应链库存员按总部 scope 创建；市场 scope 不能替总部下采购订单。
 * 回归背景：曾误按市场 scope 校验（assertLocationWritable(session, market)），
 * 导致供应链库存员（总部 scope）被 PERMISSION_DENIED 卡死，三级主链路中断。
 */
describe('createPurchaseOrderFromMarketReplenishment 供应链 scope 归属', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const SUPPLY_CHAIN_OPERATOR_SESSION = {
    employeeId: 'E-SC',
    name: '供应链库存员',
    phone: '13800000010',
    roles: [{
      role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
      actions: ['inventory:supply_chain_operate'], scopeStoreIds: [], scopeOrgNodeIds: ['HQ'],
    }],
    permissions: { actions: ['inventory:supply_chain_operate'], scopeStoreIds: [] },
  } as never

  const MARKET_ONLY_SESSION = {
    employeeId: 'E-M1',
    name: '市场库存财务',
    phone: '13800000011',
    roles: [{
      role: 'inventory_market_finance', scopeId: 'M1', scopeType: '市场',
      actions: ['inventory:market_operate'], scopeStoreIds: ['S1'], scopeOrgNodeIds: ['M1', 'S1'],
    }],
    permissions: { actions: ['inventory:market_operate'], scopeStoreIds: ['S1'] },
  } as never

  function mockPurchaseOrderTransaction() {
    const txExecute = vi.fn()
      // docForUpdate(市场报货单)
      .mockResolvedValueOnce([{
        id: 'MBH-1', doc_type: '市场报货', status: '已完成',
        source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
        supplier_id: null, supplier_name: null,
        cancellation_request_reason: null, cancellation_requested_by: null,
        cancellation_requested_at: null,
      }])
      // locationForUpdate(市场)
      .mockResolvedValueOnce([{
        location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      // locationForUpdate(供应链总部)
      .mockResolvedValueOnce([{
        location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      // ensureSupplier → 空（哨兵：走到供应商校验说明 scope 已放行）
      .mockResolvedValueOnce([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))
    return txExecute
  }

  it('供应链库存员（总部 scope）创建采购订单不被市场 scope 拦截', async () => {
    mockPurchaseOrderTransaction()
    await expect(createPurchaseOrderFromMarketReplenishment(SUPPLY_CHAIN_OPERATOR_SESSION, {
      marketReportId: 'MBH-1', supplierId: 'SUP-404', supplyChainLocationId: 'HQ',
      items: [{ marketReportItemId: 1, quantity: 1 }],
    })).rejects.toThrow('供应商不存在或已停用')
  })

  it('仅有市场 scope 的会话不能替总部创建采购订单', async () => {
    mockPurchaseOrderTransaction()
    await expect(createPurchaseOrderFromMarketReplenishment(MARKET_ONLY_SESSION, {
      marketReportId: 'MBH-1', supplierId: 'SUP-404', supplyChainLocationId: 'HQ',
      items: [{ marketReportItemId: 1, quantity: 1 }],
    })).rejects.toThrow('PERMISSION_DENIED')
  })
})
