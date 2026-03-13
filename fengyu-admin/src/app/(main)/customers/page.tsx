import { getCustomers } from '@/actions/customers'
import { getStores } from '@/actions/stores'
import CustomersPageClient from './_components/customers-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [customers, stores] = await Promise.all([getCustomers(), getStores()])
  return <CustomersPageClient customers={customers} stores={stores} />
}
