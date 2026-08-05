import { Suspense } from 'react'
import { getPickupRecordsPaginated } from '@/actions/pickup-records'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import PickupRecordsPageClient from './_components/pickup-records-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: records, total }, filterOptions, session] = await Promise.all([
    getPickupRecordsPaginated({
      marketId: params.market,
      storeId: params.store,
      search: params.q,
      dateFrom: params.from,
      dateTo: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
    getSession(),
  ])

  const canCreate = session ? hasPermission(session, 'pickup_record:create') : false
  const canDelete = session ? isAdminScope(session) : false

  return (
    <Suspense>
      <PickupRecordsPageClient
        records={records}
        filterOptions={filterOptions}
        total={total}
        canCreate={canCreate}
        canDelete={canDelete}
      />
    </Suspense>
  )
}
