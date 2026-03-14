'use server'

import { db } from '@/db'
import { productCategories, products, productSkus } from '@db/product'
import { eq, sql } from 'drizzle-orm'
import type { ProductCategory, Product, ProductSku } from '@/lib/types'

export async function getCategories(): Promise<ProductCategory[]> {
  const rows = await db
    .select()
    .from(productCategories)
    .orderBy(productCategories.sortOrder)

  return rows.map((c) => ({
    categoryId: c.categoryId,
    categoryName: c.categoryName,
    productKind: c.productKind as ProductCategory['productKind'],
    sortOrder: c.sortOrder,
    isValid: c.isValid,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }))
}

export async function getProducts(): Promise<Product[]> {
  const skuCountSq = db
    .select({
      productId: productSkus.productId,
      count: sql<number>`count(*)::int`.as('sku_count'),
    })
    .from(productSkus)
    .groupBy(productSkus.productId)
    .as('sku_count_sq')

  const rows = await db
    .select({
      product: products,
      categoryName: productCategories.categoryName,
      productKind: productCategories.productKind,
      skuCount: skuCountSq.count,
    })
    .from(products)
    .leftJoin(productCategories, eq(products.categoryId, productCategories.categoryId))
    .leftJoin(skuCountSq, eq(products.productId, skuCountSq.productId))

  return rows.map((r) => ({
    productId: r.product.productId,
    categoryId: r.product.categoryId,
    name: r.product.name,
    coverImage: r.product.coverImage,
    detailImages: r.product.detailImages,
    description: r.product.description,
    isShengmei: r.product.isShengmei,
    isBundle: r.product.isBundle,
    price: r.product.price,
    specialPrice: r.product.specialPrice,
    salesCategory: r.product.salesCategory as Product['salesCategory'],
    manageScope: r.product.manageScope,
    marketScope: r.product.marketScope,
    sortOrder: r.product.sortOrder,
    validStart: r.product.validStart,
    validEnd: r.product.validEnd,
    createdAt: r.product.createdAt.toISOString(),
    updatedAt: r.product.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
    productKind: (r.productKind as Product['productKind']) ?? undefined,
    skuCount: r.skuCount ?? 0,
  }))
}

export async function getProductById(productId: string): Promise<Product | null> {
  const rows = await db
    .select({
      product: products,
      categoryName: productCategories.categoryName,
      productKind: productCategories.productKind,
    })
    .from(products)
    .leftJoin(productCategories, eq(products.categoryId, productCategories.categoryId))
    .where(eq(products.productId, productId))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]
  return {
    productId: r.product.productId,
    categoryId: r.product.categoryId,
    name: r.product.name,
    coverImage: r.product.coverImage,
    detailImages: r.product.detailImages,
    description: r.product.description,
    isShengmei: r.product.isShengmei,
    isBundle: r.product.isBundle,
    price: r.product.price,
    specialPrice: r.product.specialPrice,
    salesCategory: r.product.salesCategory as Product['salesCategory'],
    manageScope: r.product.manageScope,
    marketScope: r.product.marketScope,
    sortOrder: r.product.sortOrder,
    validStart: r.product.validStart,
    validEnd: r.product.validEnd,
    createdAt: r.product.createdAt.toISOString(),
    updatedAt: r.product.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
    productKind: (r.productKind as Product['productKind']) ?? undefined,
  }
}

export async function getSkusByProductId(productId: string): Promise<ProductSku[]> {
  const rows = await db
    .select()
    .from(productSkus)
    .where(eq(productSkus.productId, productId))
    .orderBy(productSkus.sortOrder)

  return rows.map((s) => ({
    skuId: s.skuId,
    productId: s.productId,
    productType: s.productType as ProductSku['productType'],
    specName: s.specName,
    price: s.price,
    specialPrice: s.specialPrice,
    sessionCount: s.sessionCount,
    isBundleSku: s.isBundleSku,
    sortOrder: s.sortOrder,
    serviceFee: s.serviceFee,
    validStart: s.validStart,
    validEnd: s.validEnd,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }))
}

export async function getAllSkus(): Promise<ProductSku[]> {
  const rows = await db
    .select()
    .from(productSkus)
    .orderBy(productSkus.sortOrder)
    .limit(1000)

  return rows.map((s) => ({
    skuId: s.skuId,
    productId: s.productId,
    productType: s.productType as ProductSku['productType'],
    specName: s.specName,
    price: s.price,
    specialPrice: s.specialPrice,
    sessionCount: s.sessionCount,
    isBundleSku: s.isBundleSku,
    sortOrder: s.sortOrder,
    serviceFee: s.serviceFee,
    validStart: s.validStart,
    validEnd: s.validEnd,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }))
}

export async function createProduct(data: {
  productId: string
  categoryId: string
  name: string
  coverImage?: string | null
  detailImages?: string[] | null
  description?: string | null
  isShengmei?: boolean | null
  isBundle?: boolean
  price: string
  specialPrice?: string | null
  salesCategory?: string | null
  manageScope?: string | null
  marketScope?: string | null
  sortOrder?: number
  validStart?: string | null
  validEnd?: string | null
}) {
  await db.insert(products).values({
    ...data,
    salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
  })
}

export async function updateProduct(
  productId: string,
  data: Partial<{
    categoryId: string
    name: string
    coverImage: string | null
    detailImages: string[] | null
    description: string | null
    isShengmei: boolean | null
    isBundle: boolean
    price: string
    specialPrice: string | null
    salesCategory: string | null
    manageScope: string | null
    marketScope: string | null
    sortOrder: number
    validStart: string | null
    validEnd: string | null
  }>
) {
  await db
    .update(products)
    .set({
      ...data,
      salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
    })
    .where(eq(products.productId, productId))
}

export async function createCategory(data: {
  categoryId: string
  categoryName: string
  productKind: string
  sortOrder?: number
  isValid?: boolean
}) {
  await db.insert(productCategories).values({
    ...data,
    productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
  })
}

export async function updateCategory(
  categoryId: string,
  data: Partial<{
    categoryName: string
    productKind: string
    sortOrder: number
    isValid: boolean
  }>
) {
  await db
    .update(productCategories)
    .set({
      ...data,
      productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
    })
    .where(eq(productCategories.categoryId, categoryId))
}

export async function createSku(data: {
  skuId: string
  productId: string
  productType: string
  specName: string
  price: string
  specialPrice?: string | null
  sessionCount?: number | null
  isBundleSku?: boolean
  sortOrder?: number
  serviceFee?: string
  validStart?: string | null
  validEnd?: string | null
}) {
  await db.insert(productSkus).values({
    ...data,
    productType: data.productType as typeof productSkus.$inferInsert['productType'],
  })
}

export async function updateSku(
  skuId: string,
  data: Partial<{
    productType: string
    specName: string
    price: string
    specialPrice: string | null
    sessionCount: number | null
    isBundleSku: boolean
    sortOrder: number
    serviceFee: string
    validStart: string | null
    validEnd: string | null
  }>
) {
  await db
    .update(productSkus)
    .set({
      ...data,
      productType: data.productType as typeof productSkus.$inferInsert['productType'],
    })
    .where(eq(productSkus.skuId, skuId))
}

export async function deleteSku(skuId: string) {
  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))
}
