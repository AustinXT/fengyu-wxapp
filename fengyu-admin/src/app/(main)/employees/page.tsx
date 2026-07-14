import { Suspense } from 'react'
import { getEmployeesPaginated } from '@/actions/employees'
import { parseEmployeeFilters, filterValidSkillValues } from '@/lib/list-filters'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import EmployeesPage from './_components/employees-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  
  
  
  
  const [orgNodes, skillTags, session] = await Promise.all([
    getOrgNodes(),
    getSkillTags(),
    getSession(),
  ])
  const validSkillNames = new Set(skillTags.filter((t) => t.isValid).map((t) => t.name))
  const parsed = parseEmployeeFilters(params)

  const { data: employees, total } = await getEmployeesPaginated({
    ...parsed,
    skills: filterValidSkillValues(parsed.skills, validSkillNames),
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })
  const canDelete = !!session && isAdminScope(session)

  return (
    <Suspense>
      <EmployeesPage employees={employees} total={total} orgNodes={orgNodes} skillTags={skillTags} canDelete={canDelete} />
    </Suspense>
  )
}
