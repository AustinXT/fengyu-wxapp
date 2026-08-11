import { notFound } from 'next/navigation'
import { getEmployeeById } from '@/actions/employees'
import { getEmployeeRoles } from '@/actions/permissions'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasPermission, isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import EmployeeDetailPage from './_components/employee-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'employee:list')
  const actions = session?.permissions.actions ?? []
  const canUpdate = hasUiCapability(actions, 'employee:update')
  const canAssignRole = hasUiCapability(actions, 'permission:assign')
  const canRevokeRole = hasUiCapability(actions, 'permission:revoke')
  const canAssignAdmin = hasUiCapability(actions, 'permission:assign_admin')
  const canResetPassword = hasUiCapability(actions, 'admin:reset_password')
  const canListStores = !!session && hasPermission(session, 'store:list')
  const canListOrg = !!session && hasPermission(session, 'org:list')
  const [employee, roles, stores, orgNodes, skillTags] = await Promise.all([
    getEmployeeById(id),
    getEmployeeRoles(id),
    canListStores ? getStores() : Promise.resolve([]),
    canListOrg ? getOrgNodes() : Promise.resolve([]),
    getSkillTags(),
  ])
  if (!employee) notFound()
  // 物理删除员工：仅系统管理员（employee:delete）
  const canDelete = !!(session && hasUiCapability(actions, 'employee:delete') && isAdminScope(session))
  return (
    <EmployeeDetailPage
      employee={employee}
      roles={roles}
      stores={stores}
      orgNodes={orgNodes}
      skillTags={skillTags}
      canUpdate={canUpdate}
      canAssignRole={canAssignRole}
      canRevokeRole={canRevokeRole}
      canAssignAdmin={canAssignAdmin}
      canResetPassword={canResetPassword}
      canDelete={canDelete}
    />
  )
}
