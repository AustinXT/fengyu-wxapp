import { getStores } from '@/actions/stores'
import PickupRecordCreatePageClient from '../_components/pickup-record-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const stores = await getStores()
  return <PickupRecordCreatePageClient stores={stores} />
}
