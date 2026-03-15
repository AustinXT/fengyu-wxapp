'use server'

import { db } from '@/db'
import { productCategories, products, productSkus } from '@db/product'
import { eq, and, sql } from 'drizzle-orm'
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
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  // 价格校验
  const price = Number(data.price)
  if (isNaN(price) || price < 0) {
    return { success: false, message: '价格必须为非负数' }
  }
  if (data.specialPrice) {
    const sp = Number(data.specialPrice)
    if (isNaN(sp) || sp < 0) {
      return { success: false, message: '特价必须为非负数' }
    }
  }

  // 校验分类存在
  const [cat] = await db
    .select({ categoryId: productCategories.categoryId })
    .from(productCategories)
    .where(eq(productCategories.categoryId, data.categoryId))
    .limit(1)
  if (!cat) {
    return { success: false, message: '商品分类不存在' }
  }

  // 有效期校验
  if (data.validStart && data.validEnd && data.validStart > data.validEnd) {
    return { success: false, message: '有效期开始日期不能晚于结束日期' }
  }

  await db.insert(products).values({
    ...data,
    salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
  })

  await logOperation(session, 'product.create', 'product', data.productId, { name: data.name })
  revalidatePath('/products')
  return { success: true, message: '商品创建成功' }
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
  }>,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(products.productId, productId), eq(products.updatedAt, new Date(expectedUpdatedAt)))
    : eq(products.productId, productId)

  const result = await db
    .update(products)
    .set({
      ...data,
      salesCategory: data.salesCategory as typeof products.$inferInsert['salesCategory'],
    })
    .where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'product.update', 'product', productId, data)
  revalidatePath('/products')
  return { success: true, message: '商品信息已更新' }
}

export async function createCategory(data: {
  categoryId: string
  categoryName: string
  productKind: string
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  await db.insert(productCategories).values({
    ...data,
    productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
  })

  await logOperation(session, 'category.create', 'product_category', data.categoryId, { categoryName: data.categoryName })
  revalidatePath('/products')
  revalidatePath('/products/categories')
  return { success: true, message: '分类创建成功' }
}

export async function updateCategory(
  categoryId: string,
  data: Partial<{
    categoryName: string
    productKind: string
    sortOrder: number
    isValid: boolean
  }>,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(productCategories.categoryId, categoryId), eq(productCategories.updatedAt, new Date(expectedUpdatedAt)))
    : eq(productCategories.categoryId, categoryId)

  const result = await db
    .update(productCategories)
    .set({
      ...data,
      productKind: data.productKind as typeof productCategories.$inferInsert['productKind'],
    })
    .where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'category.update', 'product_category', categoryId, data)
  revalidatePath('/products')
  revalidatePath('/products/categories')
  return { success: true, message: '分类已更新' }
}

const VALID_PRODUCT_TYPES = ['疗程卡', '单品', '院装产品'] as const

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
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  // 校验 productType
  if (!VALID_PRODUCT_TYPES.includes(data.productType as typeof VALID_PRODUCT_TYPES[number])) {
    return { success: false, message: `无效的产品类型: ${data.productType}` }
  }

  // 价格校验
  const price = Number(data.price)
  if (isNaN(price) || price < 0) {
    return { success: false, message: '价格必须为非负数' }
  }
  if (data.serviceFee) {
    const fee = Number(data.serviceFee)
    if (isNaN(fee) || fee < 0) {
      return { success: false, message: '服务费必须为非负数' }
    }
  }

  // 疗程卡必须有 sessionCount >= 1
  if (data.productType === '疗程卡') {
    if (!data.sessionCount || data.sessionCount < 1) {
      return { success: false, message: '疗程卡的次数必须 >= 1' }
    }
  }

  // 有效期校验
  if (data.validStart && data.validEnd && data.validStart > data.validEnd) {
    return { success: false, message: '有效期开始日期不能晚于结束日期' }
  }

  await db.insert(productSkus).values({
    ...data,
    productType: data.productType as typeof productSkus.$inferInsert['productType'],
  })

  await logOperation(session, 'sku.create', 'product_sku', data.skuId, { specName: data.specName })
  revalidatePath('/products')
  return { success: true, message: 'SKU 创建成功' }
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
  }>,
  /** 乐观锁：提交时携带的 updated_at */
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(productSkus.skuId, skuId), eq(productSkus.updatedAt, new Date(expectedUpdatedAt)))
    : eq(productSkus.skuId, skuId)

  const result = await db
    .update(productSkus)
    .set({
      ...data,
      productType: data.productType as typeof productSkus.$inferInsert['productType'],
    })
    .where(whereConditions)

  if (expectedUpdatedAt && (result as any).rowCount === 0) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  await logOperation(session, 'sku.update', 'product_sku', skuId, data)
  revalidatePath('/products')
  return { success: true, message: '规格已更新' }
}

export async function deleteSku(skuId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  // 检查是否有订单明细引用此 SKU（有 FK 引用则禁止物理删除）
  const { saleItems } = await import('@db/order')
  const [ref] = await db
    .select({ saleItemId: saleItems.saleItemId })
    .from(saleItems)
    .where(eq(saleItems.skuId, skuId))
    .limit(1)
  if (ref) {
    return { success: false, message: '该 SKU 已被订单引用，无法删除。可通过设置有效期下架' }
  }

  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))

  await logOperation(session, 'sku.delete', 'product_sku', skuId)
  revalidatePath('/products')
  return { success: true, message: 'SKU 已删除' }
}
