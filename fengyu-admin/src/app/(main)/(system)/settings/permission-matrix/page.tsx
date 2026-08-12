import { getRoleDefinitions } from '@/actions/role-definitions'
import { ALL_ACTIONS, isAdminScope } from '@/lib/permissions'
import { getSession } from '@/lib/auth'
import PermissionMatrixPage from './_components/permission-matrix-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [roles, session] = await Promise.all([getRoleDefinitions(), getSession()])
  return (
    <PermissionMatrixPage
      initialRoles={roles}
      allActions={ALL_ACTIONS}
      canManageCapabilities={!!session && isAdminScope(session)}
    />
  )
}
