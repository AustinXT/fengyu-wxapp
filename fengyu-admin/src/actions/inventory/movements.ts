'use server'

import {
  exportInventoryMovements as exportInventoryMovementsImpl,
  listInventoryMovements as listInventoryMovementsImpl,
} from '@/lib/inventory/movements'
import type { ExportBatchOptions } from '@/lib/export-pagination'
import type { InventoryMovementListParams } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventoryMovements = withPermission(
  'inventory:stock_list',
  async (
    _session,
    params: InventoryMovementListParams,
  ) => listInventoryMovementsImpl(params),
)

export const exportInventoryMovements = withPermission(
  'inventory:export',
  async (
    _session,
    params: Record<string, string | undefined> = {},
    options?: ExportBatchOptions<number>,
  ) => exportInventoryMovementsImpl(params, options),
)
