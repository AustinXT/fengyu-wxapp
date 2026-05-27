import { Suspense } from 'react'
import { getPointTransactionsPaginated } from '@/actions/points'
import { parsePointFilters } from '@/lib/list-filters'
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
      ...parsePointFilters(params),
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
