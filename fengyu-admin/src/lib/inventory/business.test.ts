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
  autoBatchNo,
  lineBatchNo,
  approveItemCompanyShipmentCancellation,
  assertSkuAvailableToMarket,
  cancelSupplyChainPurchaseOrder,
  cancelItemCompanyShipment,
  createInventoryConversion,
  createItemCompanyShipment,
  createItemCompanyReplenishment,
  createMarketStaffPurchase,
  createMarketReplenishment,
  allocateRetainedQuantity,
  createPurchaseOrder,
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
  receiveItemCompanyShipmentInFull,
  receiveStoreAllocationInFull,
  receiveSupplyChainPurchaseOrder,
  rejectItemCompanyShipmentCancellation,
  requestItemCompanyShipmentCancellation,
} from './business'
import { db } from '@/db'
import ts from 'typescript'
import { INVENTORY_GENERIC_DOC_TYPES, type InventoryDocType } from './types'

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

/**
 * #194 起采购订单按商品带出供应商，SKU 没绑定档案会被 fail-closed 挡在数量校验之前。
 * 想测后面的分支就得用这个带 supplier_id 的行。
 */
function supplierBoundSkuRow(skuId = 'SKU-1') {
  return {
    ...marketSkuRow(skuId),
    supplier: '测试供应商',
    supplier_id: 'SUP-1',
    supply_chain_purchase_price: '80',
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
 * 按序取出 `sql` 模板里的绑定参数值。
 *
 * `renderSql` 只还原静态片段（drizzle 的 StringChunk 带 `value: string[]`），
 * 想断言「传下去的是哪一行」就得看参数本身。drizzle 0.45 把插值**原样**留在
 * queryChunks 里（裸的 number / string，不是 Param 包装），所以这里按「不是
 * StringChunk 就算参数」来挑，并兼容带 `value` 的包装形态。
 */
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  const isStringChunk = (chunk: unknown) => (
    typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)
  )
  return chunks
    .filter((chunk) => !isStringChunk(chunk))
    .map((chunk) => (
      typeof chunk === 'object' && chunk !== null && 'value' in chunk
        ? (chunk as { value: unknown }).value
        : chunk
    ))
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
    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('采购订单至少需要一条明细')
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ', items: [], giftItems: [],
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

  it('拥有撤回审批权限的用户审批后恢复总部库存；采购行 fulfilled 只记入库，不随撤回回退（#335）', async () => {
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
    // 发货从不回写采购行（#335），撤回也就不能再去回退它 —— 回退会把已入库量减掉
    expect(queries).not.toContain('UPDATE inventory_doc_items purchase_item')
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
    })).rejects.toThrow('只能选择供应链 SKU')
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

  it('采购订单只接受已完成的品项公司报货需求', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow(), doc_id: 'ZBH-1' }])
      .mockResolvedValueOnce([{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '草稿',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([supplierBoundSkuRow()])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购订单必须引用有效的品项公司报货需求单')
  })

  it('品项公司报货需求同节点归一化形态（source=target=总部）可通过供应链主体校验', async () => {
    // insertDocHeader 对同节点单据类型做 source=target 归一化，落库 source 不是 null。
    // 哨兵挪到了数量校验：能走到「未下单数量」说明已越过 source 守卫。
    // 来源行 fulfilled_quantity 给满（5/5），本次再要 1 件即超出 ——
    // 「已下单量」读的是行上的 fulfilled_quantity（它才是被取消逻辑维护的那一个），
    // 不再额外查血缘，所以这里没有对应的 linkedQuantity mock。
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow('5'), doc_id: 'ZBH-1' }])
      .mockResolvedValueOnce([{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '已完成',
        source_org_node_id: 'HQ', target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([supplierBoundSkuRow()])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购数量不能超过品项公司报货中的未下单数量')
  })

  it('品项公司报货需求 source 指向非总部主体仍被血缘守卫拒绝', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow(), doc_id: 'ZBH-1' }])
      .mockResolvedValueOnce([{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '已完成',
        source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([supplierBoundSkuRow()])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('品项公司报货需求的供应链主体不一致')
  })

  it('关闭部分收货的采购订单会释放未收需求数量', async () => {
    const purchaseOrderItem = {
      ...storeRequestItemRow(),
      doc_id: 'CGD-1',
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
        id: 'CGD-1', doc_type: '采购订单', status: '待收货',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([{
        location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      // 收敛后不再回溯唯一的品项公司报货需求单，直接读本单明细
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
      purchaseOrderId: 'CGD-1', cancellationReason: '供应商短供',
    })).resolves.toEqual({ success: true })
  })

  it('原始市场报货单不能直接下采购订单，必须先经市场报货汇总', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow(), doc_id: 'MBH-1' }])
      .mockResolvedValueOnce([{
        id: 'MBH-1', doc_type: '市场报货', status: '已完成',
        source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([supplierBoundSkuRow()])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购订单只能引用市场报货汇总或品项公司报货需求')
  })

  it('有市场归属的行可以走供应链采购入库（#335）', async () => {
    // 市场行越过了原先的「有市场归属」拦截，走到了 SKU 来源校验：
    // 用一个非供应链 SKU 当哨兵，报的是 SKU 来源错而不是市场归属错。
    const receiptExecutor = vi.fn()
      .mockResolvedValueOnce([{
        id: 'CGD-2', doc_type: '采购订单', status: '待收货',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow(), doc_id: 'CGD-2', market_id: 'M1' }])
      .mockResolvedValueOnce([{ ...supplierBoundSkuRow(), source_type: '市场自采', owner_market_id: 'M1' }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(receiptExecutor),
    } as never))
    const receipt = receiveSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'CGD-2', supplyChainLocationId: 'HQ',
      items: [{ purchaseOrderItemId: 1, quantity: 1 }],
    })
    await expect(receipt).rejects.toThrow('只能选择供应链 SKU')
    await expect(receipt).rejects.not.toThrow('有市场归属')
  })

  it('市场报货汇总行的 SKU 不是供应链商品时，建采购订单直接拒绝（#335 Q3）', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow(), doc_id: 'MHZ-1', market_id: 'M1' }])
      .mockResolvedValueOnce([{
        id: 'MHZ-1', doc_type: '市场报货汇总', status: '已完成',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([{ ...supplierBoundSkuRow(), source_type: '市场自采', owner_market_id: 'M1' }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createPurchaseOrder(SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('采购订单只能采购供应链商品')
  })

  describe('采购 / 入库 / 发货数量多于两位小数时在入口拒绝（#335）', () => {
    const hqRow = { location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }
    const orderRow = {
      id: 'CGD-1', doc_type: '采购订单', status: '待收货',
      source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
      supplier_id: null, supplier_name: null,
    }
    function mockTx(...results: unknown[]) {
      const txExecute = vi.fn()
      for (const result of results) txExecute.mockResolvedValueOnce(result)
      vi.mocked(db.execute).mockResolvedValue([] as never)
      vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
        execute: initializedCutoverExecutor(txExecute),
      } as never))
    }

    it.each([1.234, 1e-9])('采购数量 %s 被拒', async (quantity) => {
      mockTx([hqRow])
      await expect(createPurchaseOrder(SESSION, {
        supplyChainLocationId: 'HQ',
        items: [{ sourceItemId: 1, quantity }],
      })).rejects.toThrow('采购数量最多保留两位小数')
    })

    it('合法的大数量不被浮点残差误伤（越过精度校验走到来源校验）', async () => {
      mockTx([hqRow], [{ ...storeRequestItemRow(), doc_id: 'ZBH-1' }], [{
        id: 'ZBH-1', doc_type: '品项公司报货需求', status: '草稿',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }], [supplierBoundSkuRow()])
      await expect(createPurchaseOrder(SESSION, {
        supplyChainLocationId: 'HQ',
        items: [{ sourceItemId: 1, quantity: 1234567890.12 }],
      })).rejects.toThrow('采购订单必须引用有效的品项公司报货需求单')
    })

    it('实收数量 1.234 被拒', async () => {
      mockTx([orderRow], [hqRow], [{ ...storeRequestItemRow(), doc_id: 'CGD-1' }], [supplierBoundSkuRow()])
      await expect(receiveSupplyChainPurchaseOrder(SESSION, {
        purchaseOrderId: 'CGD-1', supplyChainLocationId: 'HQ',
        items: [{ purchaseOrderItemId: 1, quantity: 1.234 }],
      })).rejects.toThrow('实收数量最多保留两位小数')
    })

    it('发货数量 1.234 被拒', async () => {
      mockTx(
        [hqRow],
        [{ location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ' }],
        [{ ...storeRequestItemRow(), doc_id: 'MBH-1' }],
        [{
          id: 'MBH-1', doc_type: '市场报货', status: '已完成',
          source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
          supplier_id: null, supplier_name: null,
        }],
      )
      await expect(createItemCompanyShipment(SESSION, {
        marketId: 'M1', sourceOrgNodeId: 'HQ',
        items: [{ reportItemId: 1, lotId: 1, quantity: 1.234 }],
      })).rejects.toThrow('发货数量最多保留两位小数')
    })
  })

  it('关闭部分入库的采购订单：不再看发货量（#336 发货直连报货单），按已入库量释放汇总行（#335）', async () => {
    const summaryItem = {
      ...storeRequestItemRow(), id: 10, doc_id: 'MHZ-1', market_id: 'M1',
      quantity: '10', fulfilled_quantity: '10',
    }
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        id: 'CGD-1', doc_type: '采购订单', status: '待收货',
        source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
        supplier_id: null, supplier_name: null,
      }])
      .mockResolvedValueOnce([{ location_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }])
      .mockResolvedValueOnce([{ ...storeRequestItemRow('3'), doc_id: 'CGD-1', market_id: 'M1', quantity: '10' }])
      .mockResolvedValueOnce([{ relation_type: '报货汇总采购订单', from_item_id: 10, to_item_id: 1, quantity: '10' }])
      .mockResolvedValueOnce([{ quantity: '3' }]) // 已入库（释放计算）
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([summaryItem])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(cancelSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'CGD-1', cancellationReason: '供应商短供',
    })).resolves.toEqual({ success: true })
    // 汇总行 fulfilled 10 → 3：只退还未入库的 7，已入库的 3 继续占用（市场行不再整行作废）
    const summaryRelease = txExecute.mock.calls
      .map(([query]) => query as { queryChunks?: unknown[] })
      .find((query) => renderSql(query).includes('SET fulfilled_quantity')
        && (query.queryChunks ?? []).includes(10))
    expect(summaryRelease?.queryChunks).toContain('3')
    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).toContain("SET status = '已取消'")
    // 关单不再查「采购订单发货」血缘（关系类型是绑定参数，要看参数而不是 SQL 文本）
    const relationParams = txExecute.mock.calls.flatMap(([query]) => sqlParams(query))
    expect(relationParams).toContain('采购订单供应链采购入库')
    expect(relationParams).not.toContain('采购订单发货')
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
describe('品项公司发货直接引用市场报货单（#336）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const reportHeader = (overrides: Record<string, unknown> = {}) => ({
    id: 'MBH-1', doc_type: '市场报货', status: '已完成',
    source_org_node_id: 'M1', target_org_node_id: 'HQ', market_id: 'M1',
    supplier_id: null, supplier_name: null,
    ...overrides,
  })
  const reportItem = (id: number, quantity: string) => ({
    ...storeRequestItemRow(), id, doc_id: 'MBH-1', quantity, request_quantity: quantity,
  })

  /**
   * 按 SQL 内容路由的事务 mock：报货行 / 报货单 / 批次 / SKU 各按固定数据回，
   * 「市场报货发货」已发量按 shippedByItem 回，写入语句逐条收集供断言。
   */
  function mockShipment(input: {
    items: ReturnType<typeof reportItem>[]
    header?: Record<string, unknown>
    shippedByItem?: Record<number, string>
    lotQuantity?: string
    insertLinkError?: unknown
  }) {
    const links: unknown[][] = []
    const docItems: unknown[][] = []
    let nextItemId = 500
    const executor = vi.fn(async (query: unknown) => {
      const rendered = renderSql(query)
      const params = sqlParams(query)
      if (rendered.includes('INSERT INTO inventory_doc_links')) {
        if (input.insertLinkError) throw input.insertLinkError
        links.push(params)
        return []
      }
      if (rendered.includes('INSERT INTO inventory_doc_items')) {
        docItems.push(params)
        return [{ id: String(nextItemId++) }]
      }
      if (rendered.includes('INSERT INTO')) return []
      if (rendered.includes('FROM inventory_doc_links')) {
        return [{ quantity: input.shippedByItem?.[Number(params[0])] ?? '0' }]
      }
      if (rendered.includes('FROM inventory_stock_reservations')) return [{ quantity: '0' }]
      if (rendered.includes('FROM inventory_stock_lots')) {
        return [{ ...shipmentSourceLotRow(), quantity_on_hand: input.lotQuantity ?? '100' }]
      }
      if (rendered.includes('FROM inventory_skus')) return [supplierBoundSkuRow()]
      if (rendered.includes('FROM inventory_locations')) {
        return params.includes('M1')
          ? [{ location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ' }]
          : [{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }]
      }
      if (rendered.includes('FROM inventory_doc_items')) {
        const row = input.items.find((item) => item.id === Number(params[0]))
        return row ? [row] : []
      }
      if (rendered.includes('FROM inventory_docs') && rendered.includes('FOR UPDATE')) {
        return [reportHeader(input.header)]
      }
      return []
    })
    mockSyncLocationsShortCircuit()
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(executor),
    } as never))
    return { links, docItems }
  }

  it('正常发货超过报货未发量时拒绝，报错写明本次最多可发数量', async () => {
    mockShipment({ items: [reportItem(1, '30')], shippedByItem: { 1: '10' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 21 }],
    })).rejects.toThrow('本次最多可发 20')
  })

  it('同一报货行拆成多行（不同批号）时按合计封顶', async () => {
    mockShipment({ items: [reportItem(1, '30')], shippedByItem: { 1: '10' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [
        { reportItemId: 1, lotId: 101, quantity: 15 },
        { reportItemId: 1, lotId: 102, quantity: 6 },
      ],
    })).rejects.toThrow('本次最多可发 20')
  })

  it('引用别的市场报的报货单被拒', async () => {
    mockShipment({ items: [reportItem(1, '30')], header: { source_org_node_id: 'M2', market_id: 'M2' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('不是该收货市场报的')
  })

  it('引用非市场报货单被拒', async () => {
    mockShipment({ items: [reportItem(1, '30')], header: { doc_type: '采购订单' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('必须引用有效的市场报货单')
  })

  it('发货总部必须是报货单指定的供应链主体', async () => {
    mockShipment({ items: [reportItem(1, '30')], header: { target_org_node_id: 'HQ2' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('指定的供应链主体发出')
  })

  it('赠送行不受报货数量封顶，写「市场报货赠送发货」直连血缘并生成独立批号；正常行 request_quantity 记报货数量', async () => {
    const { links, docItems } = mockShipment({ items: [reportItem(1, '1')], shippedByItem: { 1: '0' } })
    const result = await createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
      giftItems: [{ reportItemId: 1, lotId: 101, quantity: 2 }],
    })
    expect(result.id).toMatch(/^GFH-/)
    expect(links).toHaveLength(2)
    expect(links[0]).toEqual(expect.arrayContaining(['MBH-1', result.id, '市场报货发货', 1]))
    expect(links[1]).toEqual(expect.arrayContaining(['MBH-1', result.id, '市场报货赠送发货', 1]))
    expect(links.flat()).not.toContain('采购订单发货')
    expect(docItems).toHaveLength(2)
    // 正常行沿用总部批号；赠送行 = 发货单号-行号（#345），与正常货区分
    expect(docItems[0]).toContain('B-001')
    expect(docItems[1]).toContain(`${result.id}-02`)
    expect(docItems[1]).not.toContain('B-001')
  })

  it('同一批次被正常行与赠送行共用时按合计校验可用量（在写入前拦下，不靠 applyLotDelta 兜底）', async () => {
    const { docItems } = mockShipment({ items: [reportItem(1, '10')], lotQuantity: '5' })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 4 }],
      giftItems: [{ reportItemId: 1, lotId: 101, quantity: 2 }],
    })).rejects.toThrow('可用 5')
    expect(docItems).toHaveLength(0)
  })

  it('非「已完成」的市场报货单（草稿 / 待审批异常单）不能发货，与汇总守卫同口径', async () => {
    mockShipment({ items: [reportItem(1, '30')], header: { status: '草稿' } })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('必须引用有效的市场报货单')
  })

  it('发货批次的商品与报货行不一致时拒绝', async () => {
    mockShipment({ items: [{ ...reportItem(1, '30'), sku_id: 'SKU-OTHER' }] })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('发货批次与市场报货商品不一致')
  })

  it('入参形状：非数组明细、非法 id、同报货行同批次重复都在事务前拒绝（不静默丢行、不让 NaN 进 SQL）', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ items: { reportItemId: 1 } }, /发货明细格式不正确/],
      [{ items: [], giftItems: 'x' }, /赠送明细格式不正确/],
      [{ items: [{ reportItemId: true, lotId: 101, quantity: 1 }] }, /市场报货明细不正确/],
      [{ items: [{ reportItemId: '1.5', lotId: 101, quantity: 1 }] }, /市场报货明细不正确/],
      [{ items: [{ reportItemId: 1, lotId: Number.NaN, quantity: 1 }] }, /请为每行选择发货批次/],
      [{ items: [null] }, /市场报货明细不正确/],
      [{
        items: [{ reportItemId: 1, lotId: 101, quantity: 1 }, { reportItemId: '1', lotId: 101, quantity: 2 }],
      }, /不能重复填写/],
    ]
    for (const [input, pattern] of cases) {
      await expect(createItemCompanyShipment(SESSION, {
        marketId: 'M1', sourceOrgNodeId: 'HQ', ...input,
      } as never)).rejects.toThrow(pattern)
    }
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled()
  })

  it('同一报货行正常与赠送各一行、同批次不算重复', async () => {
    const { links } = mockShipment({ items: [reportItem(1, '5')] })
    await createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
      giftItems: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })
    expect(links).toHaveLength(2)
  })

  it.each([false, true])('旧口径（采购订单发货）的发货单收货时给出可操作的报错：撤回后按报货单重发（赠送行=%s 也拦）', async (isGift) => {
    const shipmentRow = {
      id: 'GFH-OLD', doc_type: '品项公司发货', status: '待收货',
      source_org_node_id: 'HQ', target_org_node_id: 'M1', market_id: 'M1',
      supplier_id: null, supplier_name: null,
      cancellation_request_reason: null, cancellation_requested_by: null, cancellation_requested_at: null,
    }
    const executor = vi.fn(async (query: unknown) => {
      const rendered = renderSql(query)
      const params = sqlParams(query)
      // 价格快照 SQL 也 JOIN inventory_doc_items，必须排在明细分支之前；旧单没有「市场报货发货」血缘
      if (rendered.includes('FROM inventory_doc_links')) return []
      if (rendered.includes('FROM inventory_stock_lots')) return [shipmentSourceLotRow()]
      if (rendered.includes('FROM inventory_skus')) return [marketSkuRow('SKU-1')]
      if (rendered.includes('FROM inventory_locations')) {
        return params.includes('M1')
          ? [{ location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ' }]
          : [{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }]
      }
      if (rendered.includes('FROM inventory_doc_items')) {
        return [{ ...storeRequestItemRow(), id: 7, doc_id: 'GFH-OLD', lot_id: 101, quantity: '1', is_gift: isGift }]
      }
      if (rendered.includes('FROM inventory_docs')) return [shipmentRow]
      return []
    })
    mockSyncLocationsShortCircuit()
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(executor),
    } as never))
    await expect(receiveItemCompanyShipment(SESSION, {
      shipmentId: 'GFH-OLD', items: [{ shipmentItemId: 7, receivedQuantity: 1 }],
    })).rejects.toThrow('请申请撤回后按市场报货单重新发货')
  })

  it('触发器兜底 RAISE「关联数量超出来源明细」改写为可读的 CONFLICT 文案', async () => {
    const raise = Object.assign(new Error('Failed query: insert into inventory_doc_links'), {
      cause: Object.assign(new Error('关联数量超出来源明细：来源 1, 现有关联 1, 本次 1'), { code: 'P0001' }),
    })
    mockShipment({ items: [reportItem(1, '1')], insertLinkError: raise })
    await expect(createItemCompanyShipment(SESSION, {
      marketId: 'M1', sourceOrgNodeId: 'HQ',
      items: [{ reportItemId: 1, lotId: 101, quantity: 1 }],
    })).rejects.toThrow('CONFLICT: 正常发货数量超过报货未发量')
  })
})

