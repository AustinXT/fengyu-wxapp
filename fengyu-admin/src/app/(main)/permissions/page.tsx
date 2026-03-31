import { Suspense } from 'react'
import { getRoles } from '@/actions/permissions'
import { getEmployees, getEmployeesPaginated } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [roles, { data: paginatedEmployees, total: employeeTotal }, allEmployees, orgNodes] = await Promise.all([
    getRoles(),
    getEmployeesPaginated({
      status: 'active',
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getEmployees(),
    getOrgNodes(),
  ])

  return (
    <Suspense>
      <PermissionsPage
        roles={roles}
        paginatedEmployees={paginatedEmployees}
        employeeTotal={employeeTotal}
        allEmployees={allEmployees}
        orgNodes={orgNodes}
      />
    </Suspense>
  )
}
