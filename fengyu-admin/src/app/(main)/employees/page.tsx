import { Suspense } from 'react'
import { getEmployeesPaginated } from '@/actions/employees'
import { parseEmployeeFilters, filterValidSkillValues } from '@/lib/list-filters'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import EmployeesPage from './_components/employees-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  // 先取 skillTags 以清洗失效标签：URL ?skill= 可能残留已被删除的标签名（字典外孤儿），
  // 后端 employees.ts 会按 skills 过滤、失效标签会形成「列表被静默过滤但 UI 不可见」的幽灵筛选。
  // getEmployeesPaginated 须串行在 skillTags 之后（依赖 validSkillNames）。
  const session = await getSession()
  const canListOrg = !!session && hasPermission(session, 'org:list')
  const [orgNodes, skillTags] = await Promise.all([
    canListOrg ? getOrgNodes() : Promise.resolve([]),
    getSkillTags(),
  ])
  const validSkillNames = new Set(skillTags.map((t) => t.name))
  const parsed = parseEmployeeFilters(params)

  const { data: employees, total } = await getEmployeesPaginated({
    ...parsed,
    skills: filterValidSkillValues(parsed.skills, validSkillNames),
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })
  const actions = session?.permissions.actions ?? []
  const canCreate = hasUiCapability(actions, 'employee:create')
  const canManageSkillTags = hasUiCapability(actions, 'employee:update')

  return (
    <Suspense>
      <EmployeesPage
        employees={employees}
        total={total}
        orgNodes={orgNodes}
        skillTags={skillTags}
        canCreate={canCreate}
        canManageSkillTags={canManageSkillTags}
        canDeleteSkillTags={canManageSkillTags && !!session && isAdminScope(session)}
      />
    </Suspense>
  )
}
