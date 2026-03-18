import { Suspense } from 'react'
import { getEmployeesPaginated, getMarketsForFilter } from '@/actions/employees'
import { getStores } from '@/actions/stores'
import EmployeesPage from './_components/employees-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: employees, total }, stores, markets] = await Promise.all([
    getEmployeesPaginated({
      marketId: params.market || undefined,
      storeId: params.store,
      status: (params.status as 'active' | 'resigned') || undefined,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
    getMarketsForFilter(),
  ])

  return (
    <Suspense>
      <EmployeesPage employees={employees} stores={stores} markets={markets} total={total} />
    </Suspense>
  )
}
