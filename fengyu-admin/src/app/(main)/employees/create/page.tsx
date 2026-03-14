import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import EmployeeCreatePage from './_components/employee-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, orgNodes] = await Promise.all([getStores(), getOrgNodes()])
  return <EmployeeCreatePage stores={stores} orgNodes={orgNodes} />
}
