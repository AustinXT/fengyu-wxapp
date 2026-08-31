import { Suspense } from 'react'
import { listInventoryLocationFilterOptions } from '@/actions/inventory/locations'
import { listInventoryLots } from '@/actions/inventory/stocks'
import { getSession } from '@/lib/auth'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryStocksPage from '../_components/inventory-stocks-page'

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
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const filterOptions = await listInventoryLocationFilterOptions()
  const selectedLocationId = resolveInventoryFilterLocationId(filterOptions, params.location)
  const { data, total, canViewPrice } = selectedLocationId
    ? await listInventoryLots({
      keyword: params.q,
      locationId: selectedLocationId,
      onlyPositive: params.onlyPositive === '1',
      page,
      pageSize,
    })
    : {
        data: [],
        total: 0,
        canViewPrice: hasUiCapability(session.permissions.actions, 'inventory:supply_chain_price_view') || hasUiCapability(session.permissions.actions, 'inventory:market_price_view'),
      }
  const canExport = hasUiCapability(session.permissions.actions, 'inventory:export')

  return (
    <div className="p-6">
      <Suspense>
        <InventoryStocksPage
          rows={data}
          total={total}
          canViewPrice={canViewPrice}
          canExport={canExport}
          locationFilterOptions={filterOptions}
          selectedLocationId={selectedLocationId}
        />
      </Suspense>
    </div>
  )
}
