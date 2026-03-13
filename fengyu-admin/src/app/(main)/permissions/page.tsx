import { getRoles } from '@/actions/permissions'
import { getEmployees } from '@/actions/employees'
import PermissionsPage from './_components/permissions-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [roles, employees] = await Promise.all([getRoles(), getEmployees()])
  return <PermissionsPage roles={roles} employees={employees} />
}
