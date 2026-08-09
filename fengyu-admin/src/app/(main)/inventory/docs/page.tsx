import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
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
  const [docs, locations, skus, session] = await Promise.all([
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
    getSession(),
  ])
  const canCreate = session ? hasPermission(session, 'inventory:create_doc') : false
  const canApprove = session ? hasPermission(session, 'inventory:approve') : false

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
