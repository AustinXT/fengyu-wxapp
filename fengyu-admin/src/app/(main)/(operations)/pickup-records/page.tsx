import { Suspense } from 'react'
import { getPickupRecordsPaginated } from '@/actions/pickup-records'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
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

  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'pickup_record:create')
  const canDelete = !!(session && hasUiCapability(actions, 'pickup_record:delete') && isAdminScope(session))

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
