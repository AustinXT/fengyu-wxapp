import { notFound } from 'next/navigation'
import { getSkuById, getCategories, getMarkets, getProjectSeries } from '@/actions/products'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import SkuDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function SkuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  requireUiPageCapability(await getSession(), 'product:update')

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
