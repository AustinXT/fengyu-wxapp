'use server'

import {
  createInventorySupplier as createInventorySupplierImpl,
  listInventorySuppliers as listInventorySuppliersImpl,
  updateInventorySupplier as updateInventorySupplierImpl,
} from '@/lib/inventory/engine'
import type { InventorySupplierInput } from '@/lib/inventory/types'
import { withPermission } from '@/lib/with-permission'

export const listInventorySuppliers = withPermission(
  'inventory:stock_list',
  async (_session, filters: { keyword?: string; onlyActive?: boolean } = {}) =>
    listInventorySuppliersImpl(filters),
)

export const createInventorySupplier = withPermission(
  'inventory:supply_chain_master_data_manage',
  async (_session, input: InventorySupplierInput) => createInventorySupplierImpl(input),
)

export const updateInventorySupplier = withPermission(
  'inventory:supply_chain_master_data_manage',
  async (_session, supplierId: string, input: Partial<InventorySupplierInput>) =>
    updateInventorySupplierImpl(supplierId, input),
)
