import { notFound } from 'next/navigation'
import { getSkuById, getCategories, getMarkets } from '@/actions/products'
import SkuDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function SkuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [sku, categories, markets] = await Promise.all([
    getSkuById(id),
    getCategories(),
    getMarkets(),
  ])

  if (!sku) {
    notFound()
  }

  return (
    <SkuDetailPageClient
      sku={sku}
      categories={categories}
      markets={markets}
    />
  )
}
