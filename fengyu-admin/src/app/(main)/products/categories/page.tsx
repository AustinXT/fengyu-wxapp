import { getCategories, getProductKinds } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import CategoriesPageClient from './_components/categories-page'

export const dynamic = 'force-dynamic'

export default async function CategoriesPage() {
  const [allCategories, productKinds, session] = await Promise.all([
    getCategories(),
    getProductKinds(),
    getSession(),
  ])

  
  const subCategories = allCategories.filter(c => c.productKind !== null)
  const canDelete = !!session && isAdminScope(session)

  return <CategoriesPageClient categories={subCategories} productKinds={productKinds} canDelete={canDelete} />
}
