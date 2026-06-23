import { getAvailableStoreNodes } from '@/actions/stores'
import { getSessionFromCookie } from '@/actions/auth'
import { hasPermission } from '@/lib/permissions'
import StoreCreatePage from './_components/store-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  // 门店实体以组织树门店节点为权威：只列出尚未创建门店信息的「门店」节点
  const storeNodes = await getAvailableStoreNodes()
  // 拉卡拉收款配置：仅 admin（store:lakala_config）可填（选填，也可建店后到编辑页配）
  const session = await getSessionFromCookie()
  const canEditPayment = !!(session && hasPermission(session, 'store:lakala_config'))
  return <StoreCreatePage storeNodes={storeNodes} canEditPayment={canEditPayment} />
}
