import { Suspense } from 'react'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import InventorySkusPage from '../_components/inventory-skus-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const [{ data, total }, locations, session] = await Promise.all([
    listInventorySkus({
      keyword: params.q,
      sourceType: params.source as never,
      onlyActive: params.onlyActive !== '0',
      page,
      pageSize,
    }),
    listInventoryLocations(),
    getSession(),
  ])
  const canCreate = session ? hasPermission(session, 'inventory:create') : false
  const canUpdate = session ? hasPermission(session, 'inventory:update') : false
  const canViewPrice = session ? hasPermission(session, 'inventory:price_view') : false

  return (
    <div className="p-6">
      <Suspense>
        <InventorySkusPage
          rows={data}
          total={total}
          markets={locations.filter((location) => location.locationType === '市场')}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canViewPrice={canViewPrice}
        />
      </Suspense>
    </div>
  )
}
