import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import PickupRecordCreatePageClient from '../_components/pickup-record-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  requireUiPageCapability(await getSession(), 'pickup_record:create')
  const stores = await getStores()
  return <PickupRecordCreatePageClient stores={stores} />
}
