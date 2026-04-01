import { getCategories, getMarkets } from '@/actions/products'
import SkuCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function SkuCreatePage() {
  const [categories, markets] = await Promise.all([
    getCategories(),
    getMarkets(),
  ])

  return (
    <SkuCreatePageClient
      categories={categories}
      markets={markets}
    />
  )
}
