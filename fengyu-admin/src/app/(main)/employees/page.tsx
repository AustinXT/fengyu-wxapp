import { Suspense } from 'react'
import { getEmployeesPaginated } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import { getPositions } from '@/actions/positions'
import { getSkillTags } from '@/actions/skill-tags'
import EmployeesPage from './_components/employees-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: employees, total }, orgNodes, positions, skillTags] = await Promise.all([
    getEmployeesPaginated({
      marketId: params.market || undefined,
      storeId: params.store,
      status: (params.status as 'active' | 'resigned') || undefined,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getOrgNodes(),
    getPositions(),
    getSkillTags(),
  ])

  return (
    <Suspense>
      <EmployeesPage employees={employees} total={total} orgNodes={orgNodes} positions={positions} skillTags={skillTags} />
    </Suspense>
  )
}
