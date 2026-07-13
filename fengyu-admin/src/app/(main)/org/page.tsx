import { getOrgNodes } from '@/actions/org'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import OrgPage from './_components/org-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [orgNodes, session] = await Promise.all([getOrgNodes(), getSession()])
  const canDelete = !!session && isAdminScope(session)
  return <OrgPage orgNodes={orgNodes} canDelete={canDelete} />
}
