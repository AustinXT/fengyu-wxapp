'use server'

import {
  listInventoryDocLocationFilterOptions as listInventoryDocLocationFilterOptionsImpl,
  listInventoryLocationFilterOptions as listInventoryLocationFilterOptionsImpl,
  listInventoryMovementLocationFilterOptions as listInventoryMovementLocationFilterOptionsImpl,
  listInventoryLocations as listInventoryLocationsImpl,
  listInventoryMarketTransferTargets as listInventoryMarketTransferTargetsImpl,
  listInventoryShipmentMarketTargets as listInventoryShipmentMarketTargetsImpl,
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

/** #336b：品项公司发货的收货市场候选（不按 scope，字段只有名称与 orgNodeId）。权限与发货 action 同源。 */
export const listInventoryShipmentMarketTargets = withPermission(
  'inventory:supply_chain_operate',
  async () => listInventoryShipmentMarketTargetsImpl(),
)

export const listInventoryLocationFilterOptions = withPermission(
  'inventory:stock_list',
  async () => listInventoryLocationFilterOptionsImpl(),
)

export const listInventoryMovementLocationFilterOptions = withPermission(
  'inventory:stock_list',
  async () => listInventoryMovementLocationFilterOptionsImpl(),
)

export const listInventoryDocLocationFilterOptions = withPermission(
  'inventory:list',
  async () => listInventoryDocLocationFilterOptionsImpl(),
)
