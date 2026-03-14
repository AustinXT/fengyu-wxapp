'use server'

import { db } from '@/db'
import { productCategories, products, productSkus } from '@db/product'
import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { ProductCategory, Product, ProductSku } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export async function getCategories(): Promise<ProductCategory[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

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
  const session = await getSession()
  requirePermission(session, 'product:list')

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
  const session = await getSession()
  requirePermission(session, 'product:list')

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
  const session = await getSession()
  requirePermission(session, 'product:list')

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
  const session = await getSession()
  requirePermission(session, 'product:list')

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
  const session = await getSession()
  requirePermission(session, 'product:create')

  await db.insert(products).values({
    ...data,
    salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
  })

  await logOperation(session, 'product.create', 'product', data.productId, { name: data.name })
  revalidatePath('/products')
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
  const session = await getSession()
  requirePermission(session, 'product:update')

  await db
    .update(products)
    .set({
      ...data,
      salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
    })
    .where(eq(products.productId, productId))

  await logOperation(session, 'product.update', 'product', productId, data)
  revalidatePath('/products')
}

export async function createCategory(data: {
  categoryId: string
  categoryName: string
  productKind: string
  sortOrder?: number
  isValid?: boolean
}) {
  const session = await getSession()
  requirePermission(session, 'product:create')

  await db.insert(productCategories).values({
    ...data,
    productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
  })

  await logOperation(session, 'category.create', 'product_category', data.categoryId, { categoryName: data.categoryName })
  revalidatePath('/products')
  revalidatePath('/products/categories')
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
  const session = await getSession()
  requirePermission(session, 'product:update')

  await db
    .update(productCategories)
    .set({
      ...data,
      productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
    })
    .where(eq(productCategories.categoryId, categoryId))

  await logOperation(session, 'category.update', 'product_category', categoryId, data)
  revalidatePath('/products')
  revalidatePath('/products/categories')
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
  const session = await getSession()
  requirePermission(session, 'product:create')

  await db.insert(productSkus).values({
    ...data,
    productType: data.productType as typeof productSkus.$inferInsert['productType'],
  })

  await logOperation(session, 'sku.create', 'product_sku', data.skuId, { specName: data.specName })
  revalidatePath('/products')
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
  const session = await getSession()
  requirePermission(session, 'product:update')

  await db
    .update(productSkus)
    .set({
      ...data,
      productType: data.productType as typeof productSkus.$inferInsert['productType'],
    })
    .where(eq(productSkus.skuId, skuId))

  await logOperation(session, 'sku.update', 'product_sku', skuId, data)
  revalidatePath('/products')
}

export async function deleteSku(skuId: string) {
  const session = await getSession()
  requirePermission(session, 'product:update')

  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))

  await logOperation(session, 'sku.delete', 'product_sku', skuId)
  revalidatePath('/products')
}
