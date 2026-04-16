import { Suspense } from 'react'
import { getCardsPaginated, type CardFilters } from '@/actions/cards'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import CardsPageClient from './_components/cards-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const type = (params.type as CardFilters['type']) || undefined
  const status = (params.status as CardFilters['status']) || undefined

  const [{ data: cards, total }, stores, orgNodes] = await Promise.all([
    getCardsPaginated({
      marketId: params.market,
      storeId: params.store,
      type: type === '疗程卡' || type === '单次卡' || type === 'all' ? type : undefined,
      status: status === 'active' || status === 'exhausted' || status === 'expired' ? status : undefined,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <CardsPageClient cards={cards} stores={stores} orgNodes={orgNodes} total={total} />
    </Suspense>
  )
}
