import { getCategories, getProductKinds } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import CategoriesPageClient from './_components/categories-page'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const session = await getSession()
  requireUiPageCapability(session, 'product:list')
  const [allCategories, productKinds] = await Promise.all([
    getCategories(),
    getProductKinds(),
  ])

  // 二级分类 = product_kind 非 null 的行
  const subCategories = allCategories.filter(c => c.productKind !== null)
  // 分类删除沿用 product:update 后端权限，且仅系统管理员可执行。
  const canDelete = !!session && hasUiCapability(session.permissions.actions, 'product:update') && isAdminScope(session)

  return (
    <CategoriesPageClient
      categories={subCategories}
      productKinds={productKinds}
      canCreate={hasUiCapability(session.permissions.actions, 'product:create')}
      canUpdate={hasUiCapability(session.permissions.actions, 'product:update')}
      canDelete={canDelete}
    />
  )
}
