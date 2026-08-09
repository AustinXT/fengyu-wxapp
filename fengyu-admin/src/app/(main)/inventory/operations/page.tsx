import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import InventoryOperationsPage from '../_components/inventory-operations-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [locations, skus, suppliers, docs, session] = await Promise.all([
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    listInventorySuppliers({ onlyActive: true }),
    listInventoryCoreDocs({ page: 1, pageSize: 100 }),
    getSession(),
  ])
  const canCreate = session ? hasPermission(session, 'inventory:create_doc') : false
  const canApprove = session ? hasPermission(session, 'inventory:approve') : false
  const canRequestShipmentCancellation = session
    ? isAdminScope(session) || session.roles.some((role) => role.role === 'finance')
    : false
  const canApproveShipmentCancellation = session
    ? isAdminScope(session) || session.roles.some((role) => (
      role.role === 'finance' && role.scopeType === '总部'
    ))
    : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryOperationsPage
          locations={locations}
          skuOptions={skus.data}
          suppliers={suppliers}
          workflowDocs={docs.data}
          canCreate={canCreate}
          canApprove={canApprove}
          canRequestShipmentCancellation={canRequestShipmentCancellation}
          canApproveShipmentCancellation={canApproveShipmentCancellation}
          canViewPrice={docs.canViewPrice}
        />
      </Suspense>
    </div>
  )
}
