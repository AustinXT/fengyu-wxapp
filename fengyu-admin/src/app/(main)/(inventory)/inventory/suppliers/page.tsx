import { Suspense } from 'react'
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
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const [rows] = await Promise.all([
    listInventorySuppliers({ keyword: params.q, onlyActive }),
  ])
  const canCreate = hasUiCapability(session.permissions.actions, 'inventory:create')
  const canUpdate = hasUiCapability(session.permissions.actions, 'inventory:update')

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySuppliersPage rows={rows} canCreate={canCreate} canUpdate={canUpdate} />
      </Suspense>
    </div>
  )
}
