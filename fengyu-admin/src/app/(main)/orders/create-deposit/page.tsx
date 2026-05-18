import { getStores } from '@/actions/stores'
import DepositOrderCreatePageClient from '../_components/deposit-order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 寄存单创建页 Server Component（B5）
 *
 * 与 /orders/create 解耦：寄存单流程简化，不需要 employees 预加载，
 * 顾客 / 商品数据均由 client 端按需 action 调用。
 */
export default async function Page() {
  const stores = await getStores()
  return <DepositOrderCreatePageClient stores={stores} />
}
