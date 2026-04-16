import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 开单页 Server Component
 *
 * PR-C：商品/分类数据全部由 client 在 Step 1 选定 productKindChoice 后通过
 * getProductsByKind() 按需懒拉，server 端不再预加载 categories/products/skus。
 */
export default async function Page() {
  const [stores, employees] = await Promise.all([
    getStores(),
    getEmployees(),
  ])

  return (
    <OrderCreatePageClient
      stores={stores}
      employees={employees}
    />
  )
}
