import { getMallCategories, getMarkets, resolveManageScope } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import ProductCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function MallProductCreatePage() {
  requireUiPageCapability(await getSession(), 'product:create')
  const [mallCategories, markets, manageScope] = await Promise.all([
    getMallCategories(),
    getMarkets(),
    resolveManageScope(),
  ])

  return (
    <ProductCreatePageClient
      mallCategories={mallCategories}
      markets={markets}
      manageScope={manageScope}
    />
  )
}
