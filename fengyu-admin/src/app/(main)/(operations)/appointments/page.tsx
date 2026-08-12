import { getAppointmentsPaginated } from '@/actions/appointments'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import AppointmentsPageClient from './_components/appointments-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const tab = (params.tab || 'pending') as 'pending' | 'confirmed' | 'today' | 'all'

  const [result, filterOptions, session] = await Promise.all([
    getAppointmentsPaginated({
      tab,
      marketId: params.market,
      storeId: params.store,
      dateFrom: params.from,
      dateTo: params.to,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMarketStoreFilterOptions(),
    getSession(),
  ])

  const actions = session?.permissions.actions ?? []
  const canConfirm = hasUiCapability(actions, 'appointment:confirm')
  const canCheckin = hasUiCapability(actions, 'appointment:checkin')
  const canDelete = !!(session && hasUiCapability(actions, 'appointment:delete') && isAdminScope(session))

  return (
    <AppointmentsPageClient
      appointments={result.data}
      filterOptions={filterOptions}
      total={result.total}
      pendingCount={result.pendingCount}
      confirmedCount={result.confirmedCount}
      canConfirm={canConfirm}
      canCheckin={canCheckin}
      canDelete={canDelete}
    />
  )
}
