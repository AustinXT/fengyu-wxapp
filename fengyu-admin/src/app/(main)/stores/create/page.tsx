import { getOrgNodes } from '@/actions/org'
import StoreCreatePage from './_components/store-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const orgNodes = await getOrgNodes()
  const markets = orgNodes.filter((n) => n.type === 'market' && n.isActive)
  return <StoreCreatePage markets={markets} />
}
