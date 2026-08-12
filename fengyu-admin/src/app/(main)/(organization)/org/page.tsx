import { getOrgNodes } from '@/actions/org'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import OrgPage from './_components/org-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireUiPageCapability(session, 'org:list')
  const orgNodes = await getOrgNodes()
  const canDelete = !!session && hasUiCapability(session.permissions.actions, 'org:delete') && isAdminScope(session)
  return (
    <OrgPage
      orgNodes={orgNodes}
      canCreate={hasUiCapability(session.permissions.actions, 'org:create')}
      canUpdate={hasUiCapability(session.permissions.actions, 'org:update')}
      canDelete={canDelete}
    />
  )
}
