import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getSkillTags } from '@/actions/skill-tags'
import EmployeeCreatePage from './_components/employee-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, orgNodes, skillTags] = await Promise.all([
    getStores(),
    getOrgNodes(),
    getSkillTags(),
  ])
  return <EmployeeCreatePage stores={stores} orgNodes={orgNodes} skillTags={skillTags} />
}
