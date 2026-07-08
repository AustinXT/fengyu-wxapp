import { Suspense } from 'react'
import { getCardsPaginated } from '@/actions/cards'
import { parseCardFilters } from '@/lib/list-filters'
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

  const [{ data: cards, total }, stores, orgNodes] = await Promise.all([
    getCardsPaginated(parseCardFilters(params)),
    getStores(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <CardsPageClient cards={cards} stores={stores} orgNodes={orgNodes} total={total} />
    </Suspense>
  )
}
