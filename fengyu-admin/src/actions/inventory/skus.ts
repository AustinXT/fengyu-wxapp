'use server'

import {
  createInventorySku as createInventorySkuImpl,
  listInventorySkus as listInventorySkusImpl,
  updateInventorySku as updateInventorySkuImpl,
} from '@/lib/inventory/engine'
import type { InventorySkuInput, InventorySkuSourceType } from '@/lib/inventory/types'
import { withAnyPermission, withPermission } from '@/lib/with-permission'

export const listInventorySkus = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: {
      keyword?: string
      sourceType?: InventorySkuSourceType
      onlyActive?: boolean
      page?: number
      pageSize?: number
    } = {},
  ) => listInventorySkusImpl(filters),
)

export const createInventorySku = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_sku_manage'],
  async (_session, input: InventorySkuInput) => createInventorySkuImpl(input),
)

export const updateInventorySku = withAnyPermission(
  ['inventory:supply_chain_master_data_manage', 'inventory:market_sku_manage'],
  async (_session, skuId: string, input: Partial<InventorySkuInput>) =>
    updateInventorySkuImpl(skuId, input),
)
