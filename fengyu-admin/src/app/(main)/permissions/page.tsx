import { getRoles } from '@/actions/permissions'
import { getEmployees } from '@/actions/employees'
import { getOrgNodes } from '@/actions/org'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [roles, employees, orgNodes] = await Promise.all([getRoles(), getEmployees(), getOrgNodes()])
  return <PermissionsPage roles={roles} employees={employees} orgNodes={orgNodes} />
}
