import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

/**
 * syncLocations 漂移探测短路补位：位置化 db.execute mock 的用例在链头统一
 * 排入一条「无漂移」探测响应（跳过两条全表 UPSERT），后续 mock 序号即为
 * 业务查询本身。改动 syncLocations 的探测/自愈次序时只需调整此处。
 */
function mockSyncLocationsShortCircuit() {
  return vi.mocked(db.execute).mockResolvedValueOnce([{ drifted: false }] as never)
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
    mockSyncLocationsShortCircuit()
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
    // 漂移探测短路：无漂移时不再发起两条全表 UPSERT（probe + 主体查询 + 员工查询 = 3 条）。
    expect(db.execute).toHaveBeenCalledTimes(3)
    expect(renderSql(vi.mocked(db.execute).mock.calls[0][0])).toContain('AS drifted')
    expect(renderSql(vi.mocked(db.execute).mock.calls[2][0])).toContain('employee.is_resigned = false')
  })

  it('探测到漂移时照常执行两条全表 UPSERT 自愈', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([{ drifted: true }] as never)
      .mockResolvedValue([] as never)

    await listMarketEmployeeOptions(SESSION, 'M1').catch(() => {})

    const queries = vi.mocked(db.execute).mock.calls.map(([query]) => renderSql(query))
    expect(queries.filter((query) => query.includes('INSERT INTO inventory_locations'))).toHaveLength(2)
  })

  it('供应链员工购候选项排除市场链路和门店员工', async () => {
    mockSyncLocationsShortCircuit()
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }] as never)
      .mockResolvedValueOnce([{ employee_id: 'E-HQ', name: '总部员工' }] as never)

    await expect(listSupplyChainEmployeeOptions(SESSION, 'HQ')).resolves.toEqual([
      { employeeId: 'E-HQ', name: '总部员工' },
    ])
    const query = renderSql(vi.mocked(db.execute).mock.calls[2][0])
    expect(query).toContain('employee.is_resigned = false')
    expect(query).toContain('employee.store_id IS NULL')
    expect(query).toContain("type IN ('市场', '门店')")
      // #130：递归项里 JOIN 不起别名，起了别名就必须全程用别名；混用会让 PG 报
    // invalid reference to FROM-clause entry。注意这仍是**字符串比对**，SQL 没有真的送进 PG ——
    // 真库回归由 tests/e2e-inventory-ui/inv-07 提供（见 PR 说明）
    expect(query).toContain('JOIN descendants ON child.parent_id = descendants.id')
    expect(query).toContain('JOIN ancestors ON ancestors.parent_id = node.id')
  })

  it('市场员工购候选项的递归 CTE 不再混用别名与原名（#130 回归）', async () => {
    mockSyncLocationsShortCircuit()
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }] as never)
      .mockResolvedValueOnce([] as never)

    await listMarketEmployeeOptions(SESSION, 'M1')

    const query = renderSql(vi.mocked(db.execute).mock.calls[2][0])
    expect(query).toContain('JOIN descendants ON child.parent_id = descendants.id')
    // 修复前是 `JOIN descendants parent ON …` 却仍引用 descendants.path
    expect(query).not.toMatch(/JOIN\s+descendants\s+parent\s+ON/)
  })

  it('说明.md §11.1：供应链员工购拒绝非总部直属或离职员工，且校验三要素齐全', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      // employeeForSupplyChain：员工挂在市场链路 / 有门店 / 已离职时 CTE 均查不到行。
      .mockResolvedValueOnce([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createSupplyChainStaffPurchase(SESSION, {
      locationId: 'HQ', employeeId: 'E-MARKET', items: [{ lotId: 1, quantity: 1 }],
    })).rejects.toThrow('员工不属于当前供应链总部或已经离职')

    const employeeQuery = renderSql(txExecute.mock.calls[1][0])
    // 三要素缺一即越权：在职 + 无门店归属 + 祖先链不经过市场/门店（总部直属）。
    expect(employeeQuery).toContain('employee.is_resigned = false')
    expect(employeeQuery).toContain('employee.store_id IS NULL')
    expect(employeeQuery).toContain("type IN ('市场', '门店')")
    expect(employeeQuery).toContain('WITH RECURSIVE descendants')
    // 校验失败必须发生在任何库存扣减之前。
    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
  })

  it('说明.md §11.1：供应链员工购出库主体必须是总部库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createSupplyChainStaffPurchase(SESSION, {
      locationId: 'M1', employeeId: 'E-HQ', items: [{ lotId: 1, quantity: 1 }],
    })).rejects.toThrow('供应链员工购出库主体必须是总部库存主体')
  })

  it('说明.md §11.1：无总部权限的门店会话不能从总部库存做供应链员工购', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createSupplyChainStaffPurchase(NO_PRICE_SESSION, {
      locationId: 'HQ', employeeId: 'E-HQ', items: [{ lotId: 1, quantity: 1 }],
    })).rejects.toThrow('无权操作该库存主体')
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

