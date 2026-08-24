import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import EmployeeCreatePage from './_components/employee-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  requireUiPageCapability(await getSession(), 'employee:create')
  const [stores, orgNodes, skillTags] = await Promise.all([
    getStores(),
    getOrgNodes(),
    getSkillTags(),
  ])
  return <EmployeeCreatePage stores={stores} orgNodes={orgNodes} skillTags={skillTags} />
}
