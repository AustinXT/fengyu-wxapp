import { Suspense } from 'react'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { supplierCreationOwner } from '@/lib/inventory/supplier-access'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventorySuppliersPage from '../_components/inventory-suppliers-page'
import { InventoryMasterDataTabs } from '../_components/inventory-master-data-tabs'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const onlyActive = params.status === 'active'
    ? true
    : params.status === 'inactive'
      ? false
      : undefined
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const [suppliers, locations] = await Promise.all([
    listInventorySuppliers({ keyword: params.q, onlyActive, page, pageSize }),
    listInventoryLocations(),
  ])
  const canUpdate = hasUiCapability(session.permissions.actions, 'inventory:supply_chain_master_data_manage')
    || hasUiCapability(session.permissions.actions, 'inventory:market_sku_manage')
  let canCreate = canUpdate
  let creationOwnerLabel = '供应链共有'
  if (canCreate) {
    try {
      const owner = supplierCreationOwner(session)
      if (owner) creationOwnerLabel = locations.find((row) => row.locationId === owner)?.name ?? owner
    } catch { canCreate = false }
  }

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySuppliersPage
          rows={suppliers.data}
          total={suppliers.total}
          canCreate={canCreate}
          canUpdate={canUpdate}
          creationOwnerLabel={creationOwnerLabel}
        />
      </Suspense>
    </div>
  )
}