describe('批号自动生成（#345）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('autoBatchNo：格式为「单号-两位行号」，行号超过两位不截断', () => {
    expect(autoBatchNo('GRK-20260925-0001', 1)).toBe('GRK-20260925-0001-01')
    expect(autoBatchNo('GRK-20260925-0001', 12)).toBe('GRK-20260925-0001-12')
    expect(autoBatchNo('GRK-20260925-0001', 123)).toBe('GRK-20260925-0001-123')
  })

  it('autoBatchNo：同日不同单号、同单不同行号都不重号（单号全局唯一 ⇒ 批号全局唯一）', () => {
    const generated = new Set<string>()
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      const docId = `GRK-20260925-${String(sequence).padStart(4, '0')}`
      for (let lineNo = 1; lineNo <= 120; lineNo += 1) generated.add(autoBatchNo(docId, lineNo))
    }
    expect(generated.size).toBe(50 * 120)
    // 不同单据类型前缀不会撞号
    expect(autoBatchNo('ZRK-20260925-0001', 1)).not.toBe(autoBatchNo('GRK-20260925-0001', 1))
  })

  it('lineBatchNo：赠送属性与来源批次一致时沿用来源批号，翻转（任一方向）时按单号-行号换批号', () => {
    const normalLot = { batchNo: 'B-1', isGift: false }
    const giftLot = { batchNo: 'GFH-20260925-0001-02', isGift: true }
    expect(lineBatchNo(normalLot, false, 'FPH-20260925-0001', 1)).toBe('B-1')
    expect(lineBatchNo(normalLot, true, 'FPH-20260925-0001', 2)).toBe('FPH-20260925-0001-02')
    expect(lineBatchNo(giftLot, true, 'FPH-20260925-0001', 2)).toBe('GFH-20260925-0001-02')
    expect(lineBatchNo(giftLot, false, 'FPH-20260925-0001', 1)).toBe('FPH-20260925-0001-01')
    // 来源批次无批号（存量）拨赠送同样生成
    expect(lineBatchNo({ batchNo: '', isGift: false }, true, 'GFH-20260925-0003', 1)).toBe('GFH-20260925-0003-01')
  })

  it('autoBatchNo：行号必须是正整数', () => {
    expect(() => autoBatchNo('GRK-20260925-0001', 0)).toThrow()
    expect(() => autoBatchNo('GRK-20260925-0001', 1.5)).toThrow()
  })

  function mockSupplyChainReceipt() {
    const lotInserts: unknown[][] = []
    const itemInserts: unknown[][] = []
    let lastLotBatchNo = ''
    const executor = vi.fn(async (query: unknown) => {
      const rendered = renderSql(query)
      if (rendered.includes('INSERT INTO inventory_stock_lots')) {
        const params = sqlParams(query)
        lotInserts.push(params)
        // upsertLot 的 VALUES 顺序：location_id, sku_id, lot_key, sku_name, spec_name, supplier, supplier_id, product_series, batch_no
        lastLotBatchNo = String(params[8])
        return [{ id: '7' }]
      }
      if (rendered.includes('FROM inventory_stock_lots')) {
        return [{ ...shipmentSourceLotRow(), id: '7', batch_no: lastLotBatchNo, source_doc_id: null }]
      }
      if (rendered.includes('INSERT INTO inventory_doc_items')) {
        itemInserts.push(sqlParams(query))
        return [{ id: '9' }]
      }
      if (rendered.includes('FROM inventory_doc_links')) return [{ quantity: '0' }]
      if (rendered.includes('FROM inventory_doc_items')) {
        return [{ ...storeRequestItemRow(), doc_id: 'CGD-1', market_id: null, supply_chain_unit_cost: '80' }]
      }
      if (rendered.includes('FROM inventory_skus')) return [supplierBoundSkuRow()]
      if (rendered.includes('FROM inventory_locations')) {
        return [{ location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }]
      }
      if (rendered.includes('FROM inventory_docs') && rendered.includes('FOR UPDATE')) {
        return [{
          id: 'CGD-1', doc_type: '采购订单', status: '待收货',
          source_org_node_id: null, target_org_node_id: 'HQ', market_id: null,
          supplier_id: null, supplier_name: null,
        }]
      }
      return []
    })
    mockSyncLocationsShortCircuit()
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(executor),
    } as never))
    return { lotInserts, itemInserts }
  }

  it('供应链采购入库批号留空：批次与入库明细写入「入库单号-01」，不再写空串', async () => {
    const { lotInserts, itemInserts } = mockSupplyChainReceipt()
    const result = await receiveSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'CGD-1', supplyChainLocationId: 'HQ',
      items: [{ purchaseOrderItemId: 1, quantity: 1, batchNo: '   ' }],
    })
    expect(result.id).toMatch(/^GRK-\d{8}-0001$/)
    const expected = `${result.id}-01`
    expect(lotInserts).toHaveLength(1)
    expect(lotInserts[0][8]).toBe(expected)
    // lot_key 的批号段同步变化（同批实物的批次键按生成批号归一）
    expect(String(lotInserts[0][2])).toContain(`|${expected}|`)
    expect(itemInserts).toHaveLength(1)
    expect(itemInserts[0]).toContain(expected)
  })

  it('供应链采购入库手填批号：原样保存，不生成', async () => {
    const { lotInserts, itemInserts } = mockSupplyChainReceipt()
    const result = await receiveSupplyChainPurchaseOrder(SESSION, {
      purchaseOrderId: 'CGD-1', supplyChainLocationId: 'HQ',
      items: [{ purchaseOrderItemId: 1, quantity: 1, batchNo: 'B-MANUAL' }],
    })
    expect(lotInserts[0][8]).toBe('B-MANUAL')
    expect(lotInserts[0]).not.toContain(`${result.id}-01`)
    expect(itemInserts[0]).toContain('B-MANUAL')
  })
})

