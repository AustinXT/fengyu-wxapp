import { getStores } from '@/actions/stores'
import DepositOrderCreatePageClient from '../_components/deposit-order-create-page'

export const dynamic = 'force-dynamic'


export default async function Page() {
  const stores = await getStores()
  return <DepositOrderCreatePageClient stores={stores} />
}
