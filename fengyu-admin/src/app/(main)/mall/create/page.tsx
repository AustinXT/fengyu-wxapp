import { getMallCategories, getMarkets, resolveManageScope } from '@/actions/products'
import ProductCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function MallProductCreatePage() {
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
