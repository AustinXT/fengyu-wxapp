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

  // 先取 skillTags 以清洗失效标签：URL ?skill= 可能残留 admin 已停用的标签，
  // 后端 employees.ts 会按 skills 过滤、前端 MultiSelect options 仅含 isValid 标签，
  // 失效标签会形成「列表被静默过滤但 UI 不可见、组件内不可清除」的幽灵筛选。
  // getEmployeesPaginated 须串行在 skillTags 之后（依赖 validSkillNames）。
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
