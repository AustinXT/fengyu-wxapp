import { getUnbindRequests } from '@/actions/store-unbind'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import StoreUnbindPage from './_components/store-unbind-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [requests, session] = await Promise.all([getUnbindRequests(), getSession()])
  const actions = session?.permissions.actions ?? []
  const canDelete = !!(session && hasUiCapability(actions, 'store_unbind:delete') && isAdminScope(session))
  return (
    <StoreUnbindPage
      requests={requests}
      canApprove={hasUiCapability(actions, 'store_unbind:approve')}
      canReject={hasUiCapability(actions, 'store_unbind:reject')}
      canDelete={canDelete}
    />
  )
}
