import { Suspense } from 'react'
import { getCardFilterOptions, getCardsPaginated } from '@/actions/cards'
import { parseCardFilters } from '@/lib/list-filters'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import CardsPageClient from './_components/cards-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: cards, total }, filterOptions, cardFilterOptions] = await Promise.all([
    getCardsPaginated(parseCardFilters(params)),
    getMarketStoreFilterOptions(),
    getCardFilterOptions(),
  ])

  return (
    <Suspense>
      <CardsPageClient
        cards={cards}
        filterOptions={filterOptions}
        cardFilterOptions={cardFilterOptions}
        total={total}
      />
    </Suspense>
  )
}
