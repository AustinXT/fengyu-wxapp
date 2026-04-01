import { getMallCategories, getMallCategoryGroups } from '@/actions/products'
import MallCategoriesPageClient from './_components/mall-categories-page'

export const dynamic = 'force-dynamic'

export default async function MallCategoriesPage() {
  const [allCategories, groups] = await Promise.all([
    getMallCategories(),
    getMallCategoryGroups(),
  ])

  // 二级分类 = category_group 非 null 的行
  const subCategories = allCategories.filter(c => c.categoryGroup !== null)

  return <MallCategoriesPageClient categories={subCategories} groups={groups} />
}
