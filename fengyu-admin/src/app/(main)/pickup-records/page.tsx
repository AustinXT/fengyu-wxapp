import { Suspense } from 'react'
import { getPickupRecordsPaginated } from '@/actions/pickup-records'
import { getStores } from '@/actions/stores'
import { getSession, hasPermission } from '@/lib/auth'
import PickupRecordsPageClient from './_components/pickup-records-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: records, total }, stores, session] = await Promise.all([
    getPickupRecordsPaginated({
      storeId: params.store,
      search: params.q,
      dateFrom: params.from,
      dateTo: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getSession(),
  ])

  const canCreate = session ? hasPermission(session, 'pickup_record:create') : false

  return (
    <Suspense>
      <PickupRecordsPageClient
        records={records}
        stores={stores}
        total={total}
        canCreate={canCreate}
      />
    </Suspense>
  )
}
