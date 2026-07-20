import { notFound } from 'next/navigation'
import { getEmployeeById } from '@/actions/employees'
import { getEmployeeRoles } from '@/actions/permissions'
import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
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
    getSkillTags(),
  ])
  if (!employee) notFound()
  // 物理删除员工：仅系统管理员（employee:delete）
  const canDelete = !!(session && isAdminScope(session))
  return <EmployeeDetailPage employee={employee} roles={roles} stores={stores} orgNodes={orgNodes} skillTags={skillTags} canDelete={canDelete} />
}