describe('createPurchaseOrder 供应链 scope 归属', () => {
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
      // locationForUpdate(供应链总部) —— scope 校验紧随其后
      .mockResolvedValueOnce([{
        location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null,
      }])
      // docItemForUpdate → 空（哨兵：走到读来源明细说明 scope 已放行）
      .mockResolvedValueOnce([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))
    return txExecute
  }

  it('供应链库存员（总部 scope）创建采购订单不被市场 scope 拦截', async () => {
    mockPurchaseOrderTransaction()
    await expect(createPurchaseOrder(SUPPLY_CHAIN_OPERATOR_SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('库存单据明细不存在')
  })

  it('仅有市场 scope 的会话不能替总部创建采购订单', async () => {
    mockPurchaseOrderTransaction()
    await expect(createPurchaseOrder(MARKET_ONLY_SESSION, {
      supplyChainLocationId: 'HQ',
      items: [{ sourceItemId: 1, quantity: 1 }],
    })).rejects.toThrow('PERMISSION_DENIED')
  })
})

describe('库存转换仅供应链可做（#343）', () => {
  const hqRow = { location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }
  const lotRow = { ...shipmentSourceLotRow(), quantity_on_hand: '10' }
  function mockTx(...results: unknown[]) {
    const txExecute = vi.fn()
    for (const result of results) txExecute.mockResolvedValueOnce(result)
    txExecute.mockResolvedValue([])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))
    return txExecute
  }
  const input = (locationId: string) => ({
    locationId,
    sources: [{ sourceLotId: 101, quantity: 1 }],
    targets: [{ targetSkuId: 'SKU-2', quantity: 1, unitPrice: 10 }],
  })

  it.each([
    ['市场', 'M1'],
    ['门店', 'S1'],
  ])('%s主体被拒（lib 层按主体类型兜底，不依赖 action 权限闸）', async (locationType, locationId) => {
    mockTx([{ location_id: locationId, org_node_id: locationId, location_type: locationType, name: locationType, parent_location_id: 'HQ' }])
    await expect(createInventoryConversion(SESSION, input(locationId)))
      .rejects.toThrow('库存转换主体必须是总部库存主体')
  })

  it('非 admin 的供应链会话（scope 仅总部）传入市场主体：先报主体类型错，不是 PERMISSION_DENIED', async () => {
    const supplyChainOnly = {
      employeeId: 'E-SC1',
      name: '供应链库存员',
      phone: '13800000012',
      roles: [{
        role: 'inventory_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
        actions: ['inventory:supply_chain_operate'], scopeStoreIds: [], scopeOrgNodeIds: ['HQ'],
      }],
      permissions: { actions: ['inventory:supply_chain_operate'], scopeStoreIds: [] },
    } as never
    mockTx([{ location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场', parent_location_id: 'HQ' }])
    await expect(createInventoryConversion(supplyChainOnly, input('M1')))
      .rejects.toThrow('库存转换主体必须是总部库存主体')
  })

  it('来源批次的 SKU 是自建商品（市场自采）时拒绝，文案指明自建商品', async () => {
    mockTx([hqRow], [lotRow], [{ quantity: '0' }], [{ ...supplierBoundSkuRow('SKU-1'), source_type: '市场自采', owner_market_id: 'M1' }])
    await expect(createInventoryConversion(SESSION, input('HQ')))
      .rejects.toThrow('自建商品不能转换')
  })

  it('目标 SKU 是自建商品（转让店）时拒绝，文案指明自建商品', async () => {
    mockTx(
      [hqRow], [lotRow], [{ quantity: '0' }],
      [supplierBoundSkuRow('SKU-1')],
      [{ ...supplierBoundSkuRow('SKU-2'), source_type: '转让店', owner_market_id: 'M1' }],
    )
    await expect(createInventoryConversion(SESSION, input('HQ')))
      .rejects.toThrow('自建商品不能转换')
  })
})

/**
 * #344 转换多对多：用一个极小的内存假库跑完整流程 —— 批次表（lot_key 去重）+ 流水回写在手量，
 * 逐一断言来源批次扣减量、目标批次增加量、目标批次单价与 doc_links 分摊数量。
 * 真库上的触发器（金额 / 单头合计 / 0043 数量上限）由 smoke-inventory-transfer 在 PG 上实跑。
 */
describe('库存转换多对多与成本守恒（#344）', () => {
  interface FakeLot { id: number; sku_id: string; batch_no: string; expiry_date: string | null; is_gift: boolean; quantity_on_hand: number; supply_chain_unit_cost: string | null; lot_key?: string; source_doc_id: string | null }
  const hqRow = { location_id: 'HQ', org_node_id: 'HQ', location_type: '总部', name: '供应链', parent_location_id: null }

  function fakeDb(seed: Array<Partial<FakeLot> & { id: number; sku_id: string }>, reserved: Record<number, number> = {}) {
    const lots = new Map<number, FakeLot>()
    for (const lot of seed) {
      lots.set(lot.id, { batch_no: `B-${lot.id}`, expiry_date: null, is_gift: false, quantity_on_hand: 100, supply_chain_unit_cost: '10', source_doc_id: 'GRK-OLD', ...lot })
    }
    let nextLotId = 900
    let nextItemId = 1
    const items: Array<{ id: number; docId: string; lotId: number; quantity: number; standardUnitPrice: unknown; actualUnitPrice: unknown; supplyChainUnitCost: unknown }> = []
    const links: Array<{ fromItemId: number; toItemId: number; quantity: number; relationType: string }> = []
    const lotLocks: number[] = []
    const movements: Array<{ lotId: number; delta: number; before: number; after: number }> = []
    const executor = vi.fn(async (query: unknown) => {
      const rendered = renderSql(query)
      const params = sqlParams(query)
      if (rendered.includes('INSERT INTO inventory_stock_lots')) {
        // VALUES：location_id, sku_id, lot_key, sku_name, spec_name, supplier, supplier_id, product_series,
        // batch_no, expiry_date, expiry_date_key, is_gift, supply_chain_unit_cost, …, source_doc_id
        const lotKey = String(params[2])
        const existing = [...lots.values()].find((lot) => lot.lot_key === lotKey)
        if (existing) return [{ id: String(existing.id) }]
        const id = nextLotId++
        lots.set(id, {
          id, sku_id: String(params[1]), lot_key: lotKey, batch_no: String(params[8]),
          expiry_date: (params[9] as string | null) ?? null, is_gift: Boolean(params[11]), quantity_on_hand: 0,
          supply_chain_unit_cost: params[12] as string | null, source_doc_id: String(params[params.length - 1]),
        })
        return [{ id: String(id) }]
      }
      if (rendered.includes('FROM inventory_stock_lots') && rendered.includes('FOR UPDATE')) {
        const lot = lots.get(Number(params[0]))
        if (!lot) return []
        lotLocks.push(lot.id)
        return [{
          ...shipmentSourceLotRow(), ...lot, id: String(lot.id), sku_name: `商品${lot.sku_id}`,
          quantity_on_hand: String(lot.quantity_on_hand),
        }]
      }
      if (rendered.includes('FROM inventory_stock_reservations')) return [{ quantity: String(reserved[Number(params[0])] ?? 0) }]
      if (rendered.includes('FROM inventory_skus')) return [supplierBoundSkuRow(String(params[0]))]
      if (rendered.includes('FROM inventory_locations')) return [hqRow]
      if (rendered.includes('INSERT INTO inventory_doc_items')) {
        // VALUES：doc_id, lot_id, sku_id, sku_name, spec_name, supplier, supplier_id, market_id, product_series,
        // batch_no, expiry_date, is_gift, quantity, stock_snapshot, request_quantity, fulfilled_quantity,
        // standard_unit_price, unit_discount, actual_unit_price, amount, supply_chain_unit_cost, …
        const id = nextItemId++
        items.push({
          id, docId: String(params[0]), lotId: Number(params[1]), quantity: Number(params[12]),
          standardUnitPrice: params[16], actualUnitPrice: params[18], supplyChainUnitCost: params[20],
        })
        return [{ id: String(id) }]
      }
      if (rendered.includes('INSERT INTO inventory_movements')) {
        // VALUES：movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id, direction, quantity_delta, …
        const lot = lots.get(Number(params[1]))!
        movements.push({ lotId: lot.id, delta: Number(params[7]), before: Number(params[8]), after: Number(params[9]) })
        lot.quantity_on_hand = Math.round((lot.quantity_on_hand + Number(params[7])) * 100) / 100
        return []
      }
      if (rendered.includes('INSERT INTO inventory_doc_links')) {
        links.push({ relationType: String(params[2]), fromItemId: Number(params[3]), toItemId: Number(params[4]), quantity: Number(params[5]) })
        return []
      }
      return []
    })
    mockSyncLocationsShortCircuit()
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(executor),
    } as never))
    const newLots = () => [...lots.values()].filter((lot) => lot.id >= 900)
    return { lots, items, links, lotLocks, movements, newLots }
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('13A + 13B → 13 套（N→1）：两批次各扣 13，套装批次 +13 单价 30，两条来源都关联到套装明细', async () => {
    const fake = fakeDb([
      { id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10' },
      { id: 102, sku_id: 'SKU-B', supply_chain_unit_cost: '20' },
    ])
    const result = await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 13 }, { sourceLotId: 102, quantity: 13 }],
      targets: [{ targetSkuId: 'SKU-SET', quantity: 13, unitPrice: 30 }],
    })
    expect(fake.lots.get(101)!.quantity_on_hand).toBe(87)
    expect(fake.lots.get(102)!.quantity_on_hand).toBe(87)
    const [setLot] = fake.newLots()
    expect(setLot).toMatchObject({ sku_id: 'SKU-SET', quantity_on_hand: 13, supply_chain_unit_cost: '30', is_gift: false })
    expect(setLot.batch_no).toBe(`${result.inboundId}-01`)
    expect(setLot.source_doc_id).toBe(result.inboundId)
    const inbound = fake.items.find((item) => item.docId === result.inboundId)!
    expect(inbound).toMatchObject({ standardUnitPrice: '30', actualUnitPrice: '30' })
    // 出库明细实际单价显式写成本单价（金额由触发器按它计算）
    expect(fake.items.filter((item) => item.docId === result.outboundId).map((item) => item.actualUnitPrice)).toEqual(['10', '20'])
    expect(fake.links).toEqual([
      { relationType: '库存转换', fromItemId: 1, toItemId: inbound.id, quantity: 13 },
      { relationType: '库存转换', fromItemId: 2, toItemId: inbound.id, quantity: 13 },
    ])
  })

  it('同一批次 25 → 12 X + 13 Y：批次扣 25，两个目标批次各 +12 / +13，关联 12 / 13', async () => {
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10', quantity_on_hand: 25 }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 25 }],
      targets: [
        { targetSkuId: 'SKU-X', quantity: 12, unitPrice: 10 },
        { targetSkuId: 'SKU-Y', quantity: 13, unitPrice: 10 },
      ],
    })
    expect(fake.lots.get(101)!.quantity_on_hand).toBe(0)
    expect(fake.newLots().map((lot) => [lot.sku_id, lot.quantity_on_hand, lot.supply_chain_unit_cost])).toEqual([
      ['SKU-X', 12, '10'],
      ['SKU-Y', 13, '10'],
    ])
    expect(fake.links.map((link) => link.quantity)).toEqual([12, 13])
  })

  it('一盒拆三种单件（1→N）：盒子扣 1，三个单件批次各 +1，单价按自填 20/30/40', async () => {
    const fake = fakeDb([{ id: 103, sku_id: 'SKU-BOX', supply_chain_unit_cost: '90', quantity_on_hand: 5 }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 103, quantity: 1 }],
      targets: [
        { targetSkuId: 'SKU-PANTS', quantity: 1, unitPrice: 20 },
        { targetSkuId: 'SKU-BODY', quantity: 1, unitPrice: 30 },
        { targetSkuId: 'SKU-BRA', quantity: 1, unitPrice: 40 },
      ],
    })
    expect(fake.lots.get(103)!.quantity_on_hand).toBe(4)
    expect(fake.newLots().map((lot) => [lot.sku_id, lot.quantity_on_hand, lot.supply_chain_unit_cost])).toEqual([
      ['SKU-PANTS', 1, '20'],
      ['SKU-BODY', 1, '30'],
      ['SKU-BRA', 1, '40'],
    ])
    // 同一来源明细的关联合计 = 1，不超过来源数量（0043 上限）
    expect(fake.links.map((link) => link.quantity)).toEqual([0.34, 0.33, 0.33])
  })

  it('一瓶拆两个半瓶：瓶扣 1、半瓶 +2 单价 25；关联数量记 1（不是 2）', async () => {
    const fake = fakeDb([{ id: 104, sku_id: 'SKU-BOTTLE', supply_chain_unit_cost: '50', quantity_on_hand: 3 }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 104, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-HALF', quantity: 2, unitPrice: 25 }],
    })
    expect(fake.lots.get(104)!.quantity_on_hand).toBe(2)
    expect(fake.newLots().map((lot) => [lot.sku_id, lot.quantity_on_hand, lot.supply_chain_unit_cost])).toEqual([['SKU-HALF', 2, '25']])
    expect(fake.links.map((link) => link.quantity)).toEqual([1])
  })

  it('同一批次分两行出库：按批次汇总校验可用量（可用 10，6 + 5 被拒）', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', quantity_on_hand: 10 }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 6 }, { sourceLotId: 101, quantity: 5 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 11, unitPrice: 10 }],
    })).rejects.toThrow('库存不足')
  })

  it('可用量扣除未完成预留：在手 10、预留 5 时出库 6 被拒', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', quantity_on_hand: 10 }], { 101: 5 })
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 6 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 6, unitPrice: 10 }],
    })).rejects.toThrow('库存不足')
  })

  it('同一批次分两行出库且未超可用量：批次只锁一次，两条流水连续扣减（10 → 4 → 1）', async () => {
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', quantity_on_hand: 10 }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 6 }, { sourceLotId: 101, quantity: 3 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 9, unitPrice: 10 }],
    })
    expect(fake.lotLocks.filter((id) => id === 101)).toHaveLength(1)
    expect(fake.lots.get(101)!.quantity_on_hand).toBe(1)
    // 共用同一快照对象：第二条流水的前值是 4，不是重新读出的 10
    expect(fake.movements.filter((movement) => movement.lotId === 101)).toEqual([
      { lotId: 101, delta: -6, before: 10, after: 4 },
      { lotId: 101, delta: -3, before: 4, after: 1 },
    ])
  })

  it('多批次按 id 升序加锁（与入参顺序无关；防并发主力是全局 cutover 锁，这里是纵深防御）', async () => {
    const fake = fakeDb([
      { id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10' },
      { id: 102, sku_id: 'SKU-B', supply_chain_unit_cost: '20' },
    ])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 102, quantity: 1 }, { sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-SET', quantity: 1, unitPrice: 30 }],
    })
    expect(fake.lotLocks.slice(0, 2)).toEqual([101, 102])
  })

  it('成本不守恒（差额超出分位误差）硬拦截', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10' }, { id: 102, sku_id: 'SKU-B', supply_chain_unit_cost: '20' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 13 }, { sourceLotId: 102, quantity: 13 }],
      targets: [{ targetSkuId: 'SKU-SET', quantity: 13, unitPrice: 31 }],
    })).rejects.toThrow(/INVALID_PARAMS.*成本不守恒.*来源合计 390\.00.*目标合计 403\.00/)
  })

  it('严格 1 分：100 拆 7 件统一按 14.29（差 0.03）被拒；拆分补差 3 件 14.28 + 4 件 14.29 放行', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '100' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 7, unitPrice: 14.29 }],
    })).rejects.toThrow(/成本不守恒.*差额 0\.03 超出允许误差 0\.01/)
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '100' }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 3, unitPrice: 14.28 }, { targetSkuId: 'SKU-X', quantity: 4, unitPrice: 14.29 }],
    })
    expect(fake.newLots().map((lot) => [lot.quantity_on_hand, lot.supply_chain_unit_cost])).toEqual([[3, '14.28'], [4, '14.29']])
  })

  it('赠送与非赠送批次混放被拒', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A' }, { id: 105, sku_id: 'SKU-B', is_gift: true, supply_chain_unit_cost: '0' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }, { sourceLotId: 105, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-SET', quantity: 1, unitPrice: 10 }],
    })).rejects.toThrow('赠送批次与非赠送批次不能混在同一张转换单里')
  })

  it('全赠送来源：目标批次标赠送、单价 0；单价非 0 被拒', async () => {
    const fake = fakeDb([{ id: 105, sku_id: 'SKU-B', is_gift: true, supply_chain_unit_cost: '15' }])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 105, quantity: 2 }],
      targets: [{ targetSkuId: 'SKU-HALF', quantity: 4, unitPrice: 0 }],
    })
    expect(fake.newLots()[0]).toMatchObject({ is_gift: true, supply_chain_unit_cost: '0', quantity_on_hand: 4 })
    // 赠送来源的成本按 0 计，不管批次上残留的历史成本（实际单价与成本快照都记 0）
    expect(fake.items[0].actualUnitPrice).toBe('0')
    expect(fake.items[0].supplyChainUnitCost).toBe('0')

    fakeDb([{ id: 105, sku_id: 'SKU-B', is_gift: true, supply_chain_unit_cost: '0' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 105, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-HALF', quantity: 2, unitPrice: 0.01 }],
    })).rejects.toThrow('赠送批次转换的目标单价必须为 0')
  })

  it('来源批次成本为负：拒绝（负数舍入方向与 PG 不同，守恒失去意义）', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '-0.5' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }],
    })).rejects.toThrow('供应链成本为负数')
  })

  it('来源批次缺少供应链成本：拒绝（无从守恒）', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: null }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }],
    })).rejects.toThrow('来源批次缺少供应链成本')
  })

  it('目标 SKU 与任一来源 SKU 相同被拒', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A' }, { id: 102, sku_id: 'SKU-B' }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }, { sourceLotId: 102, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-B', quantity: 1, unitPrice: 20 }],
    })).rejects.toThrow('目标 SKU 不能与来源 SKU 相同')
  })

  it.each([
    ['来源为空', { sources: [], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }] }, '至少需要一条来源明细'],
    ['目标为空', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [] }, '至少需要一条目标明细'],
    ['单价为负', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: -1 }] }, '转换目标单价不能为空且不能小于 0'],
    ['单价超两位小数', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1.005 }] }, '最多保留两位小数'],
    ['数量为 0', { sources: [{ sourceLotId: 101, quantity: 0 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }] }, '转换出库数量必须大于 0'],
    ['效期格式错', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 10, targetExpiryDate: '2026/10/01' }] }, '目标效期格式应为 YYYY-MM-DD'],
    ['效期不是真实日期', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 10, targetExpiryDate: '2026-02-31' }] }, '目标效期格式应为 YYYY-MM-DD'],
    ['转换日期不是真实日期', { docDate: '2026-02-31', sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '转换日期格式应为 YYYY-MM-DD'],
    ['单价为空串（Number 会当 0）', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: '' }] }, '转换目标单价不能为空且不能小于 0'],
    ['单价为十六进制串', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: '0x10' }] }, '转换目标单价不能为空且不能小于 0'],
    ['数量为科学计数串', { sources: [{ sourceLotId: 101, quantity: '1e2' }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '转换出库数量必须大于 0'],
    ['单价为 false', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: false }] }, '转换目标单价不能为空且不能小于 0'],
    ['单价缺省', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1 }] }, '转换目标单价不能为空且不能小于 0'],
    ['数量超 numeric(12,2) 上界', { sources: [{ sourceLotId: 101, quantity: 1e11 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }] }, '转换出库数量不能超过 9999999999.99'],
    ['来源批次 id 为 true', { sources: [{ sourceLotId: true, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '请选择转换来源批次'],
    ['来源批次 id 为数组', { sources: [{ sourceLotId: [101], quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '请选择转换来源批次'],
    ['来源批次 id 为十六进制串', { sources: [{ sourceLotId: '0x65', quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '请选择转换来源批次'],
    ['来源明细为 null', { sources: [null], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }] }, '库存转换来源明细格式不正确'],
    ['目标 SKU 非字符串', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 123, quantity: 1, unitPrice: 1 }] }, '转换目标 SKU 格式不正确'],
    ['来源数量太少分不到每个目标', { sources: [{ sourceLotId: 101, quantity: 0.01 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }, { targetSkuId: 'SKU-Y', quantity: 1, unitPrice: 0 }] }, '无法分摊到每个目标行'],
    ['目标数量合计超上界', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 9999999999, unitPrice: 0 }, { targetSkuId: 'SKU-Y', quantity: 9999999999, unitPrice: 0 }] }, '目标数量合计不能超过'],
    ['单头备注非字符串', { remark: 123, sources: [{ sourceLotId: 101, quantity: 1 }], targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 }] }, '备注格式不正确'],
    ['关联条数超过 500（30 × 30）', { sources: Array.from({ length: 30 }, (_, index) => ({ sourceLotId: 101 + index, quantity: 1 })), targets: Array.from({ length: 30 }, () => ({ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 })) }, '上限 500'],
    ['目标行超过 100', { sources: [{ sourceLotId: 101, quantity: 1 }], targets: Array.from({ length: 101 }, () => ({ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 0 })) }, '各不能超过 100 行'],
  ])('入参校验：%s（开事务前就拒）', async (_label, body, message) => {
    await expect(createInventoryConversion(SESSION, { locationId: 'HQ', ...body } as never)).rejects.toThrow(message)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('看不到供应链价格的会话：读任何批次之前就 PERMISSION_DENIED（防止拿守恒结果当判定器探成本）', async () => {
    const operatorOnly = {
      employeeId: 'E-SC2', name: '供应链办理员', phone: '13800000013',
      roles: [{
        role: 'custom_supply_chain_operator', scopeId: 'HQ', scopeType: '总部',
        actions: ['inventory:supply_chain_operate'], scopeStoreIds: [], scopeOrgNodeIds: ['HQ'],
      }],
      permissions: { actions: ['inventory:supply_chain_operate'], scopeStoreIds: [] },
    } as never
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '37.5' }])
    // 即便单价恰好守恒也拒：成功与否本身就会泄露成本
    await expect(createInventoryConversion(operatorOnly, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 37.5 }],
    })).rejects.toThrow(/PERMISSION_DENIED.*供应链价格查看权限/)
    expect(fake.lotLocks).toEqual([])
  })

  it('价格可见性按本主体的角色绑定判：绑定 A 在 HQ2 有价格权、绑定 B 在 HQ 只有办理权 → 在 HQ 转换被拒', async () => {
    const binding = (scopeId: string, actions: string[]) => ({
      role: `custom_${scopeId}`, scopeId, scopeType: '总部', actions, scopeStoreIds: [], scopeOrgNodeIds: [scopeId],
    })
    const mixed = {
      employeeId: 'E-SC3', name: '混合绑定', phone: '13800000014',
      roles: [
        binding('HQ2', ['inventory:supply_chain_operate', 'inventory:supply_chain_price_view']),
        binding('HQ', ['inventory:supply_chain_operate']),
      ],
      permissions: { actions: ['inventory:supply_chain_operate', 'inventory:supply_chain_price_view'], scopeStoreIds: [] },
    } as never
    const input = {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }],
    }
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '37.5' }])
    await expect(createInventoryConversion(mixed, input)).rejects.toThrow('PERMISSION_DENIED')
    expect(fake.lotLocks).toEqual([])

    // 对照：价格权绑定就在 HQ 上时照常给出金额
    const priced = { ...(mixed as object), roles: [binding('HQ', ['inventory:supply_chain_operate', 'inventory:supply_chain_price_view'])] } as never
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '37.5' }])
    await expect(createInventoryConversion(priced, input)).rejects.toThrow('来源合计 37.50')
  })

  it('同一主体两条绑定分别持办理权 / 价格权不能拼接：须有一条绑定同时持两权', async () => {
    const binding = (actions: string[]) => ({
      role: `custom_${actions.length}`, scopeId: 'HQ', scopeType: '总部', actions, scopeStoreIds: [], scopeOrgNodeIds: ['HQ'],
    })
    const input = {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 10 }],
    }
    const split = {
      employeeId: 'E-SC4', name: '拆分绑定', phone: '13800000015',
      roles: [binding(['inventory:supply_chain_operate']), binding(['inventory:stock_list', 'inventory:supply_chain_price_view'])],
      permissions: { actions: ['inventory:supply_chain_operate', 'inventory:supply_chain_price_view'], scopeStoreIds: [] },
    } as never
    const fake = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10' }])
    await expect(createInventoryConversion(split, input)).rejects.toThrow('PERMISSION_DENIED')
    expect(fake.lotLocks).toEqual([])

    const single = { ...(split as object), roles: [binding(['inventory:supply_chain_operate', 'inventory:supply_chain_price_view'])] } as never
    const ok = fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '10' }])
    await createInventoryConversion(single, input)
    expect(ok.newLots()).toHaveLength(1)
  })

  it('金额超上限且不守恒：先报金额上限（与表单同序）', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '100000', quantity_on_hand: 200000 }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 100000 }],
      targets: [{ targetSkuId: 'SKU-X', quantity: 100000, unitPrice: 99999 }],
    })).rejects.toThrow('库存转换金额合计超出上限')
  })

  it('拆行放大成本被拒：同一批次（成本 0.50）拆 100 行 0.01，目标 1 件按 1.00', async () => {
    fakeDb([{ id: 101, sku_id: 'SKU-A', supply_chain_unit_cost: '0.5', quantity_on_hand: 1 }])
    await expect(createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: Array.from({ length: 100 }, () => ({ sourceLotId: 101, quantity: 0.01 })),
      targets: [{ targetSkuId: 'SKU-X', quantity: 1, unitPrice: 1 }],
    })).rejects.toThrow(/成本不守恒.*来源合计 0\.50.*目标合计 1\.00/)
  })

  it('目标效期留空取来源批次中最早的效期', async () => {
    const fake = fakeDb([
      { id: 101, sku_id: 'SKU-A', expiry_date: '2027-06-01' },
      { id: 102, sku_id: 'SKU-B', expiry_date: '2027-01-01', supply_chain_unit_cost: '10' },
    ])
    await createInventoryConversion(SESSION, {
      locationId: 'HQ',
      sources: [{ sourceLotId: 101, quantity: 1 }, { sourceLotId: 102, quantity: 1 }],
      targets: [{ targetSkuId: 'SKU-SET', quantity: 1, unitPrice: 20 }],
    })
    expect(fake.newLots()[0].expiry_date).toBe('2027-01-01')
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
 * #236 守护：`insertDocHeader`（business.ts）与 `createInventoryCoreDoc`（engine.ts）
 * 各有一份「同主体单据统一两端」的逻辑。#200 给 engine 那份加了「两端都给且不一致则拒绝」，
 * business 这份当时漏了同步 —— 本测试守护两份不再漂移。
 *
 * ⚠️ 这里只能做**字面量守护**，不能做行为测试：`insertDocHeader` 不是 export，而现存
 * **17** 处调用对同主体单据每次只传 source / target 其一（已逐处核实：两端都传的 7 处 docType
 * 全不在本集合内，含 `createReturnForRestock` —— 它的 docType 只会是「院退货」/「市场退货」），
 * **没有任何公开 API 能构造出两端不一致**。
 * 该断言是防未来新增专用服务复现此坑的前置守卫，其运行时行为规格由 engine.ts 侧的用例承载。
 */
/**
 * ## 这套副本守护的威胁模型（先读这段再改下面任何断言）
 *
 * 它防的是 **无意改坏** 与 **副本不对称漂移**：有人改了 engine 那份忘了 business 那份、
 * 把 guard 挪位置、给集合加删成员、重构时顺手把归一化提前。这类失误在真实 PR 里高频出现，
 * 而两份副本的分歧不会有任何运行时报错（`insertDocHeader` 那侧的行为是「静默吃掉 target」）。
 *
 * 它**不**防对抗性绕过。双谱系评审在七轮里一共给出 17 种绕过，凡是「自然重构就可能触发」的
 * 都已逐条堵掉（`.add(config.xxx)` 式 mutation、整体重赋值、分支前 fast-path return、
 * 初始化阶段折叠、条件 remark 跳过位置规则……）。**仍可绕过的都需要刻意构造**：
 *
 *   - 不可达诱饵（`if (false) { …完整 guard… }`）、块作用域影子声明、对象方法伪造调用
 *     —— 这三类已被「顶层语句 / 顶层声明 / isFunctionLike」三条规则关掉
 *   - **平级尾随诱饵**：`withPermission(action, realImpl, () => {…guard…})`。白名单 + 「实现必须是
 *     最后一个实参」只关掉了「诱饵后面还有非函数实参」的形态；把诱饵放在最后仍可行，
 *     但要同时把两个归属变量声明也抄进诱饵体（否则初始化断言会红）—— 属刻意构造
 *   - 期望快照（成员清单与文案）与源码**同时**修改 —— 任何仓内 golden snapshot 的固有属性
 *   - 「绑定来源」类：`const { sourceOrgNodeId, targetOrgNodeId } = normalize(input)`、
 *     解构默认值、参数默认值 —— 都不产生赋值表达式，不在检测射程内
 *
 * 想要真正抵抗对抗性绕过只有一条路：**行为测试**。而它在这里不可得 ——
 * `insertDocHeader` 未导出，17 个调用点对同主体类型全是单边传参，没有任何公开 API
 * 能构造出「两端都给且不一致」。运行时规格由 engine 侧的既有用例承载
 * （`engine.test.ts` 的「分院库存盘点 + ORG-S1/ORG-S2 → 出库主体与入库主体必须是同一个」）。
 *
 * 结论：在这个威胁模型下继续加固正则/AST 的边际收益已经很低，**不要**为了再堵一种刻意构造
 * 而把断言写得更复杂 —— 那会增加误红、降低可读性，却挡不住真想绕的人。
 * 真要提高保障等级，正确的动作是让 `insertDocHeader` 可测（导出或抽纯函数），而不是加断言。
 *
 * ---
 *
 * 副本守护改用 **AST 语义分析**，不再做文本/正则匹配。
 *
 * 前两版都是正则：剥注释 → 切函数体 → 匹配字面量。两个谱系在两轮里一共给出 10 种绕过，
 * 每补一条正则下一轮又能找到新的（复合赋值、解构、括号赋值、跨行、字符串诱饵、
 * 把整段成员塞进块注释使数组为空……）。最后一根稻草是 codex 第 2 轮的这条：
 *
 *     const INTERNAL_SAME_NODE_DOC_TYPES = new Set<InventoryDocType>([
 *       // 全部成员被整体注释掉
 *     ])
 *
 * 空数组里的注释**不属于任何节点的 leading/trailing comment range**，剥不掉；
 * 而文本匹配照样能从注释里抠出全部成员 → 运行时集合为空而守护全绿（静默放行）。
 *
 * 结论是：这件事本来就该用 AST 做。下面所有断言都基于解析后的节点 ——
 * 注释、字符串字面量里的诱饵、排版与换行一概不影响，语义变了才会红。
 */
function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file, readFileSync(resolve(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true,
  )
}

/** 取顶层函数体。支持 `async function f()` 与 `export const f = HOF(…, async (…) => {…})` 两种形态 */
function functionBodyNode(sf: ts.SourceFile, fnName: string): ts.Block {
  let found: ts.Block | undefined

  /**
   * HOF 形态取**调用实参里最后一个函数**，这是 `withPermission(action, impl)` /
   * `withAnyPermission(actions, impl)` 这类包装器的固定惯例。
   *
   * 试过两版都不行：深度优先第一个会拿到 `withAnyPermission(() => perms, impl)` 的权限回调；
   * 按 `parameters.length` 降序在同参数数时退化为源码顺序，前面放个同参诱饵就能骗过（codex）。
   * 只看**顶层实参**、不递归进子表达式，诱饵就没有落脚点。
   */
  const KNOWN_WRAPPERS = new Set(['withPermission', 'withAnyPermission', 'withAllPermissions'])
  const pickImplementation = (node: ts.Node): ts.Block | undefined => {
    if (!ts.isCallExpression(node)) {
      // 直接 `const f = async (…) => {…}` 的形态
      return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body
        && ts.isBlock(node.body) ? node.body : undefined
    }
    /**
     * 只认白名单 wrapper，且实现必须是**最后一个实参**（不限类型）。
     *
     * 「最后一个**函数**实参」会被**平级尾随**诱饵重定向（GLM 第 2 轮）：
     *     withPermission(action, realImpl, () => { …完整 guard 文本… })   // 伪装成 telemetry 回调
     * 三个检查全在诱饵体上通过，真实 impl 摘掉 guard 后照样全绿。
     * ⚠️ 这只关掉了「诱饵后面还有非函数实参」的形态。把诱饵放在**最后**仍然可行 ——
     * 但那需要同时把两个归属变量的声明也抄进诱饵体，否则初始化断言会红，属刻意构造
     * （GLM 纠正了我这里原本「天然成立/已闭环」的错误措辞）。
     * 超出白名单的 wrapper 直接返回 undefined → 测试报「未找到函数」（红方向安全）。
     */
    if (!KNOWN_WRAPPERS.has(node.expression.getText())) return undefined
    const last = node.arguments[node.arguments.length - 1]
    if (!last || !(ts.isArrowFunction(last) || ts.isFunctionExpression(last))) return undefined
    return last.body && ts.isBlock(last.body) ? last.body : undefined
  }

  /**
   * 只看**文件顶层声明**，不递归进任意作用域 —— 否则目标之前若有同名的嵌套函数/变量，
   * 会选中那个影子声明，后续所有「顶层语句」检查实际检查的是诱饵函数（codex 第 4 轮 P3）。
   */
  for (const st of sf.statements) {
    if (found) break
    if (ts.isFunctionDeclaration(st) && st.name?.text === fnName && st.body) {
      found = st.body
      break
    }
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === fnName && decl.initializer) {
          found = pickImplementation(decl.initializer)
          if (found) break
        }
      }
    }
  }
  expect(found, `${sf.fileName} 未找到函数 ${fnName}`).toBeTruthy()
  return found!
}

