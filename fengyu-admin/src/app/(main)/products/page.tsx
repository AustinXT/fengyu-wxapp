import { Suspense } from 'react'
import { getAllSkus, getCategories, getProductKinds } from '@/actions/products'
import ProductsPageClient from './_components/products-page'

export const dynamic = 'force-dynamic'

export default async function ProductsPage() {
  const [skus, categories, productKinds] = await Promise.all([
    getAllSkus(),
    getCategories(),
    getProductKinds(),
  ])

  
  const subCategories = categories.filter(c => c.productKind !== null)

  return (
    <Suspense>
      <ProductsPageClient skus={skus} categories={subCategories} productKinds={productKinds} />
    </Suspense>
  )
}
