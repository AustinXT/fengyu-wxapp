import { getServiceOrders } from '@/actions/services'
import { getStores } from '@/actions/stores'
import ServicesPageClient from './_components/services-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [serviceOrders, stores] = await Promise.all([getServiceOrders(), getStores()])
  return <ServicesPageClient serviceOrders={serviceOrders} stores={stores} />
}
