'use server'

import { listInventoryLocations as listInventoryLocationsImpl } from '@/lib/inventory/engine'
import { withPermission } from '@/lib/with-permission'

export const listInventoryLocations = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationsImpl(),
)
