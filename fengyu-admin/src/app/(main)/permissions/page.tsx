import { Suspense } from 'react'
import { getRolesByScope, getRoleCountsByScope } from '@/actions/permissions'
import { getRoleDefinitions } from '@/actions/role-definitions'
import { getEmployees } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import { getSession } from '@/lib/auth'
import { accessiblePermissionScopeIds } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [orgNodes, allEmployees, roleCounts, roleDefinitions, session] = await Promise.all([
    getOrgNodes(),
    getEmployees(),
    getRoleCountsByScope(),
    getRoleDefinitions(),
    getSession(),
  ])

  // 操作者可操作的节点：admin → null（全开）；非 admin → 绑定节点自身及所有后代。
  const accessibleScopeIds = session ? accessiblePermissionScopeIds(session) : null
  // 撤销角色：持有 permission:revoke 的角色（admin + hr）可见可执行
  const actions = session?.permissions.actions ?? []
  const canAssign = hasUiCapability(actions, 'permission:assign')
  const canAssignAdmin = hasUiCapability(actions, 'permission:assign_admin')
  const canDelete = hasUiCapability(actions, 'permission:revoke')

  // 默认选中节点：admin → 总部；非 admin → 其原始绑定节点，避免后代数组顺序改变默认落点。
  const hqNode = orgNodes.find(n => n.type === '总部')
  const fallbackId = hqNode?.id ?? orgNodes.find(n => !n.parentId)?.id ?? ''
  const rawRoleScopeId = session?.roles.find((role) => (
    !accessibleScopeIds || accessibleScopeIds.includes(role.scopeId)
  ))?.scopeId
  const defaultScopeId = rawRoleScopeId
    ?? (accessibleScopeIds && accessibleScopeIds.length > 0 ? accessibleScopeIds[0] : fallbackId)
  const initialRoles = defaultScopeId ? await getRolesByScope(defaultScopeId) : []

  return (
    <Suspense>
      <PermissionsPage
        initialRoles={initialRoles}
        initialScopeId={defaultScopeId}
        roleCounts={roleCounts}
        roleDefinitions={roleDefinitions}
        allEmployees={allEmployees}
        orgNodes={orgNodes}
        accessibleScopeIds={accessibleScopeIds}
        canAssign={canAssign}
        canAssignAdmin={canAssignAdmin}
        canDelete={canDelete}
      />
    </Suspense>
  )
}
