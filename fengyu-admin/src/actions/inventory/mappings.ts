'use server'

import {
  createInventorySkuComposition as createInventorySkuCompositionImpl,
  listInventorySkuCompositionOptions as listInventorySkuCompositionOptionsImpl,
  listInventorySkuCompositions as listInventorySkuCompositionsImpl,
  updateInventorySkuComposition as updateInventorySkuCompositionImpl,
} from '@/lib/inventory/engine'
import type { InventoryCompositionInput } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventorySkuCompositions = withPermission(
  'inventory:stock_list',
  async (_session, filters: { keyword?: string; status?: 'configured' | 'unconfigured' | 'invalid' } = {}) =>
    listInventorySkuCompositionsImpl(filters),
)

export const listInventorySkuCompositionOptions = withPermission(
  'inventory:stock_list',
  async (_session) => listInventorySkuCompositionOptionsImpl(),
)

export const createInventorySkuComposition = withPermission(
  'inventory:create',
  async (_session, input: InventoryCompositionInput) => createInventorySkuCompositionImpl(input),
)

export const updateInventorySkuComposition = withPermission(
  'inventory:update',
  async (_session, input: InventoryCompositionInput) => updateInventorySkuCompositionImpl(input),
)
