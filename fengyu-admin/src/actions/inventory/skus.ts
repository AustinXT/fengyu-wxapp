'use server'

import {
  createInventorySku as createInventorySkuImpl,
  listInventorySkus as listInventorySkusImpl,
  updateInventorySku as updateInventorySkuImpl,
} from '@/lib/inventory/engine'
import type { InventorySkuInput, InventorySkuSourceType } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

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

export const createInventorySku = withPermission(
  'inventory:create',
  async (_session, input: InventorySkuInput) => createInventorySkuImpl(input),
)

export const updateInventorySku = withPermission(
  'inventory:update',
  async (_session, skuId: string, input: Partial<InventorySkuInput>) =>
    updateInventorySkuImpl(skuId, input),
)
