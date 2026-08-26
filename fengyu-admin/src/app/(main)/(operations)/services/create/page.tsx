import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import ServiceCreatePageClient from '../_components/service-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  requireUiPageCapability(await getSession(), 'service:create')
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
