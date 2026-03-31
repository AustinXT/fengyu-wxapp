import { getStores } from '@/actions/stores'
import { getOrgNodes } from '@/actions/org'
import { getActivePositions } from '@/actions/positions'
import { getActiveSkillTags } from '@/actions/skill-tags'
import EmployeeCreatePage from './_components/employee-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, orgNodes, positions, skillTags] = await Promise.all([
    getStores(),
    getOrgNodes(),
    getActivePositions(),
    getActiveSkillTags(),
  ])
  return <EmployeeCreatePage stores={stores} orgNodes={orgNodes} positions={positions} skillTags={skillTags} />
}
