'use server'

import {
  listInventoryDocLocationFilterOptions as listInventoryDocLocationFilterOptionsImpl,
  listInventoryLocationFilterOptions as listInventoryLocationFilterOptionsImpl,
  listInventoryLocations as listInventoryLocationsImpl,
} from '@/lib/inventory/engine'
import { withPermission } from '@/lib/with-permission'

export const listInventoryLocations = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationsImpl(),
)

export const listInventoryLocationFilterOptions = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationFilterOptionsImpl(),
)

export const listInventoryDocLocationFilterOptions = withPermission(
  'inventory:list',
  async () => listInventoryDocLocationFilterOptionsImpl(),
)
