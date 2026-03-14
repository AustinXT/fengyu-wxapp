import { getUnbindRequests } from '@/actions/store-unbind'
import StoreUnbindPage from './_components/store-unbind-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const requests = await getUnbindRequests()
  return <StoreUnbindPage requests={requests} />
}
