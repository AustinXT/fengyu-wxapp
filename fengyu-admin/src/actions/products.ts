'use server'

import { db } from '@/db'
import { productCategories, products, productSkus, mallCategories, mallProductSkus } from '@db/product'
import { orgNodes } from '@db/org'
import { eq, and, asc, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import crypto from 'crypto'
import type { ProductCategory, Product, ProductSku, MallCategory } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

/**
 * 获取所有市场节点（type='market'），用于商品可见范围选择。
 */
export async function getMarkets(): Promise<{ id: string; name: string }[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select({ id: orgNodes.id, name: orgNodes.name })
    .from(orgNodes)
    .where(and(eq(orgNodes.type, 'market'), eq(orgNodes.isActive, true)))
    .orderBy(asc(orgNodes.sortOrder))

  return rows
}

/**
 * 根据当前用户 session 自动判断管理范围。
 */
export async function resolveManageScope(): Promise<{ scopeId: string | null; scopeName: string }> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  if (session.roles.some(r => r.scopeType === 'headquarters')) {
    return { scopeId: null, scopeName: '总部' }
  }

  const marketRole = session.roles.find(r => r.scopeType === 'market')
  if (marketRole) {
    const [node] = await db
      .select({ name: orgNodes.name })
      .from(orgNodes)
      .where(eq(orgNodes.id, marketRole.scopeId))
      .limit(1)
    return { scopeId: marketRole.scopeId, scopeName: node?.name ?? marketRole.scopeId }
  }

  const storeRole = session.roles.find(r => r.scopeType === 'store')
  if (storeRole) {
    const [storeNode] = await db
      .select({ parentId: orgNodes.parentId })
      .from(orgNodes)
      .where(eq(orgNodes.id, storeRole.scopeId))
      .limit(1)
    if (storeNode?.parentId) {
      const [parentNode] = await db
        .select({ id: orgNodes.id, name: orgNodes.name, type: orgNodes.type })
        .from(orgNodes)
        .where(eq(orgNodes.id, storeNode.parentId))
        .limit(1)
      if (parentNode?.type === 'market') {
        return { scopeId: parentNode.id, scopeName: parentNode.name }
      }
    }
  }

  return { scopeId: null, scopeName: '总部' }
}

// ===== 品项分类（商品管理） =====

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
    productKind: c.productKind ?? null,
    salesCategory: c.salesCategory as ProductCategory['salesCategory'],
    sortOrder: c.sortOrder,
    isValid: c.isValid,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }))
}

/**
 * 获取所有一级分类（品项类型），即 product_kind IS NULL 的行。
 */
export async function getProductKinds(): Promise<ProductCategory[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select()
    .from(productCategories)
    .where(sql`${productCategories.productKind} IS NULL`)
    .orderBy(productCategories.sortOrder)

  return rows.map((c) => ({
    categoryId: c.categoryId,
    categoryName: c.categoryName,
    productKind: null,
    salesCategory: null,
    sortOrder: c.sortOrder,
    isValid: c.isValid,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }))
}

/**
 * 创建一级分类（品项类型）
 */
