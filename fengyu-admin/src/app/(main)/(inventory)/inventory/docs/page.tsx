import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import {
  listInventoryDocLocationFilterOptions,
  listInventoryLocations,
} from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
import { genericDocBusinessLevel } from '@/lib/inventory/business-level'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import { INVENTORY_GENERIC_DOC_TYPES, type InventoryDocType } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryDocsPage from '../_components/inventory-docs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])

  const actions = session.permissions.actions
  const operateByLevel = {
    'supply-chain': hasUiCapability(actions, 'inventory:supply_chain_operate'),
    market: hasUiCapability(actions, 'inventory:market_operate'),
    store: hasUiCapability(actions, 'inventory:store_operate'),
  }
  const allowedCreateDocTypes = INVENTORY_GENERIC_DOC_TYPES.filter((docType) => {
    const level = genericDocBusinessLevel(docType)
    return level ? operateByLevel[level] : false
  })
  const requestedCreateType = params.create as InventoryDocType | undefined
  const initialDocType = requestedCreateType
    && (allowedCreateDocTypes as readonly InventoryDocType[]).includes(requestedCreateType)
      ? requestedCreateType
      : undefined

  const [filterOptions, locations, skus] = await Promise.all([
    listInventoryDocLocationFilterOptions(),
    allowedCreateDocTypes.length > 0 ? listInventoryLocations() : Promise.resolve([]),
    allowedCreateDocTypes.length > 0
      ? listInventorySkus({ page: 1, pageSize: 100, onlyActive: true })
      : Promise.resolve({ data: [], total: 0 }),
  ])
  const selectedOrgNodeId = resolveInventoryFilterLocationId(filterOptions, params.orgNodeId)
  const docs = selectedOrgNodeId
    ? await listInventoryCoreDocs({
        orgNodeId: selectedOrgNodeId,
        docType: params.docType as never,
        status: params.status as never,
        keyword: params.q,
        page,
        pageSize,
      })
    : {
        data: [],
        total: 0,
        canViewPrice: hasUiCapability(actions, 'inventory:supply_chain_price_view')
          || hasUiCapability(actions, 'inventory:market_price_view'),
      }

  return (
    <div className="p-6">
      <Suspense>
        <InventoryDocsPage
          rows={docs.data}
          total={docs.total}
          locations={locations}
          skuOptions={skus.data}
          canCreate={allowedCreateDocTypes.length > 0}
          canApprove={hasUiCapability(actions, 'inventory:supply_chain_approve') || hasUiCapability(actions, 'inventory:market_approve')}
          canReceive={operateByLevel.market || operateByLevel.store}
          canViewPrice={docs.canViewPrice}
          initialDocType={initialDocType}
          allowedCreateDocTypes={allowedCreateDocTypes}
          locationFilterOptions={filterOptions}
          selectedOrgNodeId={selectedOrgNodeId}
        />
      </Suspense>
    </div>
  )
}
