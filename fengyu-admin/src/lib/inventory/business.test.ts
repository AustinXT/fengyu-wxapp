import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  assertSkuAvailableToMarket,
  cancelItemCompanyShipment,
  createItemCompanyShipment,
  createMarketStaffPurchase,
  createMarketReplenishment,
  createReturnForRestock,
  createStoreAllocation,
  createStoreReplenishmentRequest,
  quoteMarketReplenishmentPrice,
  receiveItemCompanyShipment,
} from './business'
import { db } from '@/db'

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: [], scopeStoreIds: [] },
} as never

const PRICE_SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['inventory:price_view'], scopeStoreIds: [] },
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

describe('inventory business action input guards', () => {
  it('拒绝没有明细的专用建单入口', async () => {
    await expect(createStoreReplenishmentRequest(SESSION, {
      storeId: 'S1', marketId: 'M1', items: [],
    })).rejects.toThrow('门店报货至少需要一条明细')
    await expect(createMarketReplenishment(SESSION, {
      marketId: 'M1', supplyChainLocationId: 'HQ', items: [],
    })).rejects.toThrow('市场报货至少需要一条明细')
    await expect(createItemCompanyShipment(SESSION, {
      purchaseOrderId: 'CGD-1', sourceLocationId: 'HQ', items: [],
    })).rejects.toThrow('品项公司发货至少需要一条明细')
    await expect(createStoreAllocation(SESSION, {
      storeRequestId: 'DBH-1', sourceMarketId: 'M1', items: [],
    })).rejects.toThrow('分院配货至少需要一条明细')
    await expect(createReturnForRestock(SESSION, {
      sourceLocationId: 'S1', targetLocationId: 'M1', items: [],
    })).rejects.toThrow('退货至少需要一条明细')
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
  })

  it('福利报价要求价格查看权限', async () => {
    await expect(quoteMarketReplenishmentPrice(SESSION, {
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
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))

    await expect(createMarketStaffPurchase(SESSION, {
      marketId: 'M1', employeeId: 'E002', items: [{ lotId: 1, quantity: 1 }],
    })).rejects.toThrow('员工不属于当前市场')
    expect(txExecute).toHaveBeenCalledTimes(3)
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
        source_location_id: 'S1', target_location_id: 'M1', market_id: 'M1',
        supplier_id: null, supplier_name: null, related_doc_id: null, request_doc_id: null,
      }])
      .mockResolvedValueOnce([{ quantity: '0' }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))

    await expect(createMarketReplenishment(SESSION, {
      marketId: 'M1',
      supplyChainLocationId: 'HQ',
      items: [{ skuId: 'SKU-1', sourceRequestItemIds: [1], purchaseQuantity: 5 }],
    })).rejects.toThrow('已全部履约或已汇总')
  })

  it('福利报价始终以 SKU 市场进货价为基础，不接受方案中的基础价快照', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        location_id: 'M1', location_type: '市场', name: '市场一', parent_location_id: 'HQ',
      }])
      .mockResolvedValueOnce([{
        sku_id: 'SKU-1', product_code: 'P-1', product_name: '测试 SKU', spec_name: null,
        supplier: null, product_series: null, source_type: '供应链', owner_market_id: null,
        supply_chain_purchase_price: null, market_purchase_price: '100', store_purchase_price: null,
        market_staff_purchase_price: null, item_company_purchase_price: null,
      }])
      .mockResolvedValueOnce([{
        plan_id: 'PROMO-1', plan_no: 'PROMO-1', plan_name: '福利方案',
        market_base_price: '1', market_unit_discount: '10', market_actual_price: '0',
      }])
    vi.mocked(db.execute).mockResolvedValue([] as never)
    vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback({ execute: txExecute } as never))

    await expect(quoteMarketReplenishmentPrice(PRICE_SESSION, {
      marketId: 'M1', skuId: 'SKU-1', quantity: 1,
    })).resolves.toMatchObject({
      marketStandardUnitPrice: 100,
      marketUnitDiscount: 10,
      marketActualUnitPrice: 90,
    })
  })
})
