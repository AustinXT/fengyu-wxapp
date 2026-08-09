import { Suspense } from 'react'
import { listInventoryLots } from '@/actions/inventory/stocks'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
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
  const [{ data, total, canViewPrice }, session] = await Promise.all([
    listInventoryLots({
      keyword: params.q,
      locationId: params.location,
      locationType: params.type as never,
      onlyPositive: params.onlyPositive === '1',
      page,
      pageSize,
    }),
    getSession(),
  ])
  const canExport = session ? hasPermission(session, 'inventory:export') : false

  return (
    <div className="p-6">
      <Suspense>
        <InventoryStocksPage
          rows={data}
          total={total}
          canViewPrice={canViewPrice}
          canExport={canExport}
        />
      </Suspense>
    </div>
  )
}
