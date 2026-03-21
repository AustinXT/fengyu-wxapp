import { notFound } from 'next/navigation'
import { getProductById, getSkusByProductId, getCategories, getMarkets, resolveManageScope } from '@/actions/products'
import ProductDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [product, skus, categories, markets, manageScope] = await Promise.all([
    getProductById(id),
    getSkusByProductId(id),
    getCategories(),
    getMarkets(),
    resolveManageScope(),
  ])

  if (!product) {
    notFound()
  }

  return (
    <ProductDetailPageClient
      product={product}
      skus={skus}
      categories={categories}
      markets={markets}
      manageScope={manageScope}
    />
  )
}
