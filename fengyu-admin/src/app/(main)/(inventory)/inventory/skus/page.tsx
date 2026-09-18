import { Suspense } from 'react'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySupplierOptions } from '@/actions/inventory/suppliers'
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
  const [{ data, total }, locations, supplierOptions] = await Promise.all([
    listInventorySkus({
      keyword: params.q,
      sourceType: params.source as never,
      onlyActive: params.onlyActive !== '0',
      page,
      pageSize,
    }),
    listInventoryLocations(),
    listInventorySupplierOptions(),
  ])
  const actions = session.permissions.actions
  const canCreate = hasUiCapability(actions, 'inventory:supply_chain_master_data_manage') || hasUiCapability(actions, 'inventory:market_sku_manage')
  const canUpdate = canCreate
  const canViewPrice = hasUiCapability(actions, 'inventory:supply_chain_price_view') || hasUiCapability(actions, 'inventory:market_price_view')
  const canManageMarketSkus = hasUiCapability(actions, 'inventory:market_sku_manage')
  const canManageSupplySkus = hasUiCapability(actions, 'inventory:supply_chain_master_data_manage')
  // 建供应商档案要 supply_chain_master_data_manage，而建 SKU 只要 market_sku_manage 也行 ——
  // 市场角色能建 SKU 但不能建档案，快捷入口必须按这个权限单独判，不能跟着 canCreate 走。
  const canCreateSupplier = canManageSupplySkus

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventorySkusPage
          rows={data}
          total={total}
          markets={locations.filter((location) => location.locationType === '市场')}
          supplierOptions={supplierOptions}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canCreateSupplier={canCreateSupplier}
          canViewPrice={canViewPrice}
          canManageMarketSkus={canManageMarketSkus}
          canManageSupplySkus={canManageSupplySkus}
        />
      </Suspense>
    </div>
  )
}
