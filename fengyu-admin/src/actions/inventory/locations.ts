'use server'

import {
  listInventoryDocLocationFilterOptions as listInventoryDocLocationFilterOptionsImpl,
  listInventoryLocationFilterOptions as listInventoryLocationFilterOptionsImpl,
  listInventoryLocations as listInventoryLocationsImpl,
  listInventoryMarketTransferTargets as listInventoryMarketTransferTargetsImpl,
} from '@/lib/inventory/engine'
import { inventoryDelegatableOperateActions } from '@/lib/inventory/business-level'
import { withAnyPermission, withPermission } from '@/lib/with-permission'

export const listInventoryLocations = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationsImpl(),
)

/** #340：市场间调货的接收主体候选（不按 scope，字段只有名称与 orgNodeId）。权限与 engine 同源：只认能建这张单的 operate。 */
export const listInventoryMarketTransferTargets = withAnyPermission(
  [...inventoryDelegatableOperateActions('market')],
  async () => listInventoryMarketTransferTargetsImpl(),
)

export const listInventoryLocationFilterOptions = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationFilterOptionsImpl(),
)

export const listInventoryDocLocationFilterOptions = withPermission(
  'inventory:list',
  async () => listInventoryDocLocationFilterOptionsImpl(),
)
