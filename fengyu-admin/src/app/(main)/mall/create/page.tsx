import { getCategories, getMarkets, resolveManageScope } from '@/actions/products'
import ProductCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function MallProductCreatePage() {
  const [categories, markets, manageScope] = await Promise.all([
    getCategories(),
    getMarkets(),
    resolveManageScope(),
  ])

  return (
    <ProductCreatePageClient
      categories={categories}
      markets={markets}
      manageScope={manageScope}
    />
  )
}