/**
 * 在函数体的**顶层语句序列**里找目标节点，不递归进嵌套函数、也不钻进别的语句内部。
 *
 * ⚠️ 无边界递归会被**不可达诱饵**骗过（codex 第 3 轮实测）：
 *     if (false) { if (INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)) { …完整 guard… } }
 * 真正的分支即便被整个删除，这段永不执行的代码仍能让断言全绿 —— 静默放行。
 * 目标结构本来就是函数体的直接语句，限定在顶层既更准确也堵掉了诱饵的落脚点。
 */
function topLevelStatements(body: ts.Block): ts.Statement[] {
  return Array.from(body.statements)
}

/** 找顶层的 `if (INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)) { … }` */
function sameNodeIfStatement(body: ts.Block): ts.IfStatement {
  const hit = topLevelStatements(body).find(
    (st): st is ts.IfStatement => ts.isIfStatement(st)
      && st.expression.getText().replace(/\s+/g, '')
        === 'INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType)',
  )
  expect(hit, '未在函数体顶层找到 INTERNAL_SAME_NODE 分支').toBeTruthy()
  return hit!
}

/**
 * 分支体的**第一条语句**必须就是一致性断言，且它的 then 里真的 throw。
 * 返回错误文案（供两份副本比对）；形状不符返回 null。
 *
 * 逐层核对 if 的条件、then 的内容与 throw 的实参 —— 不是「函数里某处有这段文本」。
 * 老写法把「首行文本」与「函数里存在完整 guard」当成两次不相干的匹配，
 * 于是可以先放一个条件相同但**空体**的 if、再归一化、再摆一个永不触发的完整 guard，三测全绿。
 */
function firstStatementGuardMessage(ifStmt: ts.IfStatement): string | null {
  const then = ifStmt.thenStatement
  if (!ts.isBlock(then) || then.statements.length === 0) return null
  const first = then.statements[0]
  if (!ts.isIfStatement(first)) return null

  const cond = first.expression.getText().replace(/\s+/g, '')
  if (cond !== 'sourceOrgNodeId&&targetOrgNodeId&&sourceOrgNodeId!==targetOrgNodeId') return null

  /**
   * throw 必须是冲突分支的**直接**子语句。递归查找会被不可达子分支骗过（codex 第 4 轮）：
   *     if (source && target && source !== target) {
   *       if (source === target) { throw … }     // 条件互斥，永不执行
   *     }
   */
  const inner = first.thenStatement
  const direct = ts.isBlock(inner) ? Array.from(inner.statements) : [inner]
  /**
   * throw 必须是冲突分支的**第一条**直接子语句 —— 与 SPECIALIZED 分支同一条规则。
   * 「直接子语句里某处有 throw」还不够（codex 第 5 轮）：在它前面插一句
   * `if (input.status) return`，冲突输入就不会执行到 throw，而文案比较照样通过。
   */
  const st = direct[0]
  if (!st || !ts.isThrowStatement(st) || !st.expression || !ts.isNewExpression(st.expression)) return null
  const args = st.expression.arguments ?? []
  if (st.expression.expression.getText() === 'ApiError'
      && args.length >= 2
      && ts.isStringLiteral(args[0]) && args[0].text === 'INVALID_PARAMS'
      && ts.isStringLiteral(args[1])) {
    return (args[1] as ts.StringLiteral).text
  }
  return null
}

/**
 * 从函数入口到给定位置之间，收集所有**对归属变量的赋值**（初始化不算）。
 *
 * AST 天然覆盖 `=` / `||=` / `??=` / `&&=` / `+=`、解构（数组与对象、含多行与括号包裹）、
 * 以及 `input.targetOrgNodeId = …` 这种对入参属性的污染 —— 正则版为此补了三轮仍有漏网。
 */
