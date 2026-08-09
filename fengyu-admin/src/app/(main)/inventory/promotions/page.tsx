import { Suspense } from 'react'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventoryPromotionPlans } from '@/actions/inventory/promotions'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import InventoryPromotionsPage from '../_components/inventory-promotions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [plans, locations, skus, session] = await Promise.all([
    listInventoryPromotionPlans(),
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    getSession(),
  ])
  const canViewPrice = session ? hasPermission(session, 'inventory:price_view') : false
  const canCreate = session ? hasPermission(session, 'inventory:create') && canViewPrice : false
  const canUpdate = session ? hasPermission(session, 'inventory:update') && canViewPrice : false
  const canManageGlobal = session
    ? isAdminScope(session) || session.roles.some((role) => role.scopeType === '总部')
    : false

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
