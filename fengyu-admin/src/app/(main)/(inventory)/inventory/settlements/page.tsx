import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { listInventorySettlements } from '@/actions/inventory/settlements'
import { getSession } from '@/lib/auth'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventorySettlementsPage from '../_components/inventory-settlements-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list'])
  const report = await listInventorySettlements({
    startDate: params.start,
    endDate: params.end,
  })
  // 门店价格档（none）不可见货款结算页：服务端不返回金额，页面按 404 收口。
  if (!report.canViewMarketSettlement && !report.canViewStoreSettlement) notFound()

  return (
    <div className="p-6">
      <Suspense>
        <InventorySettlementsPage report={report} />
      </Suspense>
    </div>
  )
}