function ownershipAssignmentsBefore(body: ts.Block, beforePos: number): string[] {
  const NAMES = new Set(['sourceOrgNodeId', 'targetOrgNodeId'])
  const hits: string[] = []

  const namesInTarget = (target: ts.Node): string[] => {
    const out = new Set<string>()
    const dig = (n: ts.Node) => {
      // PropertyAccess 先记一次再下降到 name Identifier 会重复记（只影响报错噪声），用 Set 去重
      if (ts.isPropertyAccessExpression(n)) {
        if (NAMES.has(n.name.text)) out.add(n.name.text)
        ts.forEachChild(n.expression, dig)
        return
      }
      if (ts.isIdentifier(n) && NAMES.has(n.text)) out.add(n.text)
      ts.forEachChild(n, dig)
    }
    dig(target)
    return [...out]
  }

  const visit = (n: ts.Node) => {
    if (n.getStart() >= beforePos) return
    // 不进入嵌套函数体：未被调用的回调里的赋值不该算（codex P3 的误红）。
    // 用 `isFunctionLike` 覆盖全部函数边界（含 MethodDeclaration、访问器）——
    // 只列三种节点会漏掉对象方法（codex 第 5 轮）。
    //
    // ⚠️ 已知上限是「**绑定来源**」而非只有「赋值」（GLM 第 2 轮纠正了措辞）：
    // `const { sourceOrgNodeId, targetOrgNodeId } = normalize(input)`（归一化发生在 helper 体内）、
    // 解构默认值、参数默认值取值，这些都不产生赋值表达式因而一律不可见。
    // 另有 guard 之前的 IIFE / 前置调用里的赋值也会漏。这类写法都该在人工评审里被拦。
    if (ts.isFunctionLike(n)) return
    // `for (targetOrgNodeId of [...])` —— 循环变量就是赋值目标，不是 BinaryExpression（codex 第 4 轮）
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      for (const name of namesInTarget(n.initializer)) hits.push(`${name} (for-loop target)`)
    }
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      for (const name of namesInTarget(n.left)) hits.push(`${name} ${n.operatorToken.getText()}`)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(body, visit)
  return hits
}

/** 读 `const X = new Set([...])` 的字符串成员（AST，注释里的字符串自然不算） */
function setMembers(sf: ts.SourceFile, varName: string): string[] {
  let members: string[] | undefined
  /**
   * 只看**文件顶层声明**。递归会先取到块作用域里的同名影子声明（codex 第 5 轮）：
   *     { const SPECIALIZED_DOC_TYPES = new Set([]) ; void SPECIALIZED_DOC_TYPES }
   *     const SPECIALIZED_DOC_TYPES = new Set([… '内部领用' …])   // 真实声明，已与 GENERIC 重叠
   * 遍历拿到影子的空数组就停了，互斥断言全绿而运行时集合已经重叠。
   */
  const visit = (n: ts.Node) => {
    if (members) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === varName
        && n.initializer && ts.isNewExpression(n.initializer)
        && n.initializer.expression.getText() === 'Set') {
      const arg = n.initializer.arguments?.[0]
      if (arg && ts.isArrayLiteralExpression(arg)) {
        // 非字符串字面量元素（展开项 `...extra`、计算项）必须**直接失败**而不是被过滤掉 ——
        // 否则往 SPECIALIZED 里塞一个含通用类型的 `...extra`，互斥断言照样绿（codex 第 4 轮）
        const nonLiteral = arg.elements.filter((e) => !ts.isStringLiteral(e))
        expect(
          nonLiteral.map((e) => e.getText()),
          `${varName} 含非字符串字面量元素，字面量守护无法覆盖它`,
        ).toEqual([])
        members = arg.elements.filter(ts.isStringLiteral).map((e) => e.text)
      }
    }
  }
  for (const st of sf.statements) {
    if (members) break
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) visit(decl)
    }
  }
  expect(members, `${sf.fileName} 未在文件顶层找到 ${varName} 的 Set 初始化`).toBeTruthy()
  return [...members!].sort()
}

const BUSINESS_TS = 'src/lib/inventory/business.ts'
const ENGINE_TS = 'src/lib/inventory/engine.ts'
/** 两份副本各自承载同主体归一化逻辑的函数 */
const SAME_NODE_HOSTS: Array<[string, string]> = [
  [BUSINESS_TS, 'insertDocHeader'],
  [ENGINE_TS, 'createInventoryCoreDoc'],
]

/**
 * 同主体单据的 12 项**期望成员快照**。
 *
 * 只比对两份副本「相等」是不够的：两端**同时**把某项换成另一个合法的 InventoryDocType
 * 仍然相等。这份显式清单才是语义 oracle，两份副本各自与它比对。
 * 标了 `InventoryDocType[]` 类型 —— 写错别字在 tsc 阶段就红，比测试期更早。
 *
 * ⚠️ 增删成员必须同时改源码两份 + 本快照，且应在 PR 里说明理由。
 */
/** 同主体一致性断言的期望文案（两份副本共用的显式 oracle） */
const EXPECTED_SAME_NODE_MESSAGE = '该单据的出库主体与入库主体必须是同一个'

const EXPECTED_INTERNAL_SAME_NODE: InventoryDocType[] = [
  '分院库存盘点', '供应链员工购出库', '内部领用', '员工购出库',
  '品项公司报货需求', '库存转换入库', '库存转换出库', '市场产品报损',
  '市场产品盘溢', '市场库存盘点', '期初库存', '院产品报损',
]

describe('insertDocHeader 同主体两端一致断言与 engine.ts 字面一致（副本守护）', () => {
  it('两份副本的断言都是同主体分支首条语句，且错误文案等于期望值', () => {
    const messages = SAME_NODE_HOSTS.map(([file, fn]) => {
      const sf = parseFile(file)
      const ifStmt = sameNodeIfStatement(functionBodyNode(sf, fn))
      const msg = firstStatementGuardMessage(ifStmt)
      expect(msg, `${file}#${fn} 的同主体分支首条语句不是「两端不一致则抛 INVALID_PARAMS」`).toBeTruthy()
      return msg
    })
    // 两两比对之外还要对一份显式 oracle —— 否则两份同改文案仍全绿，
    // 与 EXPECTED_INTERNAL_SAME_NODE 的立项理由（「相等 ≠ 正确」）同构（GLM 第 3 轮 P3）
    expect(messages[0]).toBe(EXPECTED_SAME_NODE_MESSAGE)
    expect(messages[1]).toBe(EXPECTED_SAME_NODE_MESSAGE)
  })

  /**
   * 函数入口 → 同主体分支之间不许有任何对归属变量的赋值（初始化除外）。
   *
   * 少了这条，在分支**之前**插一句等价归一化（`target = source` / `target ||= source` /
   * 解构 / 污染 `input.targetOrgNodeId`）就能让断言永不成立，而 guard 文本还在、位置也还对。
   */
  it('两份副本在进入同主体分支前都没有抢先归一化归属变量', () => {
    for (const [file, fn] of SAME_NODE_HOSTS) {
      const sf = parseFile(file)
      const body = functionBodyNode(sf, fn)
      const ifStmt = sameNodeIfStatement(body)
      expect(
        ownershipAssignmentsBefore(body, ifStmt.getStart()),
        `${file}#${fn} 在进入同主体分支前改写了归属变量，断言会永不成立`,
      ).toEqual([])

      /**
       * 控制流的等价物：分支之前**不得有成功提前返回**（GLM 第 3 轮 P1）。
       *
       * 「抢先归一化」堵的是数据流，而加 fast path / legacy 委托是高频真实 PR：
       *     if (input.docType === '库存转换出库' && input.fromConversion) {
       *       return await legacyConvertInsert(input)     // 该子集永远走不到同主体 guard
       *     }
       * 文字没动、执行位置后移，五条断言全绿 —— 而且典型形态是只改一份，
       * 正是「副本不对称漂移」的核心场景。
       * `throw` 不禁：它是安全方向（操作失败、无静默写入）。
       * 实测两份副本当前分支前各有 4 / 10 条语句、**零** return，可以直接钉死。
       */
      const returnsBefore: string[] = []
      for (const st of topLevelStatements(body)) {
        if (st.getStart() >= ifStmt.getStart()) break
        const scan = (n: ts.Node) => {
          if (ts.isFunctionLike(n)) return
          if (ts.isReturnStatement(n)) returnsBefore.push(st.getText().slice(0, 60).replace(/\n/g, ' '))
          ts.forEachChild(n, scan)
        }
        scan(st)
      }
      expect(returnsBefore, `${file}#${fn} 在同主体分支之前有提前返回，该子集永远走不到一致性断言`)
        .toEqual([])
    }
  })

  /**
   * 归一化也可以**不用赋值**就完成 —— 直接写进初始化表达式（codex 第 6 轮）：
   *
   *     let targetOrgNodeId = INTERNAL_SAME_NODE_DOC_TYPES.has(input.docType) && sourceOrgNodeId
   *       ? sourceOrgNodeId : (target?.orgNodeId ?? null)
   *
   * 没有任何赋值表达式，`ownershipAssignmentsBefore` 返回空、guard 与集合都没变，
   * 而同主体类型传两个不同主体时 target 已被折叠成 source，冲突 guard 永不触发。
   * 对策：两个变量的初始化表达式里不得互相引用。
   */
  it('两个归属变量的初始化表达式不得互相引用（防在初始化阶段就折叠）', () => {
    for (const [file, fn] of SAME_NODE_HOSTS) {
      const body = functionBodyNode(parseFile(file), fn)
      const inits = new Map<string, ts.Expression>()
      for (const st of topLevelStatements(body)) {
        if (!ts.isVariableStatement(st)) continue
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer
              && (decl.name.text === 'sourceOrgNodeId' || decl.name.text === 'targetOrgNodeId')) {
            inits.set(decl.name.text, decl.initializer)
          }
        }
      }
      expect(inits.size, `${file}#${fn} 未找到两个归属变量的初始化`).toBe(2)

      for (const [name, init] of inits) {
        const other = name === 'sourceOrgNodeId' ? 'targetOrgNodeId' : 'sourceOrgNodeId'
        let refersOther = false
        const scan = (n: ts.Node) => {
          if (ts.isIdentifier(n) && n.text === other) refersOther = true
          ts.forEachChild(n, scan)
        }
        scan(init)
        expect(refersOther, `${file}#${fn} 的 ${name} 初始化里引用了 ${other}，可能在初始化阶段就折叠了两端`)
          .toBe(false)
      }
    }
  })

  /**
   * 守了断言，还得守它**依赖的集合**。两份 `INTERNAL_SAME_NODE_DOC_TYPES` 是独立副本
   * （项目禁止抽取跨端共享目录）。给 engine 那份加类型却漏了 business 那份 →
   * business 对该类型退回「静默吃掉 target」的老行为，而上面两条守护照样全绿。
   */
  /**
   * 字面量快照只看 `new Set([...])` 的**初始**成员，对声明后的 mutation 全盲（GLM 第 2 轮 P1）。
   *
   * 这条与其它「必须刻意构造」的绕过不同 —— 它有**自然的非对抗性触发路径**：
   * 「改成可配置 / 动态追加」式重构就是一行 `INTERNAL_SAME_NODE_DOC_TYPES.add(config.xxx)`，
   * 不产生任何赋值表达式、不改字面量，三个 describe 全绿而运行时集合已与 12 项 oracle 脱钩。
   * 所以它落在本守护的威胁模型**之内**，必须堵。
   */
  it('受守护集合都是 const 且无声明后 mutation（方法调用 / 整体重赋值）', () => {
    /**
     * 「改成可配置」式重构有三种自然形态，三条都要堵：
     *   ① `X.add(config.xxx)` / `.delete()` / `.clear()`  —— 方法调用
     *   ② `let X = …; X = new Set([...])`                  —— 整体重赋值（GLM 第 3 轮 P2）
     *   ③ `new Set([...BASE, ...cfg])`                     —— 已由「非字符串字面量元素直接失败」拦住
     * 字面量快照只读声明处的初始成员，①②都不改字面量、不进赋值检测的射程。
     *
     * `SYSTEM_DERIVED_DOC_TYPES` 也在守护范围内（codex 第 3 轮）：它与 SPECIALIZED 一样
     * 在位置规则调用之前拒绝单据，把某个通用类型加进它却忘了同步删白名单和 switch case，
     * 那个 case 就重新变成 dead code —— 正是 #237 的根因。
     */
    const GUARDED = [
      'INTERNAL_SAME_NODE_DOC_TYPES', 'SPECIALIZED_DOC_TYPES', 'SYSTEM_DERIVED_DOC_TYPES',
    ]
    const MUTATORS = new Set(['add', 'delete', 'clear'])
    for (const file of [BUSINESS_TS, ENGINE_TS]) {
      const sf = parseFile(file)
      const found: string[] = []
      const visit = (n: ts.Node) => {
        // ① 方法调用
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
            && ts.isIdentifier(n.expression.expression)
            && GUARDED.includes(n.expression.expression.text)
            && MUTATORS.has(n.expression.name.text)) {
          found.push(`${n.expression.expression.text}.${n.expression.name.text}()`)
        }
        // ② 整体重赋值
        if (ts.isBinaryExpression(n)
            && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && ts.isIdentifier(n.left) && GUARDED.includes(n.left.text)) {
          found.push(`${n.left.text} ${n.operatorToken.getText()} …`)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
      expect(found, `${file} 对受守护集合做了声明后 mutation —— 字面量快照对它全盲`).toEqual([])

      // 并且声明必须是 const（让 ② 在编译期就不可能）
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && GUARDED.includes(decl.name.text)) {
            expect(
              (st.declarationList.flags & ts.NodeFlags.Const) !== 0,
              `${file} 的 ${decl.name.text} 不是 const 声明`,
            ).toBe(true)
          }
        }
      }
    }
  })

  /**
   * **互斥 ≠ 覆盖**（GLM 第 4 轮 P3-1）：如果只有互斥断言，新增一个 `InventoryDocType`
   * 枚举值而不把它放进任何受守护集合时，所有断言仍绿。「加枚举值」是最高频的正常重构，
   * 所以必须钉住那条兜住它的闸门 —— `createInventoryCoreDoc` 里的**正向白名单**：
   *
   *     if (!(INVENTORY_GENERIC_DOC_TYPES as readonly string[]).includes(input.docType)) {
   *       throw new ApiError('INVALID_STATE', '该库存单据不支持通用建单')
   *     }
   *
   * 有它在，未登记的新类型根本走不到同主体分支（而不是「走到了但静默吃掉 target」）。
   * 这条断言要求它存在、是顶层语句、且排在同主体分支之前。
   *
   * business.ts 那侧不需要同类闸门：`insertDocHeader` 的 docType 由 17 个专用服务硬编码传入，
   * 新增枚举值不会自动出现在任何调用点。
   */
  it('createInventoryCoreDoc 有 GENERIC 正向白名单闸门，且早于同主体分支', () => {
    const sf = parseFile(ENGINE_TS)
    const body = functionBodyNode(sf, 'createInventoryCoreDoc')
    const gate = topLevelStatements(body).find(
      (st): st is ts.IfStatement => ts.isIfStatement(st)
        && st.expression.getText().includes('INVENTORY_GENERIC_DOC_TYPES')
        && st.expression.getText().includes('!'),
    )
    expect(gate, 'createInventoryCoreDoc 缺少「不在通用白名单即拒」的正向闸门 —— 未登记的新 docType 会漏进来')
      .toBeTruthy()
    const gateThrow = ts.isBlock(gate!.thenStatement)
      ? gate!.thenStatement.statements[0]
      : gate!.thenStatement
    expect(gateThrow && ts.isThrowStatement(gateThrow), '正向闸门的第一条语句不是 throw').toBe(true)
    expect(gate!.getStart(), '正向闸门排在同主体分支之后，未登记类型会先走到归一化逻辑')
      .toBeLessThan(sameNodeIfStatement(body).getStart())
  })

  /**
   * 所有「位置规则调用之前就拒绝」的集合都必须与通用白名单互斥 —— 不只 SPECIALIZED。
   * 见上一条注释里 codex 第 3 轮的场景。
   */
  it('所有前置拒绝集合都与 INVENTORY_GENERIC 互斥', () => {
    const sf = parseFile(ENGINE_TS)
    for (const name of ['SPECIALIZED_DOC_TYPES', 'SYSTEM_DERIVED_DOC_TYPES']) {
      const rejected = new Set(setMembers(sf, name))
      const overlap = (INVENTORY_GENERIC_DOC_TYPES as readonly string[]).filter((t) => rejected.has(t))
      expect(overlap, `${name} 与通用类型白名单重叠 —— 对应 switch case 会变成 dead code`).toEqual([])
    }
  })

  it('两份 INTERNAL_SAME_NODE_DOC_TYPES 都等于期望成员快照', () => {
    const expected = [...EXPECTED_INTERNAL_SAME_NODE].sort()
    expect(setMembers(parseFile(BUSINESS_TS), 'INTERNAL_SAME_NODE_DOC_TYPES')).toEqual(expected)
    expect(setMembers(parseFile(ENGINE_TS), 'INTERNAL_SAME_NODE_DOC_TYPES')).toEqual(expected)
  })
})

