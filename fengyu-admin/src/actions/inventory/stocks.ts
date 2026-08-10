'use server'

import {
  exportInventoryLots as exportInventoryLotsImpl,
  listInventoryLotOptions as listInventoryLotOptionsImpl,
  listInventoryLots as listInventoryLotsImpl,
} from '@/lib/inventory/engine'
import type { ExportBatchOptions } from '@/lib/export-pagination'
import type { InventoryLocationType } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventoryLots = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: {
      locationId?: string
      locationType?: InventoryLocationType
      skuId?: string
      keyword?: string
      onlyPositive?: boolean
      page?: number
      pageSize?: number
    } = {},
  ) => listInventoryLotsImpl(filters),
)

export const exportInventoryLots = withPermission(
  'inventory:export',
  async (
    _session,
    params: Record<string, string | undefined> = {},
    options?: ExportBatchOptions<number>,
  ) => exportInventoryLotsImpl(params, options),
)

export const listInventoryLotOptions = withPermission(
  'inventory:stock_list',
  async (_session, locationId: string, skuId: string) =>
    listInventoryLotOptionsImpl(locationId, skuId),
)
