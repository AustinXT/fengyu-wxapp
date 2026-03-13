import SyncPageClient from './_components/sync-page'
import { getSyncHistory } from '@/actions/sync'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const history = await getSyncHistory()
  return <SyncPageClient history={history} />
}
