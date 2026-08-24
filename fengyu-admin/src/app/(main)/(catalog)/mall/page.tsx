import { Suspense } from 'react'
import { getMallCategories, getProducts } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { hasUiCapability } from '@/lib/permission-contract'
import MallPageClient from './_components/mall-page'

export const dynamic = 'force-dynamic'

export default async function MallPage() {
  const session = await getSession()
  const [categories, products] = await Promise.all([
    getMallCategories(),
    getProducts(),
  ])

  return (
    <Suspense>
      <MallPageClient
        categories={categories}
        products={products}
        canCreate={hasUiCapability(session?.permissions.actions ?? [], 'product:create')}
        canUpdate={hasUiCapability(session?.permissions.actions ?? [], 'product:update')}
      />
    </Suspense>
  )
}
