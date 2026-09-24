import { Suspense } from 'react'
import { listInventoryLocationFilterOptions } from '@/actions/inventory/locations'
import { listInventoryLots } from '@/actions/inventory/stocks'
import { getSession } from '@/lib/auth'
import { canViewInventoryAmount, inventoryPriceVisibility } from '@/lib/inventory/access'
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
  const { data, total, canViewPrice, priceVisibility } = selectedLocationId
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
        // 未选主体的空态分支：用 access.ts 里的同一对 helper，别再手写
        // `hasUiCapability(supply) || hasUiCapability(market)` —— 那与
        // inventoryPriceVisibility 有口径差（后者对 isAdminScope 直接返回 'all'，不看 actions）。
        canViewPrice: canViewInventoryAmount(session),
        priceVisibility: inventoryPriceVisibility(session),
      }
  const canExport = hasUiCapability(session.permissions.actions, 'inventory:export')

  return (
    <div className="p-6">
      <Suspense>
        <InventoryStocksPage
          rows={data}
          total={total}
          canViewPrice={canViewPrice}
          priceVisibility={priceVisibility}
          canExport={canExport}
          locationFilterOptions={filterOptions}
          selectedLocationId={selectedLocationId}
        />
      </Suspense>
    </div>
  )
}
