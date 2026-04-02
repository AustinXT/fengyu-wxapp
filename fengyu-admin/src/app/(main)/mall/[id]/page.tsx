import { notFound } from 'next/navigation'
import { getProductById, getSkusByProductId, getBundleGroupsByProductId, getCategories, getMallCategories, getMarkets, resolveManageScope, getAllSkus } from '@/actions/products'
import ProductDetailPageClient from './_components/product-detail-page'

export const dynamic = 'force-dynamic'

export default async function MallProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [product, skus, bundleGroups, mallCategories, skuCategories, markets, manageScope, allSkus] = await Promise.all([
    getProductById(id),
    getSkusByProductId(id),
    getBundleGroupsByProductId(id),
    getMallCategories(),
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
      bundleGroups={bundleGroups}
      allSkus={allSkus}
      mallCategories={mallCategories}
      skuCategories={skuCategories}
      markets={markets}
      manageScope={manageScope}
    />
  )
}
