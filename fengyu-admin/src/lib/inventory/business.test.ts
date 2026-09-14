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
    // invalid reference to FROM-clause entry。注意这仍是字符串比对，SQL 没有真的送进 PG ——
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
 * #130 全仓守护：CTE 起了别名就**不许再用原名**引用。
 *
 * `JOIN descendants parent ON …` 之后继续写 `descendants.path`，PostgreSQL 直接报
 *   ERROR: invalid reference to FROM-clause entry for table "descendants"
 *   HINT:  Perhaps you meant to reference the table alias "parent".
 * 而 business.ts 的单测全部 mock 掉 db.execute，SQL 永远不会真的送进 PG ——
 * 于是这 5 处错误潜伏到了 UI 端到端测试才暴露（市场员工购 / 供应链员工购整个功能不可用）。
 *
 * 三个设计取舍，都是评审逼出来的：
 * 1. 不变量是「别名与原名不得混用」，不是「不许起别名」。后者过严，会把
 *    `LEFT JOIN market_descendants d ON d.market_id = m.id`（staffApi/routes/mgmt-dashboard.js）
 *    这类合法写法判违规，也堵死 CTE 自连接 —— 一条会对正确代码报红的规则，最后只会被人删掉。
 * 2. 按 CTE **定义体**判定，外层尾查询单独判。同一个 CTE 在递归项里裸自引用、在外层
 *    `LEFT JOIN cte d` 带别名引用，是两个不同的 range-table entry，两者都合法；
 *    整文件 grep 会把它误报成违规（实测 mgmt-dashboard 会中招）。
 * 3. 不限于 `WITH RECURSIVE`。非递归 CTE 犯同样的错，PG 报的是同一个错误。
 *
 * ⚠️ 这仍是**词法级**静态检查，不是 SQL parser。已知边界：
 * - 挡不住写错列名、CTE 列清单与 SELECT 列数不符等其它语法错
 * - `AS "parent"` 这种双引号别名认不出（双引号内容被当字面量抹掉了 —— 这是为了让
 *   .ts/.js 里字符串中的括号不至于截断 CTE 体；仓内无此写法）
 * 这些只能靠真库执行来兜 —— 本 issue 的真库回归由 `tests/e2e-inventory-ui/inv-07` 提供（PR #144）。
 */
