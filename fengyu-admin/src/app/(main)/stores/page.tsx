import { getStores } from '@/actions/stores'
import StoresPage from './_components/stores-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const stores = await getStores()
  return <StoresPage stores={stores} />
}
