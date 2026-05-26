import { notFound } from 'next/navigation'
import { getSkuById, getCategories, getMarkets, getProjectSeries } from '@/actions/products'
import SkuDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function SkuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [sku, categories, markets, projectSeriesOptions] = await Promise.all([
    getSkuById(id),
    getCategories(),
    getMarkets(),
    getProjectSeries(),
  ])

  if (!sku) {
    notFound()
  }

  return (
    <SkuDetailPageClient
      sku={sku}
      categories={categories}
      markets={markets}
      projectSeriesOptions={projectSeriesOptions}
    />
  )
}
