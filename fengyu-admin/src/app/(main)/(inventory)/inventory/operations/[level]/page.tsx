import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import {
  INVENTORY_BUSINESS_LEVELS,
  requireInventoryBusinessLevel,
  type InventoryBusinessLevel,
} from '@/lib/inventory/business-level'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryOperationsPage from '../../_components/inventory-operations-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ level: string }> }) {
  const { level: rawLevel } = await params
  if (!INVENTORY_BUSINESS_LEVELS.includes(rawLevel as InventoryBusinessLevel)) notFound()
  const level = rawLevel as InventoryBusinessLevel
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  requireInventoryBusinessLevel(session, level)
  const [locations, skus, suppliers, docs] = await Promise.all([
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    listInventorySuppliers({ onlyActive: true }),
    listInventoryCoreDocs({ page: 1, pageSize: 100 }),
  ])
  const actions = session.permissions.actions

  return (
    <div className="p-6">
      <Suspense>
        <InventoryOperationsPage
          level={level}
          locations={locations}
          skuOptions={skus.data}
          suppliers={suppliers}
          workflowDocs={docs.data}
          canCreate={hasUiCapability(actions, 'inventory:create_doc')}
          canApprove={hasUiCapability(actions, 'inventory:approve')}
          canSelfPurchase={hasUiCapability(actions, 'inventory:self_purchase_receive')}
          canRequestShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_request')}
          canApproveShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_approve')}
          canViewPrice={docs.canViewPrice}
        />
      </Suspense>
    </div>
  )
}
