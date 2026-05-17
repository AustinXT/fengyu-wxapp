import { getCategories, getMarkets, getProjectSeries } from '@/actions/products'
import SkuCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function SkuCreatePage() {
  const [categories, markets, projectSeriesOptions] = await Promise.all([
    getCategories(),
    getMarkets(),
    getProjectSeries(),
  ])

  return (
    <SkuCreatePageClient
      categories={categories}
      markets={markets}
      projectSeriesOptions={projectSeriesOptions}
    />
  )
}
