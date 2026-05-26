import { getAvailableStoreNodes } from '@/actions/stores'
import StoreCreatePage from './_components/store-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  // 门店实体以组织树门店节点为权威：只列出尚未创建门店信息的「门店」节点
  const storeNodes = await getAvailableStoreNodes()
  return <StoreCreatePage storeNodes={storeNodes} />
}
