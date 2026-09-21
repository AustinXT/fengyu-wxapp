import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import ServiceCreatePageClient from '../_components/service-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  requireUiPageCapability(await getSession(), 'service:create')
  // 服务人员候选由客户端按所选门店调 getServiceStaffCandidates 拉取（含市场内出差支援人员），
  // 不再预取全量员工档案：门店级账号的 employee scope 看不到别店员工，且档案含 PII。
  const stores = await getStores()

  return (
    <ServiceCreatePageClient stores={stores} />
  )
}
