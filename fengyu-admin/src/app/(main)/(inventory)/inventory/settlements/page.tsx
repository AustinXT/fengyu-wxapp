import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { listInventorySettlements } from '@/actions/inventory/settlements'
import { getSession } from '@/lib/auth'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import { hasUiCapability } from '@/lib/permission-contract'
import InventorySettlementsPage from '../_components/inventory-settlements-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:store_settlement_view'])
  const report = await listInventorySettlements({
    startDate: params.start,
    endDate: params.end,
    market: params.market,
  })
  // 无价格权且没有同绑定门店结算权时，页面按 404 收口。
  if (!report.canViewMarketSettlement && !report.canViewStoreSettlement) notFound()

  return (
    <div className="p-6">
      <Suspense>
        <InventorySettlementsPage
          report={report}
          canExport={hasUiCapability(session.permissions.actions, 'inventory:export')}
        />
      </Suspense>
    </div>
  )
}
