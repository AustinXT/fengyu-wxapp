import { Suspense } from 'react'
import { getAllSkus, getCategories, getProductKinds } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import ProductsPageClient from './_components/products-page'

export const dynamic = 'force-dynamic'

export default async function ProductsPage() {
  const session = await getSession()
  const [skus, categories, productKinds] = await Promise.all([
    getAllSkus(),
    getCategories(),
    getProductKinds(),
  ])

  // 二级分类
  const subCategories = categories.filter(c => c.productKind !== null)

  return (
    <Suspense>
      <ProductsPageClient
        skus={skus}
        categories={subCategories}
        productKinds={productKinds}
        canCreate={hasUiCapability(session?.permissions.actions ?? [], 'product:create')}
        canUpdate={hasUiCapability(session?.permissions.actions ?? [], 'product:update')}
      />
    </Suspense>
  )
}