/**
 * #237 守护：`assertGenericDocLocationRules` 的 case 集合必须与
 * `INVENTORY_GENERIC_DOC_TYPES` 一一对应。写进去的专用类型（SPECIALIZED）永远不可达 ——
 * 唯一调用点 `createInventoryCoreDoc` 在更靠前处已把它们整体拒了 —— 但会诱导后来者
 * （人或评审 agent）把它当活代码推理。#200 的评审里就因此产生过一条误报 P2。
 */
describe('assertGenericDocLocationRules 的 case 与通用类型白名单一一对应（#237）', () => {
  it('不含任何 SPECIALIZED 类型的 case，且覆盖全部通用类型', () => {
    const sf = parseFile(ENGINE_TS)
    const body = functionBodyNode(sf, 'assertGenericDocLocationRules')
    // 顶层语句序列里找，不递归 —— 否则 `if (false) { switch … }` 这种诱饵能骗过（codex 第 3 轮）
    const switchStmt = topLevelStatements(body).find(
      (st): st is ts.SwitchStatement =>
        ts.isSwitchStatement(st) && st.expression.getText() === 'input.docType',
    )
    expect(switchStmt, '未在函数体顶层找到 switch (input.docType)').toBeTruthy()

    // 只取活的 CaseClause —— 注释掉的 case 不在 AST 里
    const cases = switchStmt!.caseBlock.clauses
      .filter(ts.isCaseClause)
      .map((c) => (ts.isStringLiteral(c.expression) ? c.expression.text : c.expression.getText()))
    expect(new Set(cases).size, 'case 有重复').toBe(cases.length)
    expect(new Set(cases)).toEqual(new Set(INVENTORY_GENERIC_DOC_TYPES))
  })

  /**
   * 集合相等有个误放行窗口：某类型若**同时**进 SPECIALIZED 与 GENERIC，
   * `createInventoryCoreDoc` 仍会先一步拒掉它、它的 case 重新变 dead，而测试全绿。
   * 这条互斥断言更直接命中 #237 的根因（dead case 的来源就是集合归属搞混）。
   */
  it('SPECIALIZED 与 INVENTORY_GENERIC 两个集合互斥', () => {
    const specialized = new Set(setMembers(parseFile(ENGINE_TS), 'SPECIALIZED_DOC_TYPES'))
    const overlap = (INVENTORY_GENERIC_DOC_TYPES as readonly string[]).filter((t) => specialized.has(t))
    expect(overlap, '通用类型白名单里混进了专用类型').toEqual([])
  })

  /**
   * 删掉 dead case 的**正确性前提**也得钉住：「唯一调用点在更靠前处**无条件**拒了 SPECIALIZED」。
   *
   * 三件事都要验，少一件就能假通过（codex 第 2 轮给了反例）：
   * ① 那个 if 的 then 里**直接**有 throw —— 不是嵌在 `if (flag)` 里的条件 throw；
   * ② throw 之前不能先调用 assertGenericDocLocationRules（否则「拒绝早于调用」是假的）；
   * ③ 比的是 **throw 的位置**，不是 if 的起点。
   */
  it('createInventoryCoreDoc 对 SPECIALIZED 的拒绝是无条件的、且早于通用位置规则调用', () => {
    const sf = parseFile(ENGINE_TS)
    const body = functionBodyNode(sf, 'createInventoryCoreDoc')

    // 拒绝分支必须是**顶层**语句（`if (false) { … }` 之类的不可达诱饵不算）
    const rejectIf = topLevelStatements(body).find(
      (st): st is ts.IfStatement => ts.isIfStatement(st)
        && st.expression.getText().replace(/\s+/g, '') === 'SPECIALIZED_DOC_TYPES.has(input.docType)',
    )
    /**
     * 调用位置只认**函数体顶层语句**里的那次（当前形态是 `await assertGenericDocLocationRules(…)`
     * 这条 ExpressionStatement）。
     *
     * ⚠️ 不能「任意深度搜索」：删掉真实调用后写
     *     const decoy = () => assertGenericDocLocationRules(…); void decoy
     * 会让 callPos 仍是有限值且排在拒绝之后，而运行时**从未调用**规则函数（codex 第 4 轮）。
     * 跨函数边界的调用不算。
     */
    /**
     * 调用必须是函数体的**顶层 ExpressionStatement**，且只解包 `await` 与括号 ——
     * 不钻进 `if`、逻辑表达式等控制结构。
     *
     * 「顶层语句内任意非函数子节点」还不够（codex 第 6 轮，这条有真实安全含义）：
     *     if (input.remark !== '__skip_location_rules__') {
     *       await assertGenericDocLocationRules(…)
     *     }
     * callPos 仍有限且排在拒绝之后、结构测试全绿，但调用方传那个 remark 就能跳过
     * 「必须为总部」之类的位置规则 —— 等于给生产代码留了后门。
     */
    const unwrap = (e: ts.Expression): ts.Expression => {
      let cur = e
      while (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression
      return cur
    }
    const callPos = topLevelStatements(body).reduce((min, st) => {
      if (!ts.isExpressionStatement(st)) return min
      const expr = unwrap(st.expression)
      if (ts.isCallExpression(expr) && expr.expression.getText() === 'assertGenericDocLocationRules') {
        return Math.min(min, expr.getStart())
      }
      return min
    }, Infinity)

    expect(rejectIf, 'createInventoryCoreDoc 顶层不再无条件拒绝 SPECIALIZED 类型').toBeTruthy()
    expect(callPos, '未找到 assertGenericDocLocationRules 调用').toBeLessThan(Infinity)

    /**
     * ① throw 必须是该分支的**第一条**语句。
     *
     * 「分支里某处有直接 throw」还不够（codex 第 4 轮）：在它前面插一句条件
     * `if (…) return { success: true, … }`，部分 SPECIALIZED 单据就绕过了拒绝，而断言仍绿。
     * 要求它是第一条，就不存在「throw 之前的退出路径」。
     */
    const then = rejectIf!.thenStatement
    const directStatements = ts.isBlock(then) ? Array.from(then.statements) : [then]
    const throwStmt = directStatements[0]
    expect(
      throwStmt && ts.isThrowStatement(throwStmt),
      'SPECIALIZED 分支的第一条语句不是 throw（前面存在其它语句就可能有提前退出路径）',
    ).toBe(true)

    // ② 比 throw 的位置，不是 if 的起点
    expect(throwStmt.getStart(), 'SPECIALIZED 拒绝被挪到了通用位置规则之后，dead case 的删除前提失效')
      .toBeLessThan(callPos)
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
   * 在已确认是 SQL 的区间里按 SQL 词法就地遮罩：行注释、块注释与字符串字面量内容。
   * 字符串定界符两种形态都要认：模板串里是 `'`，宿主单引号串里是转义过的 `\'`（占 2 字符）。
   * 只遮内容、保留定界符与长度，位置不变（「WITH 头自一致性」按下标核对，必须保长度）。
   */
  function maskSqlSpan(out: string[], from: number, to: number, blank: (a: number, b: number) => void): void {
    const at = (k: number) => out.slice(k, k + 2).join('')
    let k = from
    while (k < to) {
      // 宿主串里 SQL 的换行是 2 字符的转义序列 `\\n`，必须等长遮成空白：
      // 留着的话那个 `n` 是单词字符，`SELECT -- 说明\\nd.path` 会变成 `nd.path`，
      // 下游的 `\\bd\\.` 边界匹配不上 → 静默漏报。换行本来就是空白，遮掉语义也对。
      if (at(k) === '\\n') { blank(k, k + 2); k += 2; continue }
      if (at(k) === '--') {
        // 行尾有两种形态：模板串里是真换行 `\n`（1 字符），
        // 宿主单引号串里 SQL 的换行只能写成转义序列 `\\n`（2 字符）——
        // 只认真换行的话，宿主串里的 `--` 注释会一路遮到串尾，把后面的混用静默吃掉。
        let e = k
        while (e < to && out[e] !== '\n' && at(e) !== '\\n') e += 1
        blank(k, e); k = e; continue
      }
      if (at(k) === '/*') {
        let e = k + 2
        while (e < to && at(e) !== '*/') e += 1
        blank(k, Math.min(e + 2, to)); k = Math.min(e + 2, to); continue
      }
      const esc = at(k) === "\\'"
      if (esc || out[k] === "'") {
        const w = esc ? 2 : 1
        let e = k + w
        while (e < to) {
          const closeEsc = at(e) === "\\'"
          if ((esc && closeEsc) || (!esc && out[e] === "'")) break
          e += closeEsc ? 2 : 1
        }
        blank(k + w, e)           // 只抹内容，定界符留着
        k = Math.min(e + w, to); continue
      }
      k += 1
    }
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
      // 单引号有两种截然相反的身份，只能按内容判：
      // - `pg.query('WITH RECURSIVE …')` —— 引号里就是要检查的 SQL，抹掉等于整段丢失
      // - `SELECT 'https://x'` / `'a--b'` —— 引号里是数据，不抹的话里面的
      //   `//` `--` `/*` 会被当成注释起点，把后面的真 SQL 一路吞掉（假阴性）
      // 判据：内容里有没有 CTE 头。有就当 SQL 留着，没有就当数据抹掉。
      if (src[i] === "'") {
        let j = i + 1
        while (j < src.length && src[j] !== "'") j += (src[j] === '\\' ? 2 : 1)
        const inner = src.slice(i + 1, j)
        if (/\bWITH\s+(?:RECURSIVE\s+)?[A-Za-z_]\w*\s*(?:\([^()]*\))?\s+AS\s*\(/i.test(inner)) {
          // 是 SQL：内容保留，但要按 **SQL 词法**就地遮一遍（注释 + SQL 字符串字面量）。
          // 不能整段跳过不遮 —— 里面的 `\')\'`（SQL 数据里的右括号）会提前截断 CTE 体（静默漏报）、
          // `-- … d.path` 这类注释又会对合法 SQL 假红。
          // 也不能只 i += 1 重新过宿主扫描器 —— 转义的 \' 会被当成新宿主字符串的起点。
          maskSqlSpan(out, i + 1, j, blank)
          i = j + 1
        } else {
          blank(i, j + 1); i = j + 1
        }
        continue
      }
      // 反引号不抹：.ts/.js 里 SQL 正写在模板字符串里，抹掉等于把要检查的 SQL 整段抹掉
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

  /**
   * CTE 定义头：`WITH [RECURSIVE] name [(cols)] AS (` 与并列的 `), name [(cols)] AS (`。
   * cteBlocks 与「WITH 头自一致性」断言**共用这一份** —— 两边口径必须完全一致，
   * 否则比较出来的差值没有意义（见 unrecognizedWithHeads 的注释）。
   */
  const CTE_HEAD_RE = /(?:\bWITH\s+(?:RECURSIVE\s+)?|[),]\s*)([A-Za-z_]\w*)\s*(?:\([^()]*\))?\s+AS\s*\(/gi

  /** 每个 CTE 的定义体（`name [(cols)] AS ( … )` 括号内），外加末尾的「非 CTE 体」残余文本 */
  function cteBlocks(masked: string): { blocks: Array<{ name: string; body: string }>; outside: string } {
    const blocks: Array<{ name: string; body: string }> = []
    const ranges: Array<[number, number]> = []
    for (const m of masked.matchAll(new RegExp(CTE_HEAD_RE.source, 'gi'))) {
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
    // 集合运算：`FROM x EXCEPT SELECT x.id FROM x` 里 EXCEPT 会被当成 x 的别名 → 假红
    'EXCEPT', 'INTERSECT', 'MINUS',
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
    // 按**位置**逐个核对，不数数量。
    //
    // 数数量不行：早先版本一边只数每条语句的第一个 CTE、另一边连并列 CTE 一起数，
    // 提交树实测 196 : 487，富余大到一个文件被遮掉好几段 SQL 也照样是 0。
    // 改成同口径计数后仍有 blocks > heads 的文件（遮罩把字符变成空格，可能凑出新的匹配），
    // 富余一样是盲区。
    //
    // maskLiterals 保长度不改位置，所以原文里每个 CTE 头的**下标**，在抹过的文本里
    // 必须还能匹配到同一个下标 —— 匹配不到就说明这段被遮罩吃掉了，红。
    const headOffsets = (text: string) =>
      [...text.matchAll(new RegExp(CTE_HEAD_RE.source, 'gi'))].map((m) => m.index ?? -1)

    // $$ 函数体整段被当字面量抹掉（正确：体内引号不该干扰外层配对），
    // 体内的头由 dollarBodies 那一路递归接手，这里要把它们排除掉，否则会假红。
    const spans: Array<[number, number]> = []
    const dq = /\$([A-Za-z_]*)\$/g
    let m: RegExpExecArray | null
    while ((m = dq.exec(rawSrc)) !== null) {
      if (rawSrc.startsWith('$${', m.index)) continue
      const close = rawSrc.indexOf(m[0], m.index + m[0].length)
      if (close === -1) break
      spans.push([m.index, close + m[0].length])
      dq.lastIndex = close + m[0].length
    }
    const inDollarSpan = (i: number) => spans.some(([a, b]) => i >= a && i < b)

    const recognized = new Set(headOffsets(maskLiterals(rawSrc)))
    let missed = headOffsets(rawSrc).filter((i) => !inDollarSpan(i) && !recognized.has(i)).length
    for (const body of dollarBodies(rawSrc)) {
      const bodyRecognized = new Set(headOffsets(maskLiterals(body)))
      missed += headOffsets(body).filter((i) => !bodyRecognized.has(i)).length
    }
    return missed
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

  // 宿主语言里 SQL 写成单引号串时，串内转义的 \' 不能把后半段 SQL 遮掉
  it('pg.query 单引号形态里带转义引号，后半段 SQL 仍被检查', () => {
    const inner = "WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL SELECT \\'https://x\\', d.path FROM t JOIN d alias ON true)"
    const src = `pg.query('${inner}', [])`
    expect(violations(src), '串内转义引号把后半段 SQL 遮掉了，守护静默漏报').not.toEqual([])
    expect(unrecognizedWithHeads(src)).toBe(0)
  })

  // 宿主单引号串里的 SQL，其**内部**的字面量与注释仍必须按 SQL 词法遮掉：
  // 不遮的话，SQL 数据里的右括号会提前截断 CTE 体（静默漏报），注释里的限定符会造成假红
  it('宿主 SQL 串内部的字面量与注释按 SQL 词法遮罩', () => {
    const BQ = String.fromCharCode(92) + "'"   // 宿主里被转义的 SQL 单引号
    // 数据里的右括号不能截断 CTE 体 —— 截断了就查不出后面的别名混用
    const truncating = `pg.query('WITH RECURSIVE d(id, path) AS (SELECT ${BQ})${BQ}, ARRAY[1] UNION ALL SELECT d.path FROM t JOIN d alias ON true)', [])`
    expect(violations(truncating), '数据里的右括号截断了 CTE 体，守护静默漏报').not.toEqual([])
    expect(unrecognizedWithHeads(truncating)).toBe(0)

    // 注释里的限定符不算数 —— 算了就是对合法 SQL 假红。
    // ⚠️ 换行必须写成宿主里的**转义序列**（单引号串里不可能有真换行），
    //    用真换行的夹具跑的是另一条路径，覆盖不到真实源码形态。
    const NL = String.fromCharCode(92) + 'n'
    const commented = `pg.query('WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL -- 别写 d.path${NL} SELECT alias.path FROM t JOIN d alias ON true)', [])`
    expect(violations(commented), '注释里的 d.path 被当成真引用，对合法 SQL 假红').toEqual([])

    // 注释**之后**的混用必须照样查得出 —— 注释遮到串尾的话这条会静默漏报
    const afterComment = `pg.query('WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL -- 说明${NL} SELECT d.path FROM t JOIN d alias ON true)', [])`
    expect(violations(afterComment), '行注释遮到了串尾，把后面的混用吃掉了').not.toEqual([])
    expect(unrecognizedWithHeads(afterComment)).toBe(0)

    // ⚠️ 换行后**紧跟**限定符、中间没有空格：`\n` 若原样留着，那个 `n` 是单词字符，
    //    `nd.path` 会让下游的 `\bd\.` 边界匹配不上 —— 上面那条夹具多打了个空格，正好掩盖这条路径
    const noIndent = `pg.query('WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL -- 说明${NL}d.path FROM t JOIN d alias ON true)', [])`
    expect(violations(noIndent), '转义换行没遮成空白，单词边界被 n 破坏，静默漏报').not.toEqual([])
    expect(unrecognizedWithHeads(noIndent)).toBe(0)
  })

  // SQL 字符串字面量里的 `//` `--` `/*` 不能被当成注释起点，否则会把后面的真 SQL 吞掉
  it('SQL 数据里的注释符不吞掉后续 SQL', () => {
    const cases = [
      "WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL SELECT 'https://x', d.path FROM t JOIN d alias ON true)",
      "WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL SELECT 'a--b', d.path FROM t JOIN d alias ON true)",
      "WITH RECURSIVE d(id, path) AS (SELECT 1, ARRAY[1] UNION ALL SELECT 'a/*b', d.path FROM t JOIN d alias ON true)",
    ]
    for (const sql of cases) {
      expect(violations(sql), `被字面量里的注释符吞掉了：${sql.slice(0, 60)}…`).not.toEqual([])
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

/**
 * 关闭采购单时把「已收数量」按来源血缘占比分配的算法（#194）。
 *
 * 这些场景 e2e smoke 覆盖不到 —— 真跑一遍需要造出几百条来源血缘，
 * 而分配错误的表现又只是「来源间多退/少退一分」，不会让链路报错。
 * 两条不变量必须恒成立：
 *   ① 每行 `0 ≤ retained ≤ link.quantity`
 *   ② `Σ retained` 在**两位小数**上严格等于实收量（落库是 numeric(12,2)）
 */
describe('allocateRetainedQuantity 按占比分配已收数量', () => {
  const cents = (value: number) => Math.round(value * 100)
  function run(quantities: number[], receivedQuantity: number) {
    const links = quantities.map((quantity, index) => ({
      from_item_id: index + 1,
      quantity,
    }))
    const result = allocateRetainedQuantity(links, receivedQuantity)
    return {
      retained: result.map((row) => row.retained),
      retainedCents: result.reduce((sum, row) => sum + cents(row.retained), 0),
      withinCap: result.every((row, index) => (
        cents(row.retained) >= 0 && cents(row.retained) <= cents(quantities[index])
      )),
      conserved: result.every((row, index) => (
        cents(row.retained) + cents(row.releasable) === cents(quantities[index])
      )),
    }
  }

  it.each([
    { name: '三来源各 1 件、实收 1 件（循环小数）', quantities: [1, 1, 1], received: 1 },
    { name: '三来源各 1 件、实收 2 件（余数 2 分）', quantities: [1, 1, 1], received: 2 },
    { name: '两来源 5+5、实收 6', quantities: [5, 5], received: 6 },
    { name: '300 个 0.01、实收 1.00', quantities: Array(300).fill(0.01), received: 1 },
    { name: '300 个 0.01、实收 2.00', quantities: Array(300).fill(0.01), received: 2 },
    { name: '实收 0', quantities: [3, 7], received: 0 },
    { name: '实收等于全额', quantities: [3, 7], received: 10 },
    { name: '不等量来源 + 循环小数', quantities: [1, 2, 4], received: 3 },
  ])('$name：合计守恒且每行不超自身血缘', ({ quantities, received }) => {
    const result = run(quantities, received)
    expect(result.retainedCents).toBe(Math.round(received * 100))
    expect(result.withinCap).toBe(true)
    expect(result.conserved).toBe(true)
  })

  it('余数按最大余数法逐行补 1 分，不会一次全塞给同一行', () => {
    // 三来源各 1 件、实收 2 件：基础分配 0.66 × 3，余 2 分。
    // 每行最多补 1 分 → 0.67 / 0.67 / 0.66；一次全给首行会得到 0.68 / 0.66 / 0.66。
    expect(run([1, 1, 1], 2).retained).toEqual([0.67, 0.67, 0.66])
  })

  it('实收超过来源血缘合计时抛 CONFLICT，而不是静默截断', () => {
    expect(() => allocateRetainedQuantity(
      [{ from_item_id: 1, quantity: 5 }],
      6,
    )).toThrow('已收数量超过来源血缘合计')
  })
})

/**
 * 整单按待收数量收货（#192 待办区的「一键收货」）。
 *
 * 这两个入口没有 items 入参 —— 收多少完全由服务端从 `getShipmentReceiptProgress`
 * 的 outstanding 推出来。三件事必须钉死，错了都不会报错只会收错货：
 *   ① 入口与单据类型的绑定（市场入口只收品项公司发货、门店入口只收分院配货），
 *      这是**权限边界**：两个入口的 Server Action 权限不同，按 docType 分发等于越权；
 *   ② 只把 outstanding > 0 的行传下去（全收满的行再传一次会撞 CONFLICT）；
 *   ③ 传下去的数量是整行待收量，且 TOCTOU 冲突时 fail-closed 抛 CONFLICT。
 */
describe('整单收货入口 receiveXxxInFull（#192）', () => {
  const SENTINEL = '__DOWNSTREAM_REACHED__'

  beforeEach(() => {
    vi.resetAllMocks()
  })

  function shipmentDocRow(input: {
    docType: '品项公司发货' | '分院配货'
    status: string
  }) {
    return {
      id: 'GFH-1',
      doc_type: input.docType,
      status: input.status,
      source_org_node_id: 'HQ',
      target_org_node_id: 'M1',
      market_id: 'M1',
      supplier_id: null,
      supplier_name: null,
      cancellation_request_reason: null,
      cancellation_requested_by: null,
      cancellation_requested_at: null,
    }
  }

  function locationRow(locationId: string, locationType: string, parentLocationId: string | null) {
    return {
      location_id: locationId,
      org_node_id: locationId,
      location_type: locationType,
      name: locationId,
      parent_location_id: parentLocationId,
    }
  }

  /** 发货单明细：quantity = 发货量，fulfilled = 已收量，outstanding 由二者相减得出。 */
  function shipmentItemRow(id: number, quantity: string, fulfilledQuantity: string) {
    return {
      ...storeRequestItemRow(fulfilledQuantity),
      id,
      doc_id: 'GFH-1',
      lot_id: 101,
      quantity,
      request_quantity: null,
    }
  }

  /**
   * 第 1 段：`getShipmentReceiptProgress` 的只读事务。
   * 顺序 = docForUpdate → locationForUpdate(source) → locationForUpdate(target) → allDocItemsForUpdate。
   */
  function mockProgressTransaction(input: {
    docType: '品项公司发货' | '分院配货'
    status: string
    items: ReturnType<typeof shipmentItemRow>[]
  }) {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([shipmentDocRow({ docType: input.docType, status: input.status })])
      .mockResolvedValueOnce([locationRow('HQ', '总部', null)])
      .mockResolvedValueOnce([locationRow(input.docType === '品项公司发货' ? 'M1' : 'S1', input.docType === '品项公司发货' ? '市场' : '门店', input.docType === '品项公司发货' ? 'HQ' : 'M1')])
      .mockResolvedValueOnce(input.items)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))
    return txExecute
  }

  /**
   * 第 2 段：`receivePhysicalShipment` 的写事务，跑完整个明细循环。
   *
   * 循环每行依次查：明细（FOR UPDATE + 数量闸）→ 来源批次 → 采购订单价格快照 → SKU。
   * 全部行过完才走到 `generateDocId` 的 advisory lock —— 在那里抛哨兵收尾，
   * 后面建单/建批次是既有路径，与本次改动无关。
   */
  function mockReceiveTransaction(downstreamItems: Map<number, ReturnType<typeof shipmentItemRow>>) {
    const itemIds: number[] = []
    // 先 source（总部）后 target（市场），与 receivePhysicalShipment 的调用序一致。
    const locations = [locationRow('HQ', '总部', null), locationRow('M1', '市场', 'HQ')]
    const txExecute = vi.fn(initializedCutoverExecutor(async (query: unknown) => {
      const rendered = renderSql(query)
      if (rendered.includes('pg_advisory_xact_lock')) throw new Error(SENTINEL)
      if (rendered.includes('FROM inventory_docs')) {
        return [shipmentDocRow({ docType: '品项公司发货', status: '待收货' })]
      }
      if (rendered.includes('FROM inventory_locations')) {
        return [locations.shift() ?? locationRow('M1', '市场', 'HQ')]
      }
      // 价格快照的 SQL 里也出现 inventory_doc_items（JOIN），必须排在明细分支之前。
      if (rendered.includes('FROM inventory_doc_links')) {
        return [{
          supply_chain_unit_cost: '10',
          market_standard_unit_price: '100',
          market_unit_discount: '0',
          market_actual_unit_price: '100',
          store_standard_unit_price: '120',
          store_unit_discount: '0',
          store_actual_unit_price: '120',
        }]
      }
      if (rendered.includes('FROM inventory_stock_lots')) return [shipmentSourceLotRow()]
      if (rendered.includes('FROM inventory_skus')) return [marketSkuRow('SKU-1')]
      if (rendered.includes('FROM inventory_doc_items')) {
        const id = Number(sqlParams(query)[0])
        itemIds.push(id)
        const row = downstreamItems.get(id)
        return row ? [row] : []
      }
      throw new Error(`未预期的查询：${rendered.slice(0, 80)}`)
    }))
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))
    return { itemIds }
  }

  /** 两段各有一次 syncLocations 漂移探测，都短路掉。 */
  function mockBothSyncProbes() {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([{ drifted: false }] as never)
      .mockResolvedValueOnce([{ drifted: false }] as never)
  }

  it('单据不是待收货时抛 INVALID_STATE，且不进下游收货事务', async () => {
    mockBothSyncProbes()
    mockProgressTransaction({
      docType: '品项公司发货',
      status: '已完成',
      items: [shipmentItemRow(1, '10', '10')],
    })
    await expect(receiveItemCompanyShipmentInFull(SESSION, { shipmentId: 'GFH-1' }))
      .rejects.toThrow('该发货单不是待收货状态，请刷新后重试')
    // 只开了 getShipmentReceiptProgress 那一个事务；开第二个就说明下游被调了。
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1)
  })

  it('所有明细都收满时抛 INVALID_STATE，不会给下游送空 items', async () => {
    // 下游 receivePhysicalShipment 对空 items 抛的是「收货至少需要一条明细」，
    // 那句话对操作员没意义（他没填过明细）；这里必须在本层拦下并给出可操作的提示。
    mockBothSyncProbes()
    mockProgressTransaction({
      docType: '品项公司发货',
      status: '待收货',
      items: [shipmentItemRow(1, '10', '10'), shipmentItemRow(2, '5', '5')],
    })
    await expect(receiveItemCompanyShipmentInFull(SESSION, { shipmentId: 'GFH-1' }))
      .rejects.toThrow('该发货单没有待收数量，请刷新后重试')
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1)
  })

  it('入口与单据类型不匹配时抛 INVALID_PARAMS —— 市场入口收不了分院配货', async () => {
    // 这条是权限边界的第一道闸：两个入口的 Server Action 权限不同
    //（market_operate / store_operate），能互收就等于市场角色能替门店收货。
    mockBothSyncProbes()
    mockProgressTransaction({
      docType: '分院配货',
      status: '待收货',
      items: [shipmentItemRow(1, '10', '0')],
    })
    await expect(receiveItemCompanyShipmentInFull(SESSION, { shipmentId: 'FPH-1' }))
      .rejects.toThrow('单据类型与收货入口不匹配')
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1)
  })

  it('入口与单据类型不匹配时抛 INVALID_PARAMS —— 门店入口收不了品项公司发货', async () => {
    mockBothSyncProbes()
    mockProgressTransaction({
      docType: '品项公司发货',
      status: '待收货',
      items: [shipmentItemRow(1, '10', '0')],
    })
    await expect(receiveStoreAllocationInFull(SESSION, { shipmentId: 'GFH-1' }))
      .rejects.toThrow('单据类型与收货入口不匹配')
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1)
  })

  it('只把 outstanding > 0 的行传给下游，收满的行被跳过', async () => {
    mockBothSyncProbes()
    const items = [
      shipmentItemRow(1, '10', '4'), // outstanding 6
      shipmentItemRow(2, '5', '5'), // outstanding 0 → 跳过
      shipmentItemRow(3, '8', '0'), // outstanding 8
    ]
    mockProgressTransaction({ docType: '品项公司发货', status: '待收货', items })
    const { itemIds } = mockReceiveTransaction(new Map(items.map((row) => [row.id, row])))
    // 下游明细行的剩余量与 progress 读到的一致 → 数量闸全过 → 走到建单号处抛哨兵。
    await expect(receiveItemCompanyShipmentInFull(SESSION, { shipmentId: 'GFH-1' }))
      .rejects.toThrow(SENTINEL)
    expect(itemIds).toEqual([1, 3])
  })

  it('TOCTOU：progress 读完后别人先收了一部分，下游 fail-closed 抛 CONFLICT', async () => {
    /*
     * outstanding 在 getShipmentReceiptProgress 的事务里读、在 receivePhysicalShipment
     * 的另一个事务里写，中间有窗口。这条同时钉两件事：
     *   · 传下去的确实是**整行待收量**（传更小的值就不会撞上闸门，这条会变绿失效）；
     *   · 并发下第二个请求被 FOR UPDATE + 数量闸挡住，不会超收。
     */
    mockBothSyncProbes()
    mockProgressTransaction({
      docType: '品项公司发货',
      status: '待收货',
      items: [shipmentItemRow(1, '10', '4')], // progress 认为待收 6
    })
    // 下游拿到的是已被别人收到 9 的版本（真实待收只剩 1）。
    mockReceiveTransaction(new Map([[1, shipmentItemRow(1, '10', '9')]]))
    await expect(receiveItemCompanyShipmentInFull(SESSION, { shipmentId: 'GFH-1' }))
      .rejects.toThrow('实收数量不能超过待收数量')
  })
})

/**
 * #251：`loadLocation` 的 `location_id = X OR org_node_id = X` 是双 id 多态查找
 *（`locationForUpdate(tx, input.sourceOrgNodeId)` 传 org_node_id、
 * `locationForUpdate(tx, storeId)` 传 store_id，两种都存在）。
 *
 * 两侧各自唯一（`location_id` 主键 / `org_node_id` 有 `uq_inventory_locations_org`），
 * 但**可以落在不同的两行上**：门店行是 `location_id = store_id` / `org_node_id = org-门店-*`
 *（只有总部/市场行自指），所以某个 store_id 恰等于某个 `type='门店'` 的 `org_nodes.id` 时，
 * 两侧指向两个**不同门店**的库存主体。原先既无 ORDER BY 也无 LIMIT、直接取首行，
 * 结果又喂给 `assertLocationWritable` ——「按 A 鉴权、扣 B 的批次」。
 *
 * staffApi `ensureInventoryLocation` 是同签名副本，一致性由
 * `staffApi/__tests__/routes/cross-end-inventory-snapshot.test.js` §6 守护。
 */
describe('库存主体解析确定性（#251）', () => {
  it('一个入参命中两行时抛 CONFLICT，不静默选首行', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([
      // 行 Y：另一门店（S-OTHER）的 org_node_id 恰好等于入参
      { location_id: 'S-OTHER', org_node_id: 'S1', location_type: '门店', name: '门店二', parent_location_id: 'M1', is_active: true },
      // 行 X：某门店的 store_id 就是入参本身
      { location_id: 'S1', org_node_id: 'org-门店-1', location_type: '门店', name: '门店一', parent_location_id: 'M1', is_active: true },
    ])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createReturnForRestock(SESSION, {
      sourceOrgNodeId: 'S1',
      targetOrgNodeId: 'M1',
      items: [{ lotId: 1, quantity: 1 }],
    } as never)).rejects.toThrow('库存主体标识冲突')

    // 撞值必须拦在任何库存写入之前
    const queries = txExecute.mock.calls.map(([query]) => renderSql(query)).join('\n')
    expect(queries).not.toContain('inventory_stock_lots')
    expect(queries).not.toContain('inventory_movements')
  })

  it('撞值行中有一行已停用**仍**抛 CONFLICT（停用不能消除 id 空间的不确定性）', async () => {
    // is_active 从 WHERE 移到 JS 侧判定的原因：留在 WHERE 里会让停用行不参与歧义判定，
    // 于是「入参意图指向那个停用主体」时会静默返回另一家在营门店并继续写库存。
    const txExecute = vi.fn().mockResolvedValueOnce([
      { location_id: 'S-OTHER', org_node_id: 'S1', location_type: '门店', name: '门店二', parent_location_id: 'M1', is_active: false },
      { location_id: 'S1', org_node_id: 'org-门店-1', location_type: '门店', name: '门店一', parent_location_id: 'M1', is_active: true },
    ])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createReturnForRestock(SESSION, {
      sourceOrgNodeId: 'S1', targetOrgNodeId: 'M1', items: [{ lotId: 1, quantity: 1 }],
    } as never)).rejects.toThrow('库存主体标识冲突')
  })

  it('唯一命中项已停用时仍报「不存在或已停用」（原文案不被撞值守卫吃掉）', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([
      { location_id: 'S1', org_node_id: 'org-门店-1', location_type: '门店', name: '门店一', parent_location_id: 'M1', is_active: false },
    ])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await expect(createReturnForRestock(SESSION, {
      sourceOrgNodeId: 'S1', targetOrgNodeId: 'M1', items: [{ lotId: 1, quantity: 1 }],
    } as never)).rejects.toThrow('库存主体不存在或已停用')
  })

  it('主体查询带确定性排序与 LIMIT 2', async () => {
    const txExecute = vi.fn().mockResolvedValue([
      { location_id: 'S1', org_node_id: 'org-门店-1', location_type: '门店', name: '门店一', parent_location_id: 'M1', is_active: true },
    ])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(txExecute),
    } as never))

    await createReturnForRestock(SESSION, {
      sourceOrgNodeId: 'S1',
      targetOrgNodeId: 'M1',
      items: [{ lotId: 1, quantity: 1 }],
    } as never).catch(() => undefined)

    const locationQuery = txExecute.mock.calls
      .map(([query]) => renderSql(query))
      .find((q) => q.includes('FROM inventory_locations'))
    expect(locationQuery).toBeDefined()
    const flat = String(locationQuery).replace(/\s+/g, ' ')
    // 只保证确定性（同一入参两次调用必得同一行），不声称语义正确 ——
    // 撞值时不存在正确的那一行，正确性由上面的 CONFLICT 保障。
    expect(flat).toContain('ORDER BY location_id')
    expect(flat).toContain('LIMIT 2')
  })
})

