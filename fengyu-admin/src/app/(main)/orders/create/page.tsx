import { getCategories, getProducts, getAllSkus, getProductKinds } from '@/actions/products'
import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [categories, products, skus, stores, employees, productKinds] = await Promise.all([
    getCategories(),
    getProducts(),
    getAllSkus(),
    getStores(),
    getEmployees(),
    getProductKinds(),
  ])

  // 二级分类
  const subCategories = categories.filter(c => c.productKind !== null)

  return (
    <OrderCreatePageClient
      categories={subCategories}
      products={products}
      skus={skus}
      stores={stores}
      employees={employees}
      productKinds={productKinds}
    />
  )
}
