import { Suspense } from 'react'
import { getRolesByScope, getRoleCountsByScope } from '@/actions/permissions'
import { getEmployees } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import { getSession } from '@/lib/auth'
import { accessiblePermissionScopeIds, hasPermission } from '@/lib/permissions'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [orgNodes, allEmployees, roleCounts, session] = await Promise.all([
    getOrgNodes(),
    getEmployees(),
    getRoleCountsByScope(),
    getSession(),
  ])

  // 操作者可操作的 scope 节点集合：admin → null（全开）；非 admin → 精确 scopeId（不展开子树）
  const accessibleScopeIds = session ? accessiblePermissionScopeIds(session) : null
  // 撤销角色：持有 permission:revoke 的角色（admin + hr）可见可执行
  const canDelete = session ? hasPermission(session, 'permission:revoke') : false

  // 默认选中节点：admin → 总部（现状）；非 admin → 其第一个可操作 scope 节点
  //（避免默认选中被置灰的总部）
  const hqNode = orgNodes.find(n => n.type === '总部')
  const fallbackId = hqNode?.id ?? orgNodes.find(n => !n.parentId)?.id ?? ''
  const defaultScopeId =
    accessibleScopeIds && accessibleScopeIds.length > 0
      ? accessibleScopeIds[0]
      : fallbackId
  const initialRoles = defaultScopeId ? await getRolesByScope(defaultScopeId) : []

  return (
    <Suspense>
      <PermissionsPage
        initialRoles={initialRoles}
        initialScopeId={defaultScopeId}
        roleCounts={roleCounts}
        allEmployees={allEmployees}
        orgNodes={orgNodes}
        accessibleScopeIds={accessibleScopeIds}
        canDelete={canDelete}
      />
    </Suspense>
  )
}
