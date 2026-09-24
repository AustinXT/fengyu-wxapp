import { Suspense } from 'react'
import { getCardTransactionsPaginated } from '@/actions/card-transactions'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import CardTransactionsPageClient from './_components/card-transactions-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const type = params.type === '充值' || params.type === '扣款' ? params.type : undefined

  const [{ data, total, summary }, filterOptions] = await Promise.all([
    getCardTransactionsPaginated({
      marketId: params.market,
      storeId: params.store,
      type,
      search: params.q,
      startDate: params.start,
      endDate: params.end,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <CardTransactionsPageClient
        transactions={data}
        total={total}
        summary={summary}
        filterOptions={filterOptions}
      />
    </Suspense>
  )
}
