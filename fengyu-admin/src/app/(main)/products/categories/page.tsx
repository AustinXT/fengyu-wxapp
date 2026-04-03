import { getCategories, getProductKinds } from '@/actions/products'
import CategoriesPageClient from './_components/categories-page'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const [allCategories, productKinds] = await Promise.all([
    getCategories(),
    getProductKinds(),
  ])

  // 二级分类 = product_kind 非 null 的行
  const subCategories = allCategories.filter(c => c.productKind !== null)

  return <CategoriesPageClient categories={subCategories} productKinds={productKinds} />
}
