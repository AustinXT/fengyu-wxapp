import { getUnbindRequests } from '@/actions/store-unbind'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import StoreUnbindPage from './_components/store-unbind-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [requests, session] = await Promise.all([getUnbindRequests(), getSession()])
  const canDelete = session ? isAdminScope(session) : false
  return <StoreUnbindPage requests={requests} canDelete={canDelete} />
}
