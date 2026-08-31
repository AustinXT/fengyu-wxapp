import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
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

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ level: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { level: rawLevel } = await params
  const query = await searchParams
  if (!INVENTORY_BUSINESS_LEVELS.includes(rawLevel as InventoryBusinessLevel)) notFound()
  const level = rawLevel as InventoryBusinessLevel
  if (query.view === 'docs' || query.create) {
    const target = new URLSearchParams()
    for (const key of ['create', 'docType', 'status', 'q', 'orgNodeId']) {
      if (query[key]) target.set(key, query[key]!)
    }
    redirect(`/inventory/docs${target.size > 0 ? `?${target.toString()}` : ''}`)
  }
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  requireInventoryBusinessLevel(session, level)
  const [locations, skus, suppliers, workflowDocs] = await Promise.all([
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    listInventorySuppliers({ onlyActive: true }),
    listInventoryCoreDocs({ page: 1, pageSize: 100 }),
  ])
  const actions = session.permissions.actions
  const operateAction = level === 'supply-chain'
    ? 'inventory:supply_chain_operate'
    : level === 'market'
      ? 'inventory:market_operate'
      : 'inventory:store_operate'
  const approveAction = level === 'supply-chain'
    ? 'inventory:supply_chain_approve'
    : level === 'market'
      ? 'inventory:market_approve'
      : null
  const canCreate = hasUiCapability(actions, operateAction)
  const canApprove = approveAction ? hasUiCapability(actions, approveAction) : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryOperationsPage
          level={level}
          locations={locations}
          skuOptions={skus.data}
          suppliers={suppliers}
          workflowDocs={workflowDocs.data}
          canCreate={canCreate}
          canApprove={canApprove}
          canSelfPurchase={hasUiCapability(actions, 'inventory:self_purchase_receive')}
          canRequestShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_request')}
          canApproveShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_approve')}
          canViewPrice={workflowDocs.canViewPrice}
        />
      </Suspense>
    </div>
  )
}
