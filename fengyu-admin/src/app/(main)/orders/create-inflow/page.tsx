import { getStores } from '@/actions/stores'
import InflowOrderCreatePageClient from '../_components/inflow-order-create-page'

export const dynamic = 'force-dynamic'


export default async function Page() {
  const stores = await getStores()
  return <InflowOrderCreatePageClient stores={stores} />
}
