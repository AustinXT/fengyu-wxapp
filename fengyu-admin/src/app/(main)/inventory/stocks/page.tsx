import { Suspense } from 'react'
import { listInventoryStocks } from '@/actions/inventory-v2'
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
    listInventoryStocks({
      keyword: params.q,
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