export async function createProductKind(data: {
  categoryName: string
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  if (!data.categoryName.trim()) {
    return { success: false, message: '请输入品项类型名称' }
  }

  // 检查重名（同名一级分类）
  const [existing] = await db
    .select({ categoryId: productCategories.categoryId })
    .from(productCategories)
    .where(and(
      sql`${productCategories.productKind} IS NULL`,
      eq(productCategories.categoryName, data.categoryName.trim()),
    ))
    .limit(1)
  if (existing) {
    return { success: false, message: `品项类型「${data.categoryName.trim()}」已存在` }
  }

  const categoryId = crypto.randomUUID()
  await db.insert(productCategories).values({
    categoryId,
    categoryName: data.categoryName.trim(),
    productKind: null,
    sortOrder: data.sortOrder ?? 0,
    isValid: data.isValid ?? true,
  })

  await logOperation(session, 'product_kind.create', 'product_category', categoryId, { categoryName: data.categoryName.trim() })
  revalidatePath('/products')
  return { success: true, message: '品项类型创建成功' }
}

/**
 * 更新一级分类（品项类型）
 * 若 categoryName 变更，事务内同步更新所有子级的 product_kind 值。
 */
export async function updateProductKind(
  categoryId: string,
  data: Partial<{
    categoryName: string
    sortOrder: number
    isValid: boolean
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  // 查当前行（获取旧名称用于级联更新）
  const [current] = await db
    .select({ categoryName: productCategories.categoryName, updatedAt: productCategories.updatedAt })
    .from(productCategories)
    .where(eq(productCategories.categoryId, categoryId))
    .limit(1)
  if (!current) {
    return { success: false, message: '品项类型不存在' }
  }

  // 乐观锁检查
  if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) {
    return { success: false, message: '数据已被其他人修改，请刷新后重试' }
  }

  const newName = data.categoryName?.trim()

  // 重名检查
  if (newName && newName !== current.categoryName) {
    const [dup] = await db
      .select({ categoryId: productCategories.categoryId })
      .from(productCategories)
      .where(and(
        sql`${productCategories.productKind} IS NULL`,
        eq(productCategories.categoryName, newName),
      ))
      .limit(1)
    if (dup) {
      return { success: false, message: `品项类型「${newName}」已存在` }
    }
  }

  // 事务：更新自身 + 级联更新子级 product_kind
  await db.transaction(async (tx) => {
    const updateData: Record<string, unknown> = {}
    if (newName !== undefined) updateData.categoryName = newName
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder
    if (data.isValid !== undefined) updateData.isValid = data.isValid

    await tx
      .update(productCategories)
      .set(updateData)
      .where(eq(productCategories.categoryId, categoryId))

    // 若改名，级联更新所有子级的 product_kind
    if (newName && newName !== current.categoryName) {
      await tx
        .update(productCategories)
        .set({ productKind: newName })
        .where(eq(productCategories.productKind, current.categoryName))
    }
  })

  await logOperation(session, 'product_kind.update', 'product_category', categoryId, data)
  revalidatePath('/products')
  return { success: true, message: '品项类型已更新' }
}

export async function createCategory(data: {
  categoryName: string
  productKind: string
  salesCategory?: string | null
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  const categoryId = crypto.randomUUID()
  try {
    await db.insert(productCategories).values({
      categoryId,
      categoryName: data.categoryName,
      productKind: data.productKind,
      salesCategory: data.salesCategory as typeof productCategories.$inferInsert['salesCategory'],
      sortOrder: data.sortOrder,
      isValid: data.isValid,
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '分类编号已存在' }
    throw err
  }

  await logOperation(session, 'category.create', 'product_category', categoryId, { categoryName: data.categoryName })
  revalidatePath('/products')
  return { success: true, message: '分类创建成功' }
}

export async function updateCategory(
  categoryId: string,
  data: Partial<{
    categoryName: string
    productKind: string
    salesCategory: string | null
    sortOrder: number
    isValid: boolean
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(productCategories.categoryId, categoryId), sql`date_trunc('milliseconds', ${productCategories.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(productCategories.categoryId, categoryId)

  const result = await db
    .update(productCategories)
    .set({
      ...data,
      salesCategory: data.salesCategory as typeof productCategories.$inferInsert['salesCategory'],
    })
    .where(whereConditions)

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '分类不存在',
    }
  }

  await logOperation(session, 'category.update', 'product_category', categoryId, data)
  revalidatePath('/products')
  return { success: true, message: '分类已更新' }
}

// ===== SKU（商品管理，独立实体） =====

export async function getAllSkus(): Promise<ProductSku[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select({
      sku: productSkus,
      categoryName: productCategories.categoryName,
      productKind: productCategories.productKind,
      salesCategory: productCategories.salesCategory,
    })
    .from(productSkus)
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .orderBy(productSkus.sortOrder)
    .limit(1000)

  return rows.map((r) => ({
    skuId: r.sku.skuId,
    categoryId: r.sku.categoryId,
    productType: r.sku.productType as ProductSku['productType'],
    specName: r.sku.specName,
    price: r.sku.price,
    specialPrice: r.sku.specialPrice,
    sessionCount: r.sku.sessionCount,
    sortOrder: r.sku.sortOrder,
    serviceFee: r.sku.serviceFee,
    isShengmei: r.sku.isShengmei,
    marketScope: r.sku.marketScope,
    validStart: r.sku.validStart,
    validEnd: r.sku.validEnd,
    createdAt: r.sku.createdAt.toISOString(),
    updatedAt: r.sku.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
    productKind: r.productKind ?? undefined,
    salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
  }))
}

/** 根据 skuId 获取单个 SKU 详情 */
export async function getSkuById(skuId: string): Promise<ProductSku | null> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select({
      sku: productSkus,
      categoryName: productCategories.categoryName,
      productKind: productCategories.productKind,
      salesCategory: productCategories.salesCategory,
    })
    .from(productSkus)
    .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(eq(productSkus.skuId, skuId))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]
  return {
    skuId: r.sku.skuId,
    categoryId: r.sku.categoryId,
    productType: r.sku.productType as ProductSku['productType'],
    specName: r.sku.specName,
    price: r.sku.price,
    specialPrice: r.sku.specialPrice,
    sessionCount: r.sku.sessionCount,
    sortOrder: r.sku.sortOrder,
    serviceFee: r.sku.serviceFee,
    isShengmei: r.sku.isShengmei,
    marketScope: r.sku.marketScope,
    validStart: r.sku.validStart,
    validEnd: r.sku.validEnd,
    createdAt: r.sku.createdAt.toISOString(),
    updatedAt: r.sku.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
    productKind: r.productKind ?? undefined,
    salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
  }
}

/** 获取商城商品关联的 SKU 列表（通过 mall_product_skus） */
export async function getSkusByProductId(productId: string): Promise<ProductSku[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select({
      sku: productSkus,
      bundlePrice: mallProductSkus.bundlePrice,
      displayOrder: mallProductSkus.sortOrder,
    })
    .from(mallProductSkus)
    .innerJoin(productSkus, eq(mallProductSkus.skuId, productSkus.skuId))
    .where(eq(mallProductSkus.productId, productId))
    .orderBy(mallProductSkus.sortOrder)

  return rows.map((r) => ({
    skuId: r.sku.skuId,
    categoryId: r.sku.categoryId,
    productType: r.sku.productType as ProductSku['productType'],
    specName: r.sku.specName,
    price: r.sku.price,
    specialPrice: r.sku.specialPrice,
    sessionCount: r.sku.sessionCount,
    sortOrder: r.sku.sortOrder,
    serviceFee: r.sku.serviceFee,
    isShengmei: r.sku.isShengmei,
    marketScope: r.sku.marketScope,
    validStart: r.sku.validStart,
    validEnd: r.sku.validEnd,
    createdAt: r.sku.createdAt.toISOString(),
    updatedAt: r.sku.updatedAt.toISOString(),
  }))
}

const VALID_PRODUCT_TYPES = ['疗程卡', '单品', '院装产品'] as const

export async function createSku(data: {
  skuId: string
  categoryId: string
  productType: string
  specName: string
  price: string
  specialPrice?: string | null
  sessionCount?: number | null
  sortOrder?: number
  serviceFee?: string
  isShengmei?: boolean | null
  marketScope?: string | null
  validStart?: string | null
  validEnd?: string | null
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  if (!VALID_PRODUCT_TYPES.includes(data.productType as typeof VALID_PRODUCT_TYPES[number])) {
    return { success: false, message: `无效的产品类型: ${data.productType}` }
  }

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

  if (data.productType === '疗程卡') {
    if (!data.sessionCount || data.sessionCount < 1) {
      return { success: false, message: '疗程卡的次数必须 >= 1' }
    }
  }

  if (data.validStart && data.validEnd && data.validStart > data.validEnd) {
    return { success: false, message: '有效期开始日期不能晚于结束日期' }
  }

  try {
    await db.insert(productSkus).values({
      ...data,
      productType: data.productType as typeof productSkus.$inferInsert['productType'],
    })
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: 'SKU 编号已存在' }
    if (err?.code === '23503') return { success: false, message: '品项分类不存在，请检查 categoryId' }
    throw err
  }

  await logOperation(session, 'sku.create', 'product_sku', data.skuId, { specName: data.specName })
  revalidatePath('/products')
  return { success: true, message: 'SKU 创建成功' }
}

export async function updateSku(
  skuId: string,
  data: Partial<{
    categoryId: string
    productType: string
    specName: string
    price: string
    specialPrice: string | null
    sessionCount: number | null
    sortOrder: number
    serviceFee: string
    isShengmei: boolean | null
    marketScope: string | null
    validStart: string | null
    validEnd: string | null
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(productSkus.skuId, skuId), sql`date_trunc('milliseconds', ${productSkus.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(productSkus.skuId, skuId)

  const result = await db
    .update(productSkus)
    .set({
      ...data,
      productType: data.productType as typeof productSkus.$inferInsert['productType'],
    })
    .where(whereConditions)

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : 'SKU 不存在',
    }
  }

  await logOperation(session, 'sku.update', 'product_sku', skuId, data)
  revalidatePath('/products')
  return { success: true, message: '规格已更新' }
}

export async function deleteSku(skuId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const { saleItems } = await import('@db/order')
  const [ref] = await db
    .select({ saleItemId: saleItems.saleItemId })
    .from(saleItems)
    .where(eq(saleItems.skuId, skuId))
    .limit(1)
  if (ref) {
    return { success: false, message: '该 SKU 已被订单引用，无法删除。可通过设置有效期下架' }
  }

  // 先删关联
  await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))
  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))

  await logOperation(session, 'sku.delete', 'product_sku', skuId)
  revalidatePath('/products')
  return { success: true, message: 'SKU 已删除' }
}

