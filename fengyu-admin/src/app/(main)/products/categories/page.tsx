import { getCategories, getProductKinds } from '@/actions/products'
import CategoriesPageClient from './_components/categories-page'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const [allCategories, productKinds] = await Promise.all([
    getCategories(),
    getProductKinds(),
  ])

  
  const subCategories = allCategories.filter(c => c.productKind !== null)

  return <CategoriesPageClient categories={subCategories} productKinds={productKinds} />
}
