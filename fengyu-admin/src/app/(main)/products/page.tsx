import { getProducts, getCategories } from '@/actions/products'
import ProductsPageClient from './_components/products-page'

export const dynamic = 'force-dynamic'

export default async function ProductsPage() {
  const [products, categories] = await Promise.all([
    getProducts(),
    getCategories(),
  ])

  return <ProductsPageClient products={products} categories={categories} />
}
