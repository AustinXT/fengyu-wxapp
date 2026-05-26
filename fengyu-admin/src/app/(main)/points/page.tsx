import { Suspense } from 'react'
import { getPointTransactionsPaginated } from '@/actions/points'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import PointsPageClient from './_components/points-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data, total, summary, distinctTypes }, stores, orgNodes] = await Promise.all([
    getPointTransactionsPaginated({
      marketId: params.market,
      storeId: params.store,
      type: params.type,
      search: params.q,
      startDate: params.start,
      endDate: params.end,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <PointsPageClient
        transactions={data}
        total={total}
        summary={summary}
        distinctTypes={distinctTypes}
        stores={stores}
        orgNodes={orgNodes}
      />
    </Suspense>
  )
}
