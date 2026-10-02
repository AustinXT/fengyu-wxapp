'use server'

import {
  countInventorySkusBySupplier as countInventorySkusBySupplierImpl,
  createInventorySupplier as createInventorySupplierImpl,
  listInventorySupplierOptions as listInventorySupplierOptionsImpl,
  listInventorySuppliers as listInventorySuppliersImpl,
  updateInventorySupplier as updateInventorySupplierImpl,
} from '@/lib/inventory/engine'
import type { InventorySupplierInput } from '@/lib/inventory/types'
import { SUPPLIER_MANAGE_ACTIONS } from '@/lib/inventory/supplier-access'
import { withAnyPermission, withPermission } from '@/lib/with-permission'

export const listInventorySuppliers = withPermission(
  'inventory:stock_list',
  async (
    _session,
    filters: { keyword?: string; onlyActive?: boolean; page?: number; pageSize?: number } = {},
  ) => listInventorySuppliersImpl(filters),
)

export const countInventorySkusBySupplier = withPermission(
  'inventory:stock_list',
  async (_session, supplierId: string) => countInventorySkusBySupplierImpl(supplierId),
)

export const listInventorySupplierOptions = withPermission(
  'inventory:stock_list',
  async () => listInventorySupplierOptionsImpl(),
)

export const createInventorySupplier = withAnyPermission(
  SUPPLIER_MANAGE_ACTIONS,
  async (_session, input: InventorySupplierInput) => createInventorySupplierImpl(input),
)

export const updateInventorySupplier = withAnyPermission(
  SUPPLIER_MANAGE_ACTIONS,
  async (_session, supplierId: string, input: Partial<InventorySupplierInput>) =>
    updateInventorySupplierImpl(supplierId, input),
)
