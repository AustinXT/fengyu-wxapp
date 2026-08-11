import { getMallCategories, getMallCategoryGroups } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import MallCategoriesPageClient from './_components/mall-categories-page'

export const dynamic = 'force-dynamic'

export default async function MallCategoriesPage() {
  const session = await getSession()
  requireUiPageCapability(session, 'product:list')
  const [allCategories, groups] = await Promise.all([
    getMallCategories(),
    getMallCategoryGroups(),
  ])

  // 二级分类 = category_group 非 null 的行
  const subCategories = allCategories.filter(c => c.categoryGroup !== null)
  // 分类删除沿用 product:update 后端权限，且仅系统管理员可执行。
  const canDelete = !!session && hasUiCapability(session.permissions.actions, 'product:update') && isAdminScope(session)

  return (
    <MallCategoriesPageClient
      categories={subCategories}
      groups={groups}
      canCreate={hasUiCapability(session.permissions.actions, 'product:create')}
      canUpdate={hasUiCapability(session.permissions.actions, 'product:update')}
      canDelete={canDelete}
    />
  )
}
