import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import ServiceCreatePageClient from '../_components/service-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, employees] = await Promise.all([
    getStores(),
    getEmployees(),
  ])

  return (
    <ServiceCreatePageClient
      stores={stores}
      employees={employees}
    />
  )
}
