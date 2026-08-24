import { Suspense } from 'react'
import { getPointTransactionsPaginated } from '@/actions/points'
import { parsePointFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import PointsPageClient from './_components/points-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data, total, summary, distinctTypes }, filterOptions] = await Promise.all([
    getPointTransactionsPaginated({
      ...parsePointFilters(params),
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <PointsPageClient
        transactions={data}
        total={total}
        summary={summary}
        distinctTypes={distinctTypes}
        filterOptions={filterOptions}
      />
    </Suspense>
  )
}