describe('CTE 的别名与原名不得混用（#130）', () => {
  const repoRoot = resolve(process.cwd(), '..')
  const SCAN_ROOTS: Array<{ label: string; dir: string; exts: string[]; expectCte: boolean }> = [
    { label: 'admin', dir: resolve(process.cwd(), 'src'), exts: ['.ts', '.tsx'], expectCte: true },
    // 云函数各端保留独立副本（CLAUDE.md 禁止抽 shared），一致性只能靠测试兜
    { label: 'staffApi', dir: join(repoRoot, 'fengyu-staff/cloudfunctions/staffApi'), exts: ['.js'], expectCte: true },
    { label: 'clientApi', dir: join(repoRoot, 'fengyu-client/cloudfunctions/clientApi'), exts: ['.js'], expectCte: false },
    { label: 'payNotify', dir: join(repoRoot, 'fengyu-client/cloudfunctions/payNotify'), exts: ['.js'], expectCte: false },
    // 迁移里的触发器是线上热路径（0009 的库存主体防环就含递归 CTE）
    { label: 'migrations', dir: join(repoRoot, 'db/migrations'), exts: ['.sql'], expectCte: true },
  ]

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
   * 抹掉注释与各类引号里的内容（保留长度，行号不变），再做括号/正则匹配。
   * 不这么做的话，字符串里的 `)` 会让 CTE 定义体提前结束（漏报），
   * 注释里的 `descendants.path` 会被当成真引用（误报）。
   * `$$…$$` 对迁移里的 PL/pgSQL 函数体是必需的。
   */
  function maskLiterals(src: string): string {
    const out = src.split('')
    let i = 0
    const blank = (from: number, to: number) => {
      for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' '
    }
    while (i < src.length) {
      // JS 行注释。SQL 没有 `//` 词法，统一抹掉是安全的；不抹的话注释里的撇号
      //（中文注释爱写 '消费口径' 这种）会让后续引号配对整体错位、滚雪球吞掉真 SQL。
      if (src.startsWith('//', i)) {
        const end = src.indexOf('\n', i); const stop = end === -1 ? src.length : end
        blank(i, stop); i = stop; continue
      }
      // 模板插值 ${...}：里面是 JS 表达式，可能带引号/括号，留着会干扰括号平衡与引号配对
      if (src.startsWith('${', i)) {
        let depth = 1; let j = i + 2
        for (; j < src.length && depth > 0; j += 1) {
          if (src[j] === '{') depth += 1
          else if (src[j] === '}') depth -= 1
        }
        blank(i, j); i = j; continue
      }
      if (src.startsWith('--', i)) {
        const end = src.indexOf('\n', i); const stop = end === -1 ? src.length : end
        blank(i, stop); i = stop; continue
      }
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2); const stop = end === -1 ? src.length : end + 2
        blank(i, stop); i = stop; continue
      }
      // `$tag$…$tag$`（PL/pgSQL 函数体）。注意排除 `$${` —— 那是「PG 参数占位 $ + 模板插值」，
      // 误判成 dollar-quote 会一路吞到下一个 $$ 之间的全部真 SQL。
      const dollar = src.startsWith('$${', i) ? null : /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 40))
      if (dollar) {
        const tag = dollar[0]
        const end = src.indexOf(tag, i + tag.length)
        const stop = end === -1 ? src.length : end + tag.length
        blank(i, stop); i = stop; continue
      }
      // ⚠️ 只抹双引号，**不抹反引号、也不抹单引号**：
      // - 反引号：.ts/.js 里 SQL 正写在模板字符串里，抹掉等于把要检查的 SQL 整段抹掉
      // - 单引号：云函数有 `pg.query('WITH RECURSIVE …')` 这种写法，抹掉同样整段丢失
      // 代价是 SQL 字符串字面量里若有不配对的括号（如 SELECT ')' ），会让 CTE 体提前收尾；
      // 仓内无此写法，且真出现时会被下面的「WITH 头自一致性」断言逮到（识别不出块 → 红）。
      if (src[i] === '"') {
        const quote = src[i]
        let j = i + 1
        while (j < src.length && src[j] !== quote) j += (src[j] === '\\' ? 2 : 1)
        blank(i, j + 1); i = j + 1; continue
      }
      i += 1
    }
    return out.join('')
  }

  /** 每个 CTE 的定义体（`name [(cols)] AS ( … )` 括号内），外加末尾的「非 CTE 体」残余文本 */
  function cteBlocks(masked: string): { blocks: Array<{ name: string; body: string }>; outside: string } {
    const blocks: Array<{ name: string; body: string }> = []
    const ranges: Array<[number, number]> = []
    const head = /(?:\bWITH\s+(?:RECURSIVE\s+)?|[),]\s*)([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s*\(/gi
    for (const m of masked.matchAll(head)) {
      const from = m.index! + m[0].length
      let depth = 1
      let i = from
      for (; i < masked.length && depth > 0; i += 1) {
        if (masked[i] === '(') depth += 1
        else if (masked[i] === ')') depth -= 1
      }
      blocks.push({ name: m[1], body: masked.slice(from, i - 1) })
      ranges.push([m.index!, i])
    }
    // 外层/尾查询：把所有 CTE 体挖掉后剩下的文本（`WITH a AS (…) SELECT a.x FROM a al` 这类混用也要查）
    let outside = masked
    for (const [from, to] of ranges) outside = outside.slice(0, from) + ' '.repeat(to - from) + outside.slice(to)
    return { blocks, outside }
  }

  const SQL_KEYWORDS = new Set([
    'ON', 'AS', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'UNION', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
    'OUTER', 'CROSS', 'FULL', 'USING', 'HAVING', 'WINDOW', 'OFFSET', 'FETCH', 'RETURNING',
    'LATERAL', 'NATURAL', 'TABLESAMPLE', 'WITH', 'SELECT', 'FROM', 'AND', 'OR', 'SET', 'FOR',
  ])
  // JOIN/FROM 后给 CTE 起别名；`x alias`、`x AS alias`、`FROM a, x alias` 都算
  const aliasRe = (name: string) =>
    new RegExp(`\\b(?:JOIN|FROM|,)\\s*${name}\\s+(?:AS\\s+)?"?([A-Za-z_]\\w*)"?`, 'gi')
  const qualifierRe = (name: string) => new RegExp(`\\b${name}\\s*\\.`, 'i')

  function aliasesOf(name: string, text: string): string[] {
    return [...text.matchAll(aliasRe(name))]
      .map((m) => m[1])
      .filter((alias) => !SQL_KEYWORDS.has(alias.toUpperCase()))
  }

  /** 取出所有 `$tag$ … $tag$` 函数体。它们是 **SQL 的载体**，不是字面量，必须递归检查 */
  function dollarBodies(rawSrc: string): string[] {
    const bodies: string[] = []
    const re = /\$([A-Za-z_]*)\$/g
    let m: RegExpExecArray | null
    while ((m = re.exec(rawSrc)) !== null) {
      if (rawSrc.startsWith('$${', m.index)) continue
      const close = rawSrc.indexOf(m[0], m.index + m[0].length)
      if (close === -1) break
      bodies.push(rawSrc.slice(m.index + m[0].length, close))
      re.lastIndex = close + m[0].length
    }
    return bodies
  }

  function violations(rawSrc: string): string[] {
    // 函数体单独递归跑一遍 —— maskLiterals 会把 $$…$$ 当字面量抹掉（为的是不让体内引号
    // 干扰外层配对），若不在这里补回来，0009 触发器里的递归 CTE（线上热路径）就永远扫不到。
    const nested = dollarBodies(rawSrc).flatMap((body) => violations(body))
    const masked = maskLiterals(rawSrc)
    const { blocks, outside } = cteBlocks(masked)
    const hits: string[] = []
    const check = (scope: string, text: string, names: string[]) => {
      for (const name of names) {
        const aliases = aliasesOf(name, text)
        if (aliases.length === 0) continue
        if (qualifierRe(name).test(text)) {
          hits.push(`${name}@${scope}（别名 ${[...new Set(aliases)].join('/')}，却仍出现 ${name}.）`)
        }
      }
    }
    blocks.forEach(({ name, body }, index) => {
      // 体内既要查自己（递归自引用），也要查所有**先于它定义**的兄弟 CTE
      check('body', body, [name, ...blocks.slice(0, index).map((b) => b.name)])
    })
    check('outer', outside, [...new Set(blocks.map((b) => b.name))])
    return [...nested, ...hits]
  }

  /**
   * 自一致性：文件里每一个 `WITH <名字>` 头，都必须被 cteBlocks 识别成至少一个块
   * （或落进 `$$` 函数体由递归那一路接手）。
   *
   * 没有这条，词法一旦出错就是**静默失效** —— 抹错一段就整片不检查，而
   * 「没有违规」和「压根没检查」在断言上长得一模一样。反引号那次就是这么差点溜过去的。
   */
  function unrecognizedWithHeads(rawSrc: string): number {
    // 只数「引入 CTE 的 WITH」：`WITH name [(cols)] AS (`。
    // 不能只数 `\bWITH\b` —— DDL 里 `timestamp WITH TIME ZONE`、`CREATE INDEX … WITH (…)`
    // 一抓一大把（光 0000_baseline 就 126 个），全是噪音。
    const HEAD_RE = /\bWITH\s+(?:RECURSIVE\s+)?[A-Za-z_]\w*\s*(?:\([^()]*\))?\s+AS\s*\(/gi
    // 关键：头在**原文**里数，块在**抹过字面量的文本**里数。
    // 词法要是把真 SQL 抹掉了，两边就对不上 → 红。这正是反引号那次该红却没红的地方。
    const heads = (rawSrc.match(HEAD_RE) ?? []).length
    let blocks = cteBlocks(maskLiterals(rawSrc)).blocks.length
    // $$ 函数体里的头已经算进 heads（它们是 rawSrc 的子串），块要单独补上
    for (const body of dollarBodies(rawSrc)) blocks += cteBlocks(maskLiterals(body)).blocks.length
    return Math.max(0, heads - blocks)
  }

  it('全仓（admin + 三个云函数端 + 迁移）无一处混用 CTE 的别名与原名', () => {
    const offenders: string[] = []
    const blind: string[] = []
    for (const root of SCAN_ROOTS) {
      expect(existsSync(root.dir), `扫描根不存在，守护已静默缩水：${root.dir}`).toBe(true)
      let n = 0
      for (const file of listSourceFiles(root.dir, root.exts)) {
        const raw = readFileSync(file, 'utf8')
        if (!/\bWITH\b/i.test(raw)) continue
        n += 1
        const short = `${root.label}:${file.split('/').slice(-2).join('/')}`
        const missed = unrecognizedWithHeads(raw)
        if (missed > 0) blind.push(`${short}: ${missed} 个 WITH 头没被识别`)
        for (const hit of violations(raw)) offenders.push(`${short}: ${hit}`)
      }
      // 「本来就该有 CTE」的根扫到 0 个 = 路径/扩展名写错，必须红，不能伪装成「干净」
      if (root.expectCte) {
        expect(n, `${root.label} 一个含 WITH 的文件都没扫到，守护形同虚设`).toBeGreaterThan(0)
      }
    }
    // 先断言「都检查到了」，再断言「没有违规」—— 顺序很重要：盲区先暴露，
    // 否则一片没检查的文件会伪装成「干净」
    expect(blind, '这些文件里有 WITH 头没被解析出来，守护对它们是盲的').toEqual([])
    expect(offenders, 'CTE 起了别名就必须全程用别名，不能再用原名当限定符').toEqual([])
  })

  // 元测试必须复用生产用的 violations()，不能手抄一份正则 —— 手抄的那份改坏了也照样绿，
  // 正是本文件「syncLocations 副本守护」明令禁止的模式。
  it('守护规则本身有效：认得出各种等价的错误写法，也不冤枉合法写法', () => {
    const bad = [
      // #130 原样
      'WITH RECURSIVE descendants(id, path) AS (SELECT id, ARRAY[id] FROM t UNION ALL SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id WHERE NOT child.id = ANY(descendants.path))',
      // AS 形式的别名
      'WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL SELECT child.id, descendants.path FROM org_nodes child JOIN descendants AS parent ON child.parent_id = parent.id)',
      // 无列清单的命名风格
      'WITH RECURSIVE scoped AS (SELECT 1 UNION ALL SELECT scoped.id FROM x JOIN scoped s ON s.id = x.id)',
      // 逗号连接
      'WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL SELECT child.id, descendants.path FROM org_nodes child, descendants parent)',
      // 小写
      'with recursive descendants(id, path) as (select 1 union all select child.id, descendants.path from org_nodes child join descendants parent on child.parent_id = parent.id)',
      // 大小写混用的限定符
      'WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL SELECT DESCENDANTS.path FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id)',
      // 并列的第二个 CTE
      'WITH RECURSIVE a(id) AS (SELECT 1), employee_ancestors(id, path) AS (SELECT 1 UNION ALL SELECT node.id, employee_ancestors.path FROM org_nodes node JOIN employee_ancestors ancestor ON ancestor.parent_id = node.id)',
      // **外层尾查询**里的混用（不在任何 CTE 体内）
      'WITH d(id, path) AS (SELECT 1) SELECT d.path FROM d alias WHERE alias.id = 1',
      // 后一个 CTE 体里引用**前一个** CTE 时混用
      'WITH a(x, y) AS (SELECT 1, 2), b AS (SELECT a.x FROM a al WHERE al.y = 1) SELECT * FROM b',
      // 非递归 CTE 犯同样的错 —— PG 报的是同一个错
      'WITH plain(id) AS (SELECT 1) SELECT plain.id FROM plain p WHERE p.id > 0',
    ]
    for (const sql of bad) expect(violations(sql), `漏报：${sql.slice(0, 70)}…`).not.toEqual([])

    const good = [
      // 修复后：不起别名，全程用原名
      'WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL SELECT child.id, descendants.path || child.id FROM org_nodes child JOIN descendants ON child.parent_id = descendants.id)',
      // 起了别名就全程用别名
      'WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL SELECT child.id, parent.path FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id)',
      // 递归项裸自引用 + 外层带别名引用：两个不同的 range-table entry，都合法
      // （staffApi/routes/mgmt-dashboard.js 就是这样写的，整文件 grep 会误报）
      'WITH RECURSIVE market_descendants(market_id, node_id) AS (SELECT 1 UNION ALL SELECT market_descendants.market_id, child.id FROM org_nodes child JOIN market_descendants ON child.parent_id = market_descendants.node_id) SELECT * FROM markets m LEFT JOIN market_descendants d ON d.market_id = m.id',
      // 注释里出现原名限定符不算数
      "WITH RECURSIVE descendants(id, path) AS (SELECT 1 UNION ALL /* 别写 descendants.path */ SELECT parent.path FROM org_nodes child JOIN descendants parent ON child.parent_id = parent.id)",
    ]
    for (const sql of good) expect(violations(sql), `误报：${sql.slice(0, 70)}…`).toEqual([])
  })

  // 上面的夹具都是纯 SQL 字符串，防不住「词法把源码抹错了」这类退化 ——
  // 真实文件里 SQL 是裹在模板字符串/单引号里、旁边还有 JS 注释与 ${} 插值的。
  it('源码形态的夹具：JS 注释 / 模板插值 / 引号交错都不会把 SQL 抹没', () => {
    const BT = '\u0060'  // 反引号，直接写会打断本文件的模板字符串
    const BAD_SQL = 'WITH RECURSIVE d(id, path) AS (SELECT 1 UNION ALL SELECT d.path FROM t child JOIN d parent ON child.pid = parent.id)'
    const sources = [
      // 模板字符串里的 SQL（admin / 云函数的常态）
      `const q = sql${BT}${BAD_SQL}${BT}`,
      // 行注释里带撇号 —— 不识别 // 的话，撇号会让后续引号配对整体错位、吞掉真 SQL
      `// 这里按 'Ada' 的口径算\nconst q = sql${BT}${BAD_SQL}${BT}`,
      // 动态参数占位 $${n}：误判成 dollar-quote 会一路吞到下一个 $$
      `const q = sql${BT}${BAD_SQL} AND x = $` + '${params.length}' + `${BT}`,
      // 单引号字符串形态（pg.query('…', [...])）
      `pg.query('${BAD_SQL}', [])`,
    ]
    for (const src of sources) {
      expect(violations(src), `SQL 被抹没了，守护对这种源码形态是盲的：${src.slice(0, 50)}…`).not.toEqual([])
      expect(unrecognizedWithHeads(src), `WITH 头没被识别：${src.slice(0, 50)}…`).toBe(0)
    }
  })

  it('$$ 函数体里的 CTE 也在守护范围（0009 的库存主体防环触发器就住在里面）', () => {
    const src = [
      'CREATE FUNCTION f() RETURNS trigger AS $$',
      'BEGIN',
      "  IF EXISTS (WITH RECURSIVE ancestors(id, pid) AS (SELECT 1 UNION ALL SELECT ancestors.id FROM t x JOIN ancestors a ON x.pid = a.id) SELECT 1 FROM ancestors) THEN",
      "    RAISE EXCEPTION 'boom';",
      '  END IF;',
      'END;',
      '$$ LANGUAGE plpgsql;',
    ].join('\n')
    expect(violations(src), '函数体被当字面量抹掉了，热路径 SQL 从未被检查').not.toEqual([])
    expect(unrecognizedWithHeads(src)).toBe(0)
  })
})
