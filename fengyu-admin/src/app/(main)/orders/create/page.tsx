import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 开单页 Server Component
 *
 * 商品/分类数据全部由 client 在 Step 1 选定 productKindChoice 后通过
 * getProductsByKind() 按需懒拉，server 端不再预加载 categories/products/skus。
 *
 * 2026-05-20 充值卡剥离 SKU 化：开单页不再含"充值卡" Tab；充值订单走员工端
 * card.recharge 入口，admin 若需自建入口将另起独立页面。
 */
export default async function Page() {
  const [stores, employees] = await Promise.all([getStores(), getEmployees()])
  return <OrderCreatePageClient stores={stores} employees={employees} />
}
