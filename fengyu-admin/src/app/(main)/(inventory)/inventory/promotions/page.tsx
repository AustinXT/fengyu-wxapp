import { Suspense } from 'react'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventoryPromotionPlans } from '@/actions/inventory/promotions'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryPromotionsPage from '../_components/inventory-promotions-page'
import { InventoryMasterDataTabs } from '../_components/inventory-master-data-tabs'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  const [plans, locations, skus] = await Promise.all([
    listInventoryPromotionPlans(),
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
  ])
  const actions = session.permissions.actions
  const canViewPrice = hasUiCapability(actions, 'inventory:supply_chain_price_view') || hasUiCapability(actions, 'inventory:market_price_view')
  const canCreate = (hasUiCapability(actions, 'inventory:supply_chain_master_data_manage') || hasUiCapability(actions, 'inventory:market_operate')) && canViewPrice
  const canUpdate = canCreate
  const canManageGlobal = hasUiCapability(actions, 'inventory:supply_chain_master_data_manage')

  // 未获价格权限的使用者只接收非金额的方案信息，避免客户端 props 暴露优惠金额。
  const visiblePlans = canViewPrice
    ? plans
    : plans.map((plan) => ({
      ...plan,
      items: plan.items.map((item) => ({
        ...item,
        marketUnitDiscount: 0,
      })),
    }))

  return (
    <div className="p-6">
      <InventoryMasterDataTabs />
      <Suspense>
        <InventoryPromotionsPage
          rows={visiblePlans}
          marketOptions={locations
            .filter((location) => location.locationType === '市场')
            .map((location) => ({ locationId: location.locationId, name: location.name }))}
          skuOptions={skus.data}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canViewPrice={canViewPrice}
          canManageGlobal={canManageGlobal}
        />
      </Suspense>
    </div>
  )
}
