import { getCategories } from '@/actions/products'
import CategoriesPageClient from './_components/categories-page'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const categories = await getCategories()

  return <CategoriesPageClient categories={categories} />
}
