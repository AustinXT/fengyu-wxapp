import { getCategories } from '@/actions/products'
import ProductCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function ProductCreatePage() {
  const categories = await getCategories()

  return <ProductCreatePageClient categories={categories} />
}