// ===== 商城管理（mall_categories + products + mall_product_skus） =====

export async function getMallCategories(): Promise<MallCategory[]> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select()
    .from(mallCategories)
    .orderBy(mallCategories.sortOrder)

  return rows.map((c) => ({
    categoryId: c.categoryId,
    categoryName: c.categoryName,
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
      productId: mallProductSkus.productId,
      count: sql<number>`count(*)::int`.as('sku_count'),
    })
    .from(mallProductSkus)
    .groupBy(mallProductSkus.productId)
    .as('sku_count_sq')

  const rows = await db
    .select({
      product: products,
      categoryName: mallCategories.categoryName,
      skuCount: skuCountSq.count,
    })
    .from(products)
    .leftJoin(mallCategories, eq(products.categoryId, mallCategories.categoryId))
    .leftJoin(skuCountSq, eq(products.productId, skuCountSq.productId))
    .orderBy(products.sortOrder)
    .limit(500)

  return rows.map((r) => ({
    productId: r.product.productId,
    categoryId: r.product.categoryId,
    name: r.product.name,
    coverImage: r.product.coverImage,
    detailImages: r.product.detailImages,
    description: r.product.description,
    isBundle: r.product.isBundle,
    pickCount: r.product.pickCount,
    price: r.product.price,
    specialPrice: r.product.specialPrice,
    manageScope: r.product.manageScope,
    marketScope: r.product.marketScope,
    sortOrder: r.product.sortOrder,
    validStart: r.product.validStart,
    validEnd: r.product.validEnd,
    createdAt: r.product.createdAt.toISOString(),
    updatedAt: r.product.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
    skuCount: r.skuCount ?? 0,
  }))
}

