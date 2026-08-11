'use server'

import {
  createInventorySkuMapping as createInventorySkuMappingImpl,
  listInventorySkuMappingOptions as listInventorySkuMappingOptionsImpl,
  listInventorySkuMappings as listInventorySkuMappingsImpl,
  updateInventorySkuMapping as updateInventorySkuMappingImpl,
} from '@/lib/inventory/engine'
import type { InventorySkuMappingInput } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventorySkuMappings = withPermission(
  'inventory:stock_list',
  async (_session, filters: { keyword?: string; onlyActive?: boolean } = {}) =>
    listInventorySkuMappingsImpl(filters),
)

export const listInventorySkuMappingOptions = withPermission(
  'inventory:stock_list',
  async (_session) => listInventorySkuMappingOptionsImpl(),
)

export const createInventorySkuMapping = withPermission(
  'inventory:create',
  async (_session, input: InventorySkuMappingInput) => createInventorySkuMappingImpl(input),
)

export const updateInventorySkuMapping = withPermission(
  'inventory:update',
  async (_session, id: number, isActive: boolean) => updateInventorySkuMappingImpl(id, isActive),
)
