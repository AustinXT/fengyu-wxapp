import { Suspense } from 'react'
import { getMallCategories, getProducts } from '@/actions/products'
import MallPageClient from './_components/mall-page'

export const dynamic = 'force-dynamic'

export default async function MallPage() {
  const [categories, products] = await Promise.all([
    getMallCategories(),
    getProducts(),
  ])

  return (
    <Suspense>
      <MallPageClient categories={categories} products={products} />
    </Suspense>
  )
}
