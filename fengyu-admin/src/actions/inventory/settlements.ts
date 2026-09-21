'use server'

import { listInventorySettlements as listInventorySettlementsImpl } from '@/lib/inventory/settlements'
import { withPermission } from '@/lib/with-permission'

export const listInventorySettlements = withPermission(
  'inventory:list',
  async (_session, filters: { startDate?: string; endDate?: string } = {}) =>
    listInventorySettlementsImpl(filters),
)
