import { getCategories, getMarkets, getProjectSeries } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import SkuCreatePageClient from './_components/product-create-page'

export const dynamic = 'force-dynamic'

export default async function SkuCreatePage() {
  requireUiPageCapability(await getSession(), 'product:create')
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
