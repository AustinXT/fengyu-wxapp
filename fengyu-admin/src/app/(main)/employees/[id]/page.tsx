import { notFound } from 'next/navigation'
import { getEmployeeById } from '@/actions/employees'
import { getEmployeeRoles } from '@/actions/permissions'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getActiveSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import EmployeeDetailPage from './_components/employee-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const [employee, roles, stores, orgNodes, skillTags] = await Promise.all([
    getEmployeeById(id),
    getEmployeeRoles(id),
    getStores(),
    getOrgNodes(),
    getActiveSkillTags(),
  ])
  if (!employee) notFound()
  
  const canDelete = !!(session && hasPermission(session, 'employee:delete'))
  return <EmployeeDetailPage employee={employee} roles={roles} stores={stores} orgNodes={orgNodes} skillTags={skillTags} canDelete={canDelete} />
}
