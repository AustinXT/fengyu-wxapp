import { notFound } from 'next/navigation'
import { getProductById, getSkusByProductId, getCategories, getMarkets, resolveManageScope, getAllSkus } from '@/actions/products'
import ProductDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function MallProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [product, skus, categories, markets, manageScope, allSkus] = await Promise.all([
    getProductById(id),
    getSkusByProductId(id),
    getCategories(),
    getMarkets(),
    resolveManageScope(),
    getAllSkus(),
  ])

  if (!product) {
    notFound()
  }

  return (
    <ProductDetailPageClient
      product={product}
      skus={skus}
      allSkus={allSkus}
      categories={categories}
      markets={markets}
      manageScope={manageScope}
    />
  )
}