/**
 * F3 守护：business.ts syncLocations 与 engine.ts syncInventoryLocations 是同一
 * 漂移探测的两份副本（禁跨端/跨文件共享抽取，与 staff 副本同策略）。任何一份改探测
 * 条件（少列/改列/改语义）必须同步另一份，否则一份认为无漂移跳过自愈、另一份反复
 * 全表 UPSERT，主体口径分叉。staff 端另有 cross-end-inventory-snapshot.test.js 守护。
 */
describe('syncLocations 漂移探测与 engine.ts 字面一致（副本守护）', () => {
  const PROBE_RE = /SELECT EXISTS \([\s\S]*?\) AS drifted/

  it('探测 SQL 片段逐字一致', () => {
    const businessSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/business.ts'), 'utf8')
    const engineSrc = readFileSync(resolve(process.cwd(), 'src/lib/inventory/engine.ts'), 'utf8')
    const businessProbe = businessSrc.match(PROBE_RE)?.[0]
    const engineProbe = engineSrc.match(PROBE_RE)?.[0]
    expect(businessProbe, 'business.ts 缺少漂移探测片段').toBeTruthy()
    expect(engineProbe, 'engine.ts 缺少漂移探测片段').toBeTruthy()
    expect(businessProbe).toBe(engineProbe)
  })

  it('两份副本均保留保守短路语义（仅显式 false 才跳过）与两条 UPSERT 自愈路径', () => {
    for (const file of ['src/lib/inventory/business.ts', 'src/lib/inventory/engine.ts']) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(src, `${file} 短路语义漂移`).toMatch(/drifted === false\) return/)
      const upserts = src.match(/INSERT INTO inventory_locations[\s\S]*?ON CONFLICT \(location_id\) DO UPDATE/g)
      expect(upserts?.length ?? 0, `${file} UPSERT 自愈路径缺失`).toBeGreaterThanOrEqual(2)
    }
  })
})

/**
 * #130 全仓守护：递归 CTE 起了别名就**不许再用原名**引用。
 *
 * `JOIN descendants parent ON …` 之后继续写 `descendants.path`，PostgreSQL 直接报
 *   ERROR: invalid reference to FROM-clause entry for table "descendants"
 *   HINT:  Perhaps you meant to reference the table alias "parent".
 * 而 business.ts 的单测全部 mock 掉 db.execute，SQL 永远不会真的送进 PG ——
 * 于是这 5 处错误潜伏到了 UI 端到端测试才暴露（市场员工购 / 供应链员工购整个功能不可用）。
 *
 * 不变量选的是「别名与原名不得混用」而不是「不许起别名」：后者过严，会把
 * `LEFT JOIN market_descendants d ON d.market_id = m.id`（staffApi/routes/mgmt-dashboard.js）
 * 这类完全合法的写法判违规，也堵死 CTE 自连接这种只能靠别名的场景 ——
 * 一条会对正确代码报红的规则，最后只会被人从清单里删掉。
 *
 * 文件清单**自动发现**，不硬编码：新写一个含递归 CTE 的文件会自动纳入，
 * 不会因为没人记得加清单而静默逃逸（本 bug 的诱因恰恰是「新写的 SQL 第一次没跑过 PG」）。
 */
