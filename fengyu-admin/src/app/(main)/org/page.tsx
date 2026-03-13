import { getOrgNodes } from '@/actions/org'
import OrgPage from './_components/org-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const orgNodes = await getOrgNodes()
  return <OrgPage orgNodes={orgNodes} />
}
