import { Suspense } from 'react'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventorySkusPage from '../_components/inventory-skus-page'
import { InventoryMasterDataTabs } from '../_components/inventory-master-data-tabs'

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
  const [{ data, total }, locations] = await Promise.all([
    listInventorySkus({
      keyword: params.q,
      sourceType: params.source as never,
      onlyActive: params.onlyActive !== '0',
      page,
      pageSize,
    }),
    listInventoryLocations(),
  ])
  const actions = session.permissions.actions
  const canCreate = hasUiCapability(actions, 'inventory:supply_chain_master_data_manage') || hasUiCapability(actions, 'inventory:market_sku_manage')
  const canUpdate = canCreate
  const canViewPrice = hasUiCapability(actions, 'inventory:supply_chain_price_view') || hasUiCapability(actions, 'inventory:market_price_view')
  const canManageMarketSkus = hasUiCapability(actions, 'inventory:market_sku_manage')
  const canManageSupplySkus = hasUiCapability(actions, 'inventory:supply_chain_master_data_manage')

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySkusPage
          rows={data}
          total={total}
          markets={locations.filter((location) => location.locationType === '市场')}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canViewPrice={canViewPrice}
          canManageMarketSkus={canManageMarketSkus}
          canManageSupplySkus={canManageSupplySkus}
        />
      </Suspense>
    </div>
  )
}
