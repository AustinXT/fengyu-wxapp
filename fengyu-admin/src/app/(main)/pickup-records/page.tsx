import { Suspense } from 'react'
import { getPickupRecordsPaginated } from '@/actions/pickup-records'
import { getStores } from '@/actions/stores'
import PickupRecordsPageClient from './_components/pickup-records-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: records, total }, stores] = await Promise.all([
    getPickupRecordsPaginated({
      storeId: params.store,
      search: params.q,
      dateFrom: params.from,
      dateTo: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
  ])

  return (
    <Suspense>
      <PickupRecordsPageClient records={records} stores={stores} total={total} />
    </Suspense>
  )
}
