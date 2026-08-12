import { Suspense } from 'react'
import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import StoresPage from './_components/stores-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, session] = await Promise.all([getStores(), getSession()])
  const actions = session?.permissions.actions ?? []
  return (
    <Suspense>
      <StoresPage
        stores={stores}
        canCreate={hasUiCapability(actions, 'store:create')}
        canUpdate={hasUiCapability(actions, 'store:update')}
      />
    </Suspense>
  )
}
