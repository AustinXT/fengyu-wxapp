import { getStores } from '@/actions/stores'
import InflowOrderCreatePageClient from '../_components/inflow-order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 旧系统充值金转入页 Server Component
 *
 * 与 /orders/create 解耦：转入流程极简（无商品 / 无档位 / 无购物车），
 * 顾客数据由 client 端按需 searchCustomers 调用。
 */
export default async function Page() {
  const stores = await getStores()
  return <InflowOrderCreatePageClient stores={stores} />
}
