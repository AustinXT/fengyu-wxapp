import { notFound } from 'next/navigation'
import { getEmployeeById } from '@/actions/employees'
import { getRoles } from '@/actions/permissions'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import EmployeeDetailPage from './_components/employee-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [employee, allRoles, stores, orgNodes] = await Promise.all([
    getEmployeeById(id),
    getRoles(),
    getStores(),
    getOrgNodes(),
  ])
  if (!employee) notFound()
  const roles = allRoles.filter((r) => r.employeeId === id)
  return <EmployeeDetailPage employee={employee} roles={roles} stores={stores} orgNodes={orgNodes} />
}
