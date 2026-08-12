import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryOperationsPage from '../_components/inventory-operations-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  const [locations, skus, suppliers, docs] = await Promise.all([
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    listInventorySuppliers({ onlyActive: true }),
    listInventoryCoreDocs({ page: 1, pageSize: 100 }),
  ])
  const actions = session.permissions.actions
  const canCreate = hasUiCapability(actions, 'inventory:create_doc')
  const canApprove = hasUiCapability(actions, 'inventory:approve')
  const canSelfPurchase = hasUiCapability(actions, 'inventory:self_purchase_receive')
  const canRequestShipmentCancellation = hasUiCapability(actions, 'inventory:shipment_cancel_request')
  const canApproveShipmentCancellation = hasUiCapability(actions, 'inventory:shipment_cancel_approve')

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
          canSelfPurchase={canSelfPurchase}
          canRequestShipmentCancellation={canRequestShipmentCancellation}
          canApproveShipmentCancellation={canApproveShipmentCancellation}
          canViewPrice={docs.canViewPrice}
        />
      </Suspense>
    </div>
  )
}