describe('分院配货报货单可选：引用 / 自选 / 混合（#337）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const LOCATIONS: Record<string, Record<string, unknown>> = {
    M1: { location_id: 'M1', org_node_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ', is_active: true },
    M2: { location_id: 'M2', org_node_id: 'M2', location_type: '市场', name: '市场二', parent_location_id: 'HQ', is_active: true },
    S1: { location_id: 'S1', org_node_id: 'ORG-S1', location_type: '门店', name: '门店一', parent_location_id: 'M1', is_active: true },
    S2: { location_id: 'S2', org_node_id: 'ORG-S2', location_type: '门店', name: '门店二', parent_location_id: 'M1', is_active: true },
    S9: { location_id: 'S9', org_node_id: 'ORG-S9', location_type: '门店', name: '外市场门店', parent_location_id: 'M2', is_active: true },
  }
  const LOTS: Record<number, { skuId: string; onHand: string }> = {
    11: { skuId: 'SKU-1', onHand: '10' },
    12: { skuId: 'SKU-2', onHand: '10' },
    13: { skuId: 'SKU-3', onHand: '3' },
  }

  function mockAllocation(options: { storePrices?: Record<string, string | null>; requestSource?: string } = {}) {
    const storePrices: Record<string, string | null> = { 'SKU-1': '50', 'SKU-2': '60', 'SKU-3': '70', ...options.storePrices }
    const writes = {
      links: [] as unknown[][],
      reservations: [] as unknown[][],
      fulfilledUpdates: [] as unknown[][],
      items: [] as unknown[][],
      movements: [] as unknown[][],
      headers: [] as unknown[][],
    }
    let itemId = 100
    const executor = vi.fn(async (query: unknown) => {
      const rendered = renderSql(query)
      const params = sqlParams(query)
      if (rendered.includes('INSERT INTO inventory_doc_links')) { writes.links.push(params); return [] }
      if (rendered.includes('INSERT INTO inventory_stock_reservations')) { writes.reservations.push(params); return [] }
      if (rendered.includes('INSERT INTO inventory_movements')) { writes.movements.push(params); return [] }
      if (rendered.includes('INSERT INTO inventory_docs')) { writes.headers.push(params); return [] }
      if (rendered.includes('INSERT INTO inventory_doc_items')) {
        writes.items.push(params)
        itemId += 1
        return [{ id: itemId }]
      }
      if (rendered.includes('UPDATE inventory_doc_items')) { writes.fulfilledUpdates.push(params); return [] }
      if (rendered.includes('FROM inventory_locations')) {
        const endpoint = String(params[0])
        const row = Object.values(LOCATIONS).find((location) => location.location_id === endpoint || location.org_node_id === endpoint)
        return row ? [row] : []
      }
      if (rendered.includes('FROM inventory_stock_reservations')) return [{ quantity: '0' }]
      if (rendered.includes('FROM inventory_stock_lots')) {
        const lotId = Number(params[0])
        const lot = LOTS[lotId]
        if (!lot) return []
        return [{
          ...shipmentSourceLotRow(), id: lotId, location_id: 'M1', sku_id: lot.skuId, sku_name: `测试 ${lot.skuId}`,
          batch_no: `B-${lotId}`, quantity_on_hand: lot.onHand, source_doc_id: null, supplier_id: null,
        }]
      }
      if (rendered.includes('FROM inventory_skus')) {
        const skuId = String(params.find((param) => typeof param === 'string' && param.startsWith('SKU-')))
        return [{ ...marketSkuRow(skuId), store_purchase_price: storePrices[skuId] ?? null }]
      }
      if (rendered.includes('FROM inventory_doc_links')) return [{ quantity: '0' }]
      if (rendered.includes('FROM inventory_doc_items') && rendered.includes('FOR UPDATE')) {
        return [storeRequestItemRow()]
      }
      if (rendered.includes('FROM inventory_doc_items')) return [{ sku_id: 'SKU-1' }]
      if (rendered.includes('FROM inventory_docs') && rendered.includes('FOR UPDATE')) {
        return [{
          id: 'DBH-1', doc_type: '门店报货', status: '已完成',
          source_org_node_id: options.requestSource ?? 'ORG-S1', target_org_node_id: 'M1', market_id: 'M1',
          supplier_id: null, supplier_name: null,
        }]
      }
      return []
    })
    mockSyncLocationsShortCircuit()
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({
      execute: initializedCutoverExecutor(executor),
    } as never))
    return { writes, executor }
  }

  it('纯引用：保持改造前行为 —— 写血缘 / 预留并回写报货 fulfilled_quantity', async () => {
    const { writes } = mockAllocation()
    const result = await createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', sourceMarketId: 'M1',
      items: [{ requestItemId: 1, lotId: 11, quantity: 2, giftQuantity: 1 }],
    })
    expect(result.id).toMatch(/^FPH-\d{8}-0001$/)
    expect(writes.links.map((params) => params.find((param) => typeof param === 'string' && param.startsWith('门店报货'))))
      .toEqual(['门店报货配货', '门店报货赠送配货'])
    expect(writes.reservations).toHaveLength(2)
    expect(writes.fulfilledUpdates).toHaveLength(1)
    expect(writes.movements).toHaveLength(2)
    // 单头收货门店来自报货主体（insertDocHeader 归一成 org_node_id）
    expect(writes.headers[0]).toContain('ORG-S1')
  })

  it('纯自选：不传 storeRequestId 不再报「门店报货单」必填；只写明细与流水，不写血缘 / 预留 / 报货回写', async () => {
    const { writes, executor } = mockAllocation()
    const result = await createStoreAllocation(SESSION, {
      targetStoreId: 'ORG-S1', sourceMarketId: 'M1',
      items: [{ skuId: 'SKU-2', lotId: 12, quantity: 3, giftQuantity: 1, storeUnitDiscount: 5 }],
    })
    expect(result.id).toMatch(/^FPH-/)
    expect(writes.links).toHaveLength(0)
    expect(writes.reservations).toHaveLength(0)
    expect(writes.fulfilledUpdates).toHaveLength(0)
    expect(writes.items).toHaveLength(2)
    expect(writes.movements).toHaveLength(2)
    expect(writes.headers[0]).toContain('ORG-S1')
    // 价格口径与引用路径一致：实际单价 = 门店进货价 60 − 优惠 5
    expect(writes.items[0]).toContain('55')
    expect(writes.items[0]).toContain('165')
    // 不触碰任何门店报货单
    const touchedRequest = executor.mock.calls.some(([query]) => renderSql(query).includes('FROM inventory_docs') && renderSql(query).includes('FOR UPDATE'))
    expect(touchedRequest).toBe(false)
  })

  it('混合：只有引用行写血缘并回写报货进度，自选行没有血缘与预留记录', async () => {
    const { writes } = mockAllocation()
    await createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', targetStoreId: 'S1', sourceMarketId: 'M1',
      items: [
        { requestItemId: 1, lotId: 11, quantity: 2 },
        { requestItemId: null, skuId: 'SKU-2', lotId: 12, quantity: 4 },
      ],
    })
    expect(writes.items).toHaveLength(2)
    expect(writes.links).toHaveLength(1)
    expect(writes.links[0]).toContain('门店报货配货')
    // 血缘的 to_item_id 只指向引用行生成的明细（第一条 = 101）
    expect(writes.links[0]).toContain(101)
    expect(writes.links[0]).not.toContain(102)
    expect(writes.reservations).toHaveLength(1)
    expect(writes.fulfilledUpdates).toHaveLength(1)
  })

  it('同一批次跨行累计判可用量，且共用快照让出库流水的 before/after 连续', async () => {
    const { writes } = mockAllocation()
    await createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', sourceMarketId: 'M1',
      items: [
        { requestItemId: 1, lotId: 11, quantity: 4 },
        { requestItemId: null, skuId: 'SKU-3', lotId: 13, quantity: 1 },
        { requestItemId: null, skuId: 'SKU-3', lotId: 13, quantity: 2 },
      ],
    })
    // 批次 13 可用 3：第二条的 quantity_before 必须是第一条之后的 2，而不是快照里的 3
    const lot13 = writes.movements.filter((params) => params.includes(13))
    expect(lot13.map((params) => params.slice(-4, -2))).toEqual([['3', '2'], ['2', '0']])

    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1',
      items: [
        { skuId: 'SKU-3', lotId: 13, quantity: 2 },
        { skuId: 'SKU-3', lotId: 13, quantity: 1, giftQuantity: 1 },
      ],
    })).rejects.toThrow('库存不足')
  })

  it('自选行 SKU 未设门店进货价时拒绝', async () => {
    mockAllocation({ storePrices: { 'SKU-2': null } })
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1',
      items: [{ skuId: 'SKU-2', lotId: 12, quantity: 1 }],
    })).rejects.toThrow('未设置门店进货价')
  })

  it('自选行批次可用量不足时拒绝', async () => {
    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1',
      items: [{ skuId: 'SKU-3', lotId: 13, quantity: 4 }],
    })).rejects.toThrow('库存不足')
  })

  it('收货门店不属于配货市场时拒绝', async () => {
    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S9', sourceMarketId: 'M1',
      items: [{ skuId: 'SKU-2', lotId: 12, quantity: 1 }],
    })).rejects.toThrow('门店不属于当前配货市场')
  })

  it('带报货单但收货门店与报货主体不一致时拒绝', async () => {
    const { writes } = mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', targetStoreId: 'S2', sourceMarketId: 'M1',
      items: [{ requestItemId: 1, lotId: 11, quantity: 1 }],
    })).rejects.toThrow('收货门店与门店报货单的报货门店不一致')
    expect(writes.items).toHaveLength(0)
  })

  it('同一门店的两种 id 写法（store_id / org_node_id）视为同一门店', async () => {
    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', targetStoreId: 'S1', sourceMarketId: 'M1',
      items: [{ requestItemId: 1, lotId: 11, quantity: 1 }],
    })).resolves.toMatchObject({ id: expect.stringMatching(/^FPH-/) })
  })

  it('引用单里已有的 SKU 不能再加自选行绕过未配量上限', async () => {
    const { writes } = mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', sourceMarketId: 'M1',
      items: [
        { requestItemId: 1, lotId: 11, quantity: 5 },
        { skuId: 'SKU-1', lotId: 11, quantity: 3 },
      ],
    })).rejects.toThrow('已在引用的门店报货单中')
    expect(writes.items).toHaveLength(0)
  })

  it('入口参数：无报货单时收货门店必填；无报货单不能带报货明细；自选 SKU 与批次须一致；标识非字符串按参数错误', async () => {
    await expect(createStoreAllocation(SESSION, {
      sourceMarketId: 'M1', items: [{ skuId: 'SKU-2', lotId: 12, quantity: 1 }],
    })).rejects.toThrow('INVALID_PARAMS: 收货门店不能为空')
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1', items: [{ requestItemId: 1, lotId: 11, quantity: 1 }],
    })).rejects.toThrow('未引用门店报货单时不能按报货明细配货')
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 42 as never, sourceMarketId: 'M1', items: [{ lotId: 12, quantity: 1 }],
    })).rejects.toThrow('INVALID_PARAMS: 收货门店格式不正确')
    for (const lotId of [NaN, 1.5, 'abc', 0, undefined, true, [12], { id: 12 }, 1e21, '12abc']) {
      await expect(createStoreAllocation(SESSION, {
        targetStoreId: 'S1', sourceMarketId: 'M1', items: [{ skuId: 'SKU-2', lotId: lotId as never, quantity: 1 }],
      })).rejects.toThrow('INVALID_PARAMS: 请为每条配货明细选择库存批次')
    }
    for (const requestItemId of [true, [5], 1.5, 1e21]) {
      await expect(createStoreAllocation(SESSION, {
        storeRequestId: 'DBH-1', sourceMarketId: 'M1', items: [{ requestItemId: requestItemId as never, lotId: 11, quantity: 1 }],
      })).rejects.toThrow('INVALID_PARAMS: 门店报货明细不正确')
    }
    // 自选行商品必填（与前端「商品」必填同源）
    for (const skuId of [undefined, null, '', '   ']) {
      await expect(createStoreAllocation(SESSION, {
        targetStoreId: 'S1', sourceMarketId: 'M1', items: [{ skuId: skuId as never, lotId: 12, quantity: 1 }],
      })).rejects.toThrow('INVALID_PARAMS: 自选配货明细必须选择商品')
    }
    expect(db.transaction).not.toHaveBeenCalled()

    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1', items: [{ skuId: 'SKU-1', lotId: 12, quantity: 1 }],
    })).rejects.toThrow('配货批次与所选商品不一致')
    // 数字串批次号照常接受
    mockAllocation()
    await expect(createStoreAllocation(SESSION, {
      targetStoreId: 'S1', sourceMarketId: 'M1', items: [{ skuId: 'SKU-2', lotId: '12' as never, quantity: 1 }],
    })).resolves.toMatchObject({ id: expect.stringMatching(/^FPH-/) })
  })
})
