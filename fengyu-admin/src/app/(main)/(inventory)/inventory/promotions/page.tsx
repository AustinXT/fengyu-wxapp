import { Suspense } from 'react'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventoryPromotionPlans } from '@/actions/inventory/promotions'
import { getSession } from '@/lib/auth'
import { isInventoryPromotionMaintainer } from '@/lib/inventory/access'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryPromotionsPage from '../_components/inventory-promotions-page'
import { InventoryMasterDataTabs } from '../_components/inventory-master-data-tabs'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:stock_list'])
  // SKU 候选不再预加载（#339）：明细的商品选择按关键词走服务端分页检索
  const [plans, locations] = await Promise.all([
    // 全量取回：本页的筛选在客户端做，分页必须发生在筛选之后（见 engine 注释）
    listInventoryPromotionPlans(),
    listInventoryLocations(),
  ])
  const actions = session.permissions.actions
  const canViewPrice = hasUiCapability(actions, 'inventory:supply_chain_price_view') || hasUiCapability(actions, 'inventory:market_price_view')
  // 报货福利只由总部供应链维护（#354）：与 action / 引擎层同一判据，市场账号只读
  const canCreate = isInventoryPromotionMaintainer(session) && canViewPrice
  const canUpdate = canCreate

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
          canCreate={canCreate}
          canUpdate={canUpdate}
          canViewPrice={canViewPrice}
        />
      </Suspense>
    </div>
  )
}