describe('递归 CTE 的别名与原名不得混用（#130）', () => {
  const SCAN_ROOTS: Array<{ label: string; dir: string; exts: string[] }> = [
    { label: 'admin', dir: resolve(process.cwd(), 'src'), exts: ['.ts'] },
    // 云函数各端保留独立副本（CLAUDE.md 明令禁止抽 shared），一致性只能靠测试兜
    { label: 'staffApi', dir: resolve(process.cwd(), '../fengyu-staff/cloudfunctions/staffApi'), exts: ['.js'] },
    { label: 'clientApi', dir: resolve(process.cwd(), '../fengyu-client/cloudfunctions/clientApi'), exts: ['.js'] },
  ]

  /** 递归列目录下的源码文件，跳过 node_modules / 测试 / 构建产物 */
  function listSourceFiles(dir: string, exts: string[]): string[] {
    if (!existsSync(dir)) return []
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '__tests__', 'dist', '.next', 'miniprogram_npm'].includes(entry.name)) continue
        out.push(...listSourceFiles(full, exts))
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue
        out.push(full)
      }
    }
    return out
  }

  /**
   * 取出每个 CTE 的**定义体**（`name [(cols)] AS ( … )` 括号内的文本）。
   *
   * 必须按块判定而不是整文件 grep：同一个 CTE 在递归项里被不带别名地自引用、
   * 在外层查询里被 `LEFT JOIN cte d` 带别名引用，是两个不同的 range-table entry，
   * **两者都合法**（staffApi/routes/mgmt-dashboard.js 就是这样写的）。
   * 整文件判定会把它误报成违规。
   */
  function cteBlocks(src: string): Array<{ name: string; body: string }> {
    const blocks: Array<{ name: string; body: string }> = []
    // `WITH [RECURSIVE] name [(cols)] AS (` 与并列的 `), name [(cols)] AS (` 两种写法都要认；
    // 列清单可有可无（`WITH RECURSIVE scoped AS (` 是仓里实际存在的风格）。
    const head = /(?:\bWITH\s+(?:RECURSIVE\s+)?|[),]\s*)([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s*\(/gi
    for (const m of src.matchAll(head)) {
      const name = m[1]
      let depth = 1
      let i = m.index! + m[0].length
      for (; i < src.length && depth > 0; i += 1) {
        if (src[i] === '(') depth += 1
        else if (src[i] === ')') depth -= 1
      }
      blocks.push({ name, body: src.slice(m.index! + m[0].length, i - 1) })
    }
    return blocks
  }

  // JOIN / FROM 后给 CTE 起别名（`x alias` 与 `x AS alias` 都算）。
  // 排除 SQL 关键字，否则 `FROM descendants WHERE` 里的 WHERE 会被当成别名。
  const SQL_KEYWORDS = new Set([
    'ON', 'AS', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'UNION', 'JOIN', 'LEFT', 'RIGHT',
    'INNER', 'OUTER', 'CROSS', 'FULL', 'USING', 'HAVING', 'WINDOW', 'OFFSET', 'FETCH', 'RETURNING',
  ])
  const aliasRe = (name: string) =>
    new RegExp(`\\b(?:JOIN|FROM)\\s+${name}\\s+(?:AS\\s+)?([A-Za-z_]\\w*)`, 'gi')

  function violations(src: string): string[] {
    const hits: string[] = []
    for (const { name, body } of cteBlocks(src)) {
      const aliases = [...body.matchAll(aliasRe(name))]
        .map((m) => m[1])
        .filter((alias) => !SQL_KEYWORDS.has(alias.toUpperCase()))
      if (aliases.length === 0) continue
      // 在同一个 CTE 体里既起了别名、又用原名当限定符 —— 这就是 #130
      if (new RegExp(`\\b${name}\\s*\\.`).test(body)) {
        hits.push(`${name}（别名 ${[...new Set(aliases)].join('/')}，却仍出现 ${name}.）`)
      }
    }
    return hits
  }

  it('全仓（admin + 云函数）无一处混用递归 CTE 的别名与原名', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root.dir, root.exts)) {
        const src = readFileSync(file, 'utf8')
        if (!/\bWITH\s+RECURSIVE\b/i.test(src)) continue
        scanned += 1
        for (const hit of violations(src)) offenders.push(`${root.label}:${file.split('/').slice(-2).join('/')}: ${hit}`)
      }
    }
    // 扫到 0 个文件 = 规则空跑，必须红，不能伪装成「没有违规」
    expect(scanned, '一个含 WITH RECURSIVE 的文件都没扫到，守护形同虚设').toBeGreaterThanOrEqual(4)
    expect(offenders, 'CTE 起了别名就必须全程用别名，不能再用原名当限定符').toEqual([])
  })

  // 元测试：必须复用上面那个 violations()，不能手抄一份正则 —— 手抄的那份改坏了也照样绿，
  // 正是本文件「syncLocations 副本守护」明令禁止的模式。
  it('守护规则本身有效：认得出各种等价的错误写法，也不冤枉合法写法', () => {
    // 违规形态：**递归项内部**既给 CTE 起了别名、又用原名当限定符
    const bad = [
      // 就是 #130 的原样
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id WHERE NOT child.id = ANY(descendants.path))',
      // AS 形式的别名 —— 等价的错误，旧规则对它完全失明
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants AS parent ON child.parent_id = parent.id)',
      // 无列清单的 CTE 命名风格 —— 旧规则连名字都提取不到
      'WITH RECURSIVE scoped AS (SELECT 1 UNION ALL SELECT scoped.id FROM x JOIN scoped s ON s.id = x.id)',
      // 逗号连接同样能触发
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, descendants.path FROM descendants parent, org_nodes child)',
      // 小写
      'with recursive descendants(id, path) as (select id, array[id] from t union all select child.id, descendants.path || child.id from org_nodes child join descendants parent on child.parent_id = parent.id)',
      // 并列的第二个 CTE（`), name AS (` 形式）同样要被扫到
      'WITH RECURSIVE a(id) AS (SELECT 1), employee_ancestors(id, path) AS (SELECT 1 UNION ALL SELECT node.id, employee_ancestors.path FROM org_nodes node JOIN employee_ancestors ancestor ON ancestor.parent_id = node.id)',
    ]
    for (const sql of bad) expect(violations(sql), `漏报：${sql.slice(0, 70)}…`).not.toEqual([])

    const good = [
      // 修复后的写法：不起别名，全程用原名
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants ON child.parent_id = descendants.id)',
      // 起了别名就全程用别名 —— 同样合法，不该报
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, parent.path || child.id FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id)',
      // 递归项内不带别名自引用 + **外层查询**带别名引用：两个不同的 range-table entry，都合法。
      // staffApi/routes/mgmt-dashboard.js 就是这样写的，整文件 grep 会误报成违规。
      'WITH RECURSIVE market_descendants(market_id, node_id, path) AS (SELECT 1 UNION ALL SELECT market_descendants.market_id, child.id FROM org_nodes child JOIN market_descendants ON child.parent_id = market_descendants.node_id) SELECT * FROM markets m LEFT JOIN market_descendants d ON d.market_id = m.id',
    ]
    for (const sql of good) expect(violations(sql), `误报：${sql.slice(0, 70)}…`).toEqual([])
  })
})
