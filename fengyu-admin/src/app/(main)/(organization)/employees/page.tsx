import { Suspense } from 'react'
import { getEmployeesPaginated } from '@/actions/employees'
import { parseEmployeeFilters, filterValidSkillValues } from '@/lib/list-filters'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { scopeSessionToActions } from '@/lib/action-scope'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
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
  requireUiPageCapability(session, 'employee:create')
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
  // 技能标签的增/改/删统一为「仅系统管理员」，与 skill-tags.ts 三个写操作的
  // requireAdmin 硬闸门同口径（#211）。
  //
  // 两个条件缺一不可，且必须与服务端逐位同构：
  // ① employee:update —— 外层 withPermission 用它把关，运营若在矩阵 UI 摘掉 admin 的
  //    该权限，服务端会先拒，UI 不该显示一个点了就报错的按钮；
  // ② isAdminScope 判的是 scopeSessionToActions 收紧后的角色 —— withPermission 交给
  //    requireAdmin 的正是这份收紧 session（with-permission.ts:70 → action-scope.ts:25），
  //    它只保留「自身 actions 含 employee:update」的角色行。若这里图省事用原始 session，
  //    admin+hr 双角色会话在 admin 被摘掉该权限时会算出 true（hr 补上了 union），
  //    而服务端收紧后只剩 hr → 按钮可见却必然被拒。
  const canManageSkillTags =
    hasUiCapability(actions, 'employee:update')
    && isAdminScope(scopeSessionToActions(session, ['employee:update']))

  return (
    <Suspense>
      <EmployeesPage
        employees={employees}
        total={total}
        orgNodes={orgNodes}
        skillTags={skillTags}
        canCreate={canCreate}
        canManageSkillTags={canManageSkillTags}
      />
    </Suspense>
  )
}