export async function getProductById(productId: string): Promise<Product | null> {
  const session = await getSession()
  requirePermission(session, 'product:list')

  const rows = await db
    .select({
      product: products,
      categoryName: mallCategories.categoryName,
    })
    .from(products)
    .leftJoin(mallCategories, eq(products.categoryId, mallCategories.categoryId))
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
    isBundle: r.product.isBundle,
    pickCount: r.product.pickCount,
    price: r.product.price,
    specialPrice: r.product.specialPrice,
    manageScope: r.product.manageScope,
    marketScope: r.product.marketScope,
    sortOrder: r.product.sortOrder,
    validStart: r.product.validStart,
    validEnd: r.product.validEnd,
    createdAt: r.product.createdAt.toISOString(),
    updatedAt: r.product.updatedAt.toISOString(),
    categoryName: r.categoryName ?? undefined,
  }
}

export async function createProduct(data: {
  productId: string
  categoryId: string
  name: string
  coverImage?: string | null
  detailImages?: string[] | null
  description?: string | null
  isBundle?: boolean
  pickCount?: number | null
  price: string
  specialPrice?: string | null
  manageScope?: string | null
  marketScope?: string | null
  sortOrder?: number
  validStart?: string | null
  validEnd?: string | null
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  const price = Number(data.price)
  if (isNaN(price) || price < 0) {
    return { success: false, message: '价格必须为非负数' }
  }

  // 校验商品分类存在
  const [cat] = await db
    .select({ categoryId: mallCategories.categoryId })
    .from(mallCategories)
    .where(eq(mallCategories.categoryId, data.categoryId))
    .limit(1)
  if (!cat) {
    return { success: false, message: '商品分类不存在' }
  }

  if (data.validStart && data.validEnd && data.validStart > data.validEnd) {
    return { success: false, message: '有效期开始日期不能晚于结束日期' }
  }

  try {
    await db.insert(products).values(data)
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '商品编号已存在' }
    throw err
  }

  await logOperation(session, 'product.create', 'product', data.productId, { name: data.name })
  revalidatePath('/mall')
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
    isBundle: boolean
    pickCount: number | null
    price: string
    specialPrice: string | null
    manageScope: string | null
    marketScope: string | null
    sortOrder: number
    validStart: string | null
    validEnd: string | null
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(products.productId, productId), sql`date_trunc('milliseconds', ${products.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(products.productId, productId)

  const result = await db
    .update(products)
    .set(data)
    .where(whereConditions)

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商品不存在',
    }
  }

  await logOperation(session, 'product.update', 'product', productId, data)
  revalidatePath('/mall')
  return { success: true, message: '商品信息已更新' }
}

export async function createMallCategory(data: {
  categoryId: string
  categoryName: string
  sortOrder?: number
  isValid?: boolean
}): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:create')

  try {
    await db.insert(mallCategories).values(data)
  } catch (err: any) {
    if (err?.code === '23505') return { success: false, message: '分类编号已存在' }
    throw err
  }

  await logOperation(session, 'mall_category.create', 'mall_category', data.categoryId, { categoryName: data.categoryName })
  revalidatePath('/mall')
  return { success: true, message: '商品分类创建成功' }
}

export async function updateMallCategory(
  categoryId: string,
  data: Partial<{
    categoryName: string
    sortOrder: number
    isValid: boolean
  }>,
  expectedUpdatedAt?: string,
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'product:update')

  const whereConditions = expectedUpdatedAt
    ? and(eq(mallCategories.categoryId, categoryId), sql`date_trunc('milliseconds', ${mallCategories.updatedAt}) = ${expectedUpdatedAt}`)
    : eq(mallCategories.categoryId, categoryId)

  const result = await db
    .update(mallCategories)
    .set(data)
    .where(whereConditions)

  if ((result as any).count === 0) {
    return {
      success: false,
      message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '分类不存在',
    }
  }

  await logOperation(session, 'mall_category.update', 'mall_category', categoryId, data)
  revalidatePath('/mall')
  return { success: true, message: '商品分类已更新' }
}
