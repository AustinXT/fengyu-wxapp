import { getStores } from '@/actions/stores'
import { getUnbindRequests } from '@/actions/store-unbind'
import StoresPage from './_components/stores-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, unbindRequests] = await Promise.all([
    getStores(),
    getUnbindRequests().catch(() => []),
  ])
  return <StoresPage stores={stores} unbindRequests={unbindRequests} />
}
