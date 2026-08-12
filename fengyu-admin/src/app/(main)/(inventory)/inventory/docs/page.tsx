import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
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
  const [docs, locations, skus] = await Promise.all([
    listInventoryCoreDocs({
      locationId: params.location,
      docType: params.docType as never,
      status: params.status as never,
      keyword: params.q,
      page,
      pageSize,
    }),
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
  ])
  const canCreate = hasUiCapability(session.permissions.actions, 'inventory:create_doc')
  const canApprove = hasUiCapability(session.permissions.actions, 'inventory:approve')

  return (
    <div className="p-6">
      <Suspense>
        <InventoryDocsPage
          rows={docs.data}
          total={docs.total}
          locations={locations}
          skuOptions={skus.data}
          canCreate={canCreate}
          canApprove={canApprove}
          canViewPrice={docs.canViewPrice}
        />
      </Suspense>
    </div>
  )
}
