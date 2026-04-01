import { getMallCategories } from '@/actions/products'
import MallCategoriesPageClient from './_components/mall-categories-page'

export const dynamic = 'force-dynamic'

export default async function MallCategoriesPage() {
  const categories = await getMallCategories()
  return <MallCategoriesPageClient categories={categories} />
}
