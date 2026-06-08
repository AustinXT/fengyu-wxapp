import { getAppointmentsPaginated } from '@/actions/appointments'
import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import AppointmentsPageClient from './_components/appointments-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const tab = (params.tab || 'pending') as 'pending' | 'confirmed' | 'today' | 'all'

  const [result, stores, session] = await Promise.all([
    getAppointmentsPaginated({
      tab,
      storeId: params.store,
      dateFrom: params.from,
      dateTo: params.to,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getSession(),
  ])

  const canDelete = session ? hasPermission(session, 'appointment:delete') : false

  return (
    <AppointmentsPageClient
      appointments={result.data}
      stores={stores}
      total={result.total}
      pendingCount={result.pendingCount}
      confirmedCount={result.confirmedCount}
      canDelete={canDelete}
    />
  )
}
