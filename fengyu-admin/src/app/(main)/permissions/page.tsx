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

  
  const accessibleScopeIds = session ? accessiblePermissionScopeIds(session) : null
  
  const canDelete = session ? hasPermission(session, 'permission:revoke') : false

  
  
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
