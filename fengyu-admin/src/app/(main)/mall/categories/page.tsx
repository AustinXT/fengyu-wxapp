import { getMallCategories, getMallCategoryGroups } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import MallCategoriesPageClient from './_components/mall-categories-page'

export const dynamic = 'force-dynamic'

export default async function MallCategoriesPage() {
  const [allCategories, groups, session] = await Promise.all([
    getMallCategories(),
    getMallCategoryGroups(),
    getSession(),
  ])

  // 二级分类 = category_group 非 null 的行
  const subCategories = allCategories.filter(c => c.categoryGroup !== null)
  const canDelete = !!session && isAdminScope(session)

  return <MallCategoriesPageClient categories={subCategories} groups={groups} canDelete={canDelete} />
}
