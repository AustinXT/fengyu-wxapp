import { Suspense } from 'react'
import { getRolesByScope, getRoleCountsByScope } from '@/actions/permissions'
import { getEmployees } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [orgNodes, allEmployees, roleCounts] = await Promise.all([
    getOrgNodes(),
    getEmployees(),
    getRoleCountsByScope(),
  ])

  // 默认选中 headquarters 节点，预加载其角色
  const hqNode = orgNodes.find(n => n.type === 'headquarters')
  const defaultScopeId = hqNode?.id ?? orgNodes.find(n => !n.parentId)?.id ?? ''
  const initialRoles = defaultScopeId ? await getRolesByScope(defaultScopeId) : []

  return (
    <Suspense>
      <PermissionsPage
        initialRoles={initialRoles}
        initialScopeId={defaultScopeId}
        roleCounts={roleCounts}
        allEmployees={allEmployees}
        orgNodes={orgNodes}
      />
    </Suspense>
  )
}
