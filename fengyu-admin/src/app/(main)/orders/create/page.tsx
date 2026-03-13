import { getCategories, getProducts, getAllSkus } from '@/actions/products'
import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [categories, products, skus, stores, employees] = await Promise.all([
    getCategories(),
    getProducts(),
    getAllSkus(),
    getStores(),
    getEmployees(),
  ])

  return (
    <OrderCreatePageClient
      categories={categories}
      products={products}
      skus={skus}
      stores={stores}
      employees={employees}
    />
  )
}
