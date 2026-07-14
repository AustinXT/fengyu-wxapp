'use server'

import { db } from '@/db'
import { pgErrorCode } from '@/lib/pg-error'
import { productCategories, products, productSkus, mallCategories, mallBundleGroups, mallProductSkus } from '@db/product'
import { projectSeriesLookup } from '@db/lookup'
import { orgNodes } from '@db/org'
import { alias } from 'drizzle-orm/pg-core'
import { eq, and, asc, sql, inArray, isNotNull, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import crypto from 'crypto'
import type { ProductCategory, Product, ProductSku, ProjectSeries, MallCategory, MallBundleGroup } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { expandVisibleMarketIds, requireAdmin } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
import { computeBundleTotals } from '@/lib/bundle-price'
import { nowTs } from '@/lib/db-time'


export const getMarkets = withPermission(
  'product:list',
  async (session): Promise<{ id: string; name: string }[]> => {
    const visibleIds = await expandVisibleMarketIds(session)
    if (visibleIds !== null && visibleIds.length === 0) return []

    const scopeCond = visibleIds === null ? undefined : inArray(orgNodes.id, visibleIds)
    const rows = await db
      .select({ id: orgNodes.id, name: orgNodes.name })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, '市场'), eq(orgNodes.isActive, true), scopeCond))
      
      .orderBy(asc(orgNodes.sortOrder))

    return rows
  },
)


export const resolveManageScope = withPermission(
  'product:list',
  async (session): Promise<{ scopeId: string | null; scopeName: string }> => {
    if (session.roles.some(r => r.scopeType === '总部')) {
      return { scopeId: null, scopeName: '总部' }
    }

    const marketRole = session.roles.find(r => r.scopeType === '市场')
    if (marketRole) {
      const [node] = await db
        .select({ name: orgNodes.name })
        .from(orgNodes)
        .where(eq(orgNodes.id, marketRole.scopeId))
        .limit(1)
      return { scopeId: marketRole.scopeId, scopeName: node?.name ?? marketRole.scopeId }
    }

    const storeRole = session.roles.find(r => r.scopeType === '门店')
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
        if (parentNode?.type === '市场') {
          return { scopeId: parentNode.id, scopeName: parentNode.name }
        }
      }
    }

    return { scopeId: null, scopeName: '总部' }
  },
)




export const getProjectSeries = withPermission(
  'product:list',
  async (_session): Promise<ProjectSeries[]> => {
    const rows = await db
      .select({
        id: projectSeriesLookup.id,
        name: projectSeriesLookup.name,
        sortOrder: projectSeriesLookup.sortOrder,
        isValid: projectSeriesLookup.isValid,
      })
      .from(projectSeriesLookup)
      .where(eq(projectSeriesLookup.isValid, true))
      
      .orderBy(asc(projectSeriesLookup.sortOrder), asc(projectSeriesLookup.id))
    return rows
  },
)



export const getCategories = withPermission(
  'product:list',
  async (_session): Promise<ProductCategory[]> => {
    
    
    
    const parent = alias(productCategories, 'parent_cat') as unknown as typeof productCategories
    const rows = await db
      .select({
        child: productCategories,
        parentDisplayColor: parent.displayColor,
      })
      .from(productCategories)
      .leftJoin(
        parent,
        and(
          isNull(parent.productKind),
          eq(parent.categoryName, productCategories.productKind),
        )!,
      )
      
      .orderBy(asc(productCategories.sortOrder))

    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({
      categoryId: r.child.categoryId,
      categoryName: r.child.categoryName,
      productKind: r.child.productKind ?? null,
      salesCategory: r.child.salesCategory as ProductCategory['salesCategory'],
      sortOrder: r.child.sortOrder,
      isValid: r.child.isValid,
      displayColor: r.child.displayColor,
      parentDisplayColor: r.parentDisplayColor,
      createdAt: r.child.createdAt.toISOString(),
      updatedAt: r.child.updatedAt.toISOString(),
    }))
  },
)


export const getProductKinds = withPermission(
  'product:list',
  async (_session): Promise<ProductCategory[]> => {
    const rows = await db
      .select()
      .from(productCategories)
      .where(sql`${productCategories.productKind} IS NULL`)
      
      .orderBy(asc(productCategories.sortOrder))

    return rows.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      productKind: null,
      salesCategory: null,
      sortOrder: c.sortOrder,
      isValid: c.isValid,
      displayColor: c.displayColor,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  },
)


export const createProductKind = withPermission(
  'product:create',
  async (
    session,
    data: {
      categoryName: string
      sortOrder?: number
      isValid?: boolean
      displayColor?: string | null
    },
  ): Promise<{ success: boolean; message: string }> => {
    if (!data.categoryName.trim()) {
      return { success: false, message: '请输入品项一级分类名称' }
    }

    
    const [existing] = await db
      .select({ categoryId: productCategories.categoryId })
      .from(productCategories)
      .where(and(
        sql`${productCategories.productKind} IS NULL`,
        eq(productCategories.categoryName, data.categoryName.trim()),
      ))
      .limit(1)
    if (existing) {
      return { success: false, message: `品项一级分类「${data.categoryName.trim()}」已存在` }
    }

    const categoryId = crypto.randomUUID()
    await db.insert(productCategories).values({
      categoryId,
      categoryName: data.categoryName.trim(),
      productKind: null,
      sortOrder: data.sortOrder ?? 0,
      isValid: data.isValid ?? true,
      displayColor: data.displayColor ?? null,
    })

    await logOperation(session, 'product_kind.create', 'product_category', categoryId, {
      categoryName: data.categoryName.trim(),
      displayColor: data.displayColor ?? null,
    })
    revalidatePath('/products')
    return { success: true, message: '品项一级分类创建成功' }
  },
)


export const updateProductKind = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    data: Partial<{
      categoryName: string
      sortOrder: number
      isValid: boolean
      displayColor: string | null
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [current] = await db
      .select()
      .from(productCategories)
      .where(eq(productCategories.categoryId, categoryId))
      .limit(1)
    if (!current) {
      return { success: false, message: '品项一级分类不存在' }
    }

    
    if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) {
      return { success: false, message: '数据已被其他人修改，请刷新后重试' }
    }

    const newName = data.categoryName?.trim()

    
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
        return { success: false, message: `品项一级分类「${newName}」已存在` }
      }
    }

    
    await db.transaction(async (tx) => {
      const updateData: Record<string, unknown> = {}
      if (newName !== undefined) updateData.categoryName = newName
      if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder
      if (data.isValid !== undefined) updateData.isValid = data.isValid
      if (data.displayColor !== undefined) updateData.displayColor = data.displayColor

      await tx
        .update(productCategories)
        .set(updateData)
        .where(eq(productCategories.categoryId, categoryId))

      
      if (newName && newName !== current.categoryName) {
        await tx
          .update(productCategories)
          .set({ productKind: newName })
          .where(eq(productCategories.productKind, current.categoryName))
      }
    })

    await logUpdate(session, 'product_kind.update', 'product_category', categoryId, current as Record<string, unknown>, data)
    revalidatePath('/products')
    return { success: true, message: '品项一级分类已更新' }
  },
)

export const createCategory = withPermission(
  'product:create',
  async (
    session,
    data: {
      categoryName: string
      productKind: string
      salesCategory?: string | null
      sortOrder?: number
      isValid?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
    
    const [kindRow] = await db
      .select({ categoryId: productCategories.categoryId })
      .from(productCategories)
      .where(and(
        sql`${productCategories.productKind} IS NULL`,
        eq(productCategories.categoryName, data.productKind),
        eq(productCategories.isValid, true),
      ))
      .limit(1)
    if (!kindRow) {
      return { success: false, message: 'INVALID_PARAMS: 品项一级分类不存在或已停用' }
    }

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
      if (pgErrorCode(err) === '23505') return { success: false, message: '分类编号已存在' }
      throw err
    }

    await logOperation(session, 'category.create', 'product_category', categoryId, { categoryName: data.categoryName })
    revalidatePath('/products')
    return { success: true, message: '分类创建成功' }
  },
)


export const deleteCategory = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    
    const [skuRef] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(productSkus)
      .where(eq(productSkus.categoryId, categoryId))
    if (skuRef && skuRef.c > 0) {
      return {
        success: false,
        message: `INVALID_STATE: REFERENCE_EXISTS: 该分类下还有 ${skuRef.c} 个 SKU，无法删除；请先停用`,
      }
    }

    
    const couponRefRes: any = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM coupon_templates
      WHERE ${categoryId} = ANY(applicable_category_ids)
    `)
    const couponRefRow = Array.isArray(couponRefRes)
      ? couponRefRes[0]
      : couponRefRes?.rows?.[0]
    const couponRefCount = Number(couponRefRow?.c ?? 0)
    if (couponRefCount > 0) {
      return {
        success: false,
        message: `INVALID_STATE: REFERENCE_EXISTS: 该分类被 ${couponRefCount} 张优惠券引用，无法删除；请先停用`,
      }
    }

    
    const result: any = await db
      .delete(productCategories)
      .where(and(
        eq(productCategories.categoryId, categoryId),
        sql`date_trunc('milliseconds', ${productCategories.updatedAt}) = ${expectedUpdatedAt}`,
      ))

    if ((result?.count ?? 0) === 0) {
      return { success: false, message: 'CONFLICT: 分类已被其他人修改或已不存在，请刷新' }
    }

    await logOperation(session, 'category.delete', 'product_category', categoryId, {})
    revalidatePath('/products')
    return { success: true, message: '分类已删除' }
  },
)

export const updateCategory = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    data: Partial<{
      categoryName: string
      productKind: string
      salesCategory: string | null
      sortOrder: number
      isValid: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    if (data.productKind !== undefined) {
      const [kindRow] = await db
        .select({ categoryId: productCategories.categoryId })
        .from(productCategories)
        .where(and(
          sql`${productCategories.productKind} IS NULL`,
          eq(productCategories.categoryName, data.productKind),
          eq(productCategories.isValid, true),
        ))
        .limit(1)
      if (!kindRow) {
        return { success: false, message: 'INVALID_PARAMS: 品项一级分类不存在或已停用' }
      }
    }

    
    const [before] = await db.select().from(productCategories).where(eq(productCategories.categoryId, categoryId)).limit(1)

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

    await logUpdate(session, 'category.update', 'product_category', categoryId, before as Record<string, unknown>, data)
    revalidatePath('/products')
    return { success: true, message: '分类已更新' }
  },
)



export const getAllSkus = withPermission(
  'product:list',
  async (_session): Promise<ProductSku[]> => {
    const rows = await db
      .select({
        sku: productSkus,
        categoryName: productCategories.categoryName,
        productKind: productCategories.productKind,
        salesCategory: productCategories.salesCategory,
        projectSeriesName: projectSeriesLookup.name,
      })
      .from(productSkus)
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .leftJoin(projectSeriesLookup, eq(productSkus.projectSeriesId, projectSeriesLookup.id))
      .where(isNull(productSkus.deletedAt))
      
      .orderBy(asc(productSkus.sortOrder))
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
      isExperience: r.sku.isExperience,
      isManagerSpecial: r.sku.isManagerSpecial,
      projectSeriesId: r.sku.projectSeriesId,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
      productKind: r.productKind ?? undefined,
      salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
      projectSeriesName: r.projectSeriesName ?? null,
    }))
  },
)


export const getSkuById = withPermission(
  'product:list',
  async (_session, skuId: string): Promise<ProductSku | null> => {
    const rows = await db
      .select({
        sku: productSkus,
        categoryName: productCategories.categoryName,
        productKind: productCategories.productKind,
        salesCategory: productCategories.salesCategory,
        projectSeriesName: projectSeriesLookup.name,
      })
      .from(productSkus)
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .leftJoin(projectSeriesLookup, eq(productSkus.projectSeriesId, projectSeriesLookup.id))
      .where(and(eq(productSkus.skuId, skuId), isNull(productSkus.deletedAt)))
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
      isExperience: r.sku.isExperience,
      isManagerSpecial: r.sku.isManagerSpecial,
      projectSeriesId: r.sku.projectSeriesId,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
      productKind: r.productKind ?? undefined,
      salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
      projectSeriesName: r.projectSeriesName ?? null,
    }
  },
)


export const getSkusByProductId = withPermission(
  'product:list',
  async (_session, productId: string): Promise<ProductSku[]> => {
    const rows = await db
      .select({
        sku: productSkus,
        bundlePrice: mallProductSkus.bundlePrice,
        bundleListPrice: mallProductSkus.bundleListPrice,
        bundleGroupId: mallProductSkus.bundleGroupId,
        displayOrder: mallProductSkus.sortOrder,
        groupName: mallBundleGroups.groupName,
      })
      .from(mallProductSkus)
      .innerJoin(productSkus, eq(mallProductSkus.skuId, productSkus.skuId))
      .leftJoin(mallBundleGroups, eq(mallProductSkus.bundleGroupId, mallBundleGroups.id))
      .where(eq(mallProductSkus.productId, productId))
      
      .orderBy(asc(mallProductSkus.sortOrder))

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
      isExperience: r.sku.isExperience,
      isManagerSpecial: r.sku.isManagerSpecial,
      projectSeriesId: r.sku.projectSeriesId,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      bundlePrice: r.bundlePrice,
      bundleListPrice: r.bundleListPrice,
      bundleGroupId: r.bundleGroupId,
      groupName: r.groupName,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
    }))
  },
)

const VALID_PRODUCT_TYPES = ['疗程卡', '家居产品'] as const

export const createSku = withPermission(
  'product:create',
  async (
    session,
    data: {
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
      
      isExperience?: boolean
      
      isManagerSpecial?: boolean
      
      projectSeriesId?: number | null
      marketScope?: string | null
      isEnabled?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
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

    
    

    try {
      await db.insert(productSkus).values({
        ...data,
        productType: data.productType as typeof productSkus.$inferInsert['productType'],
      })
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '商品编号已存在' }
      if (pgErrorCode(err) === '23503') return { success: false, message: '品项分类不存在，请检查 categoryId' }
      throw err
    }

    await logOperation(session, 'sku.create', 'product_sku', data.skuId, { specName: data.specName })
    revalidatePath('/products')
    return { success: true, message: '商品创建成功' }
  },
)

export const updateSku = withPermission(
  'product:update',
  async (
    session,
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
      
      isExperience: boolean
      
      isManagerSpecial: boolean
      
      projectSeriesId: number | null
      marketScope: string | null
      isEnabled: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [before] = await db.select().from(productSkus).where(and(eq(productSkus.skuId, skuId), isNull(productSkus.deletedAt))).limit(1)

    
    if (before && (data.productType ?? before.productType) === '疗程卡') {
      const finalSessionCount = data.sessionCount !== undefined ? data.sessionCount : before.sessionCount
      if (!finalSessionCount || finalSessionCount < 1) {
        return { success: false, message: '疗程卡的次数必须 >= 1' }
      }
    }

    

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
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商品不存在',
      }
    }

    
    
    if (data.isEnabled !== undefined && before && before.isEnabled !== data.isEnabled) {
      const affected = await db
        .select({ productId: mallProductSkus.productId })
        .from(mallProductSkus)
        .innerJoin(products, eq(products.productId, mallProductSkus.productId))
        .where(and(eq(mallProductSkus.skuId, skuId), eq(products.isBundle, true)))
      const bundleIds = [...new Set(affected.map((a) => a.productId))]
      if (bundleIds.length > 0) {
        await db.transaction(async (tx) => {
          for (const pid of bundleIds) await recomputeBundlePrice(pid, tx)
        })
      }
    }

    await logUpdate(session, 'sku.update', 'product_sku', skuId, before as Record<string, unknown>, data)
    revalidatePath('/products')
    return { success: true, message: '规格已更新' }
  },
)

export const deleteSku = withPermission(
  'product:update',
  async (session, skuId: string): Promise<{ success: boolean; message: string }> => {
    const { saleItems } = await import('@db/order')
    const [ref] = await db
      .select({ saleItemId: saleItems.saleItemId })
      .from(saleItems)
      .where(eq(saleItems.skuId, skuId))
      .limit(1)
    if (ref) {
      return { success: false, message: '该商品已被订单引用，无法删除。可通过设置有效期下架' }
    }

    
    const [snapshot] = await db
      .select()
      .from(productSkus)
      .where(and(eq(productSkus.skuId, skuId), isNull(productSkus.deletedAt)))
      .limit(1)
    if (!snapshot) {
      return { success: false, message: '商品不存在或已被删除' }
    }

    await logOperation(session, 'sku.delete', 'product_sku', skuId, {
      snapshot: {
        skuId: snapshot.skuId,
        categoryId: snapshot.categoryId,
        specName: snapshot.specName,
        price: snapshot.price,
        productType: snapshot.productType,
        isExperience: snapshot.isExperience,
      },
    })

    
    await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))

    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await db
      .update(productSkus)
      .set({ deletedAt: nowTs(), deletedBy: session.employeeId })
      .where(and(eq(productSkus.skuId, skuId), isNull(productSkus.deletedAt)))

    if (result.count === 0) {
      return { success: false, message: '商品状态变更，请刷新重试' }
    }

    revalidatePath('/products')
    return { success: true, message: '商品已删除' }
  },
)



type ProductTx = Parameters<Parameters<typeof db.transaction>[0]>[0]


async function syncBundleGroupSkuPrices(groupId: number, tx: ProductTx): Promise<void> {
  const [g] = await tx
    .select({ listPrice: mallBundleGroups.unitListPrice, memberPrice: mallBundleGroups.unitMemberPrice })
    .from(mallBundleGroups)
    .where(eq(mallBundleGroups.id, groupId))
    .limit(1)
  if (!g) return
  await tx
    .update(mallProductSkus)
    .set({ bundleListPrice: g.listPrice, bundlePrice: g.memberPrice ?? g.listPrice })
    .where(eq(mallProductSkus.bundleGroupId, groupId))
}


async function recomputeBundlePrice(productId: string, tx: ProductTx): Promise<void> {
  const groups = await tx
    .select({
      id: mallBundleGroups.id,
      pickCount: mallBundleGroups.pickCount,
      listPrice: mallBundleGroups.unitListPrice,
      memberPrice: mallBundleGroups.unitMemberPrice,
    })
    .from(mallBundleGroups)
    .where(eq(mallBundleGroups.productId, productId))

  
  
  const counts = await tx
    .select({ groupId: mallProductSkus.bundleGroupId, cnt: sql<number>`count(*)::int` })
    .from(mallProductSkus)
    .innerJoin(productSkus, eq(mallProductSkus.skuId, productSkus.skuId))
    .where(and(eq(mallProductSkus.productId, productId), eq(productSkus.isEnabled, true)))
    .groupBy(mallProductSkus.bundleGroupId)
  const countMap = new Map<number, number>()
  for (const c of counts) if (c.groupId != null) countMap.set(c.groupId, Number(c.cnt))

  const { price, specialPrice } = computeBundleTotals(
    groups.map((g) => ({
      pickCount: g.pickCount,
      listPrice: g.listPrice,
      memberPrice: g.memberPrice,
      skuCount: countMap.get(g.id) ?? 0,
    })),
  )

  await tx.update(products).set({ price, specialPrice }).where(eq(products.productId, productId))
}



export const addSkuToProduct = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    skuId: string,
    sortOrder?: number,
    bundleGroupId?: number | null,
  ): Promise<{ success: boolean; message: string }> => {
    const [prod] = await db
      .select({ isBundle: products.isBundle })
      .from(products)
      .where(eq(products.productId, productId))
      .limit(1)
    if (!prod) return { success: false, message: '商品不存在' }
    
    if (prod.isBundle) {
      if (bundleGroupId == null) return { success: false, message: '套餐商品的规格必须归入分组' }
      const [grp] = await db
        .select({ id: mallBundleGroups.id })
        .from(mallBundleGroups)
        .where(and(eq(mallBundleGroups.id, bundleGroupId), eq(mallBundleGroups.productId, productId)))
        .limit(1)
      if (!grp) return { success: false, message: '分组不存在或不属于该商品' }
    }
    try {
      await db.transaction(async (tx) => {
        await tx.insert(mallProductSkus).values({
          productId,
          skuId,
          sortOrder: sortOrder ?? 0,
          bundleGroupId: bundleGroupId ?? null,
        })
        
        if (prod.isBundle && bundleGroupId != null) {
          await syncBundleGroupSkuPrices(bundleGroupId, tx)
          await recomputeBundlePrice(productId, tx)
        }
      })
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '该规格已关联到此商品' }
      if (pgErrorCode(err) === '23503') return { success: false, message: '商品或规格不存在' }
      console.error('[addSkuToProduct] insert failed:', err)
      return { success: false, message: `添加失败: ${err?.message ?? '未知错误'}` }
    }

    await logOperation(session, 'mall_product_sku.create', 'mall_product_sku', productId, { skuId })
    revalidatePath('/mall')
    return { success: true, message: '规格已添加' }
  },
)

export const removeSkuFromProduct = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    skuId: string,
  ): Promise<{ success: boolean; message: string }> => {
    const [prod] = await db
      .select({ isBundle: products.isBundle })
      .from(products)
      .where(eq(products.productId, productId))
      .limit(1)

    let removed = false
    await db.transaction(async (tx) => {
      const result = await tx
        .delete(mallProductSkus)
        .where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId)))
      if ((result as any).count === 0) return
      removed = true
      
      if (prod?.isBundle) await recomputeBundlePrice(productId, tx)
    })

    if (!removed) {
      return { success: false, message: '关联记录不存在' }
    }

    await logOperation(session, 'mall_product_sku.delete', 'mall_product_sku', productId, { skuId })
    revalidatePath('/mall')
    return { success: true, message: '规格已移除' }
  },
)






export const getBundleGroupsByProductId = withPermission(
  'product:list',
  async (_session, productId: string): Promise<MallBundleGroup[]> => {
    const rows = await db
      .select()
      .from(mallBundleGroups)
      .where(eq(mallBundleGroups.productId, productId))
      
      .orderBy(asc(mallBundleGroups.sortOrder))

    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      groupName: r.groupName,
      pickCount: r.pickCount,
      unitListPrice: r.unitListPrice,
      unitMemberPrice: r.unitMemberPrice,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt.toISOString(),
    }))
  },
)


function validateBundleUnitPrices(
  listPrice: string | null | undefined,
  memberPrice: string | null | undefined,
): string | null {
  if (listPrice == null || listPrice === '') return '请填写标价单价'
  const list = Number(listPrice)
  if (!Number.isFinite(list) || list < 0) return '标价单价必须为非负数'
  if (memberPrice != null && memberPrice !== '') {
    const member = Number(memberPrice)
    if (!Number.isFinite(member) || member < 0) return '会员价单价必须为非负数'
    if (member > list + 0.005) return '会员价单价不能高于标价单价'
  }
  return null
}

export const createBundleGroup = withPermission(
  'product:update',
  async (
    session,
    data: {
      productId: string
      groupName: string
      pickCount?: number | null
      sortOrder?: number
      unitListPrice: string
      unitMemberPrice?: string | null
    },
  ): Promise<{ success: boolean; message: string; id?: number }> => {
    if (!data.groupName.trim()) {
      return { success: false, message: '分组名称不能为空' }
    }
    if (data.pickCount !== undefined && data.pickCount !== null && data.pickCount < 1) {
      return { success: false, message: '可选数量必须大于 0' }
    }
    const priceErr = validateBundleUnitPrices(data.unitListPrice, data.unitMemberPrice)
    if (priceErr) return { success: false, message: priceErr }
    const memberPrice = data.unitMemberPrice != null && data.unitMemberPrice !== '' ? data.unitMemberPrice : null

    try {
      let newId = 0
      await db.transaction(async (tx) => {
        const [row] = await tx.insert(mallBundleGroups).values({
          productId: data.productId,
          groupName: data.groupName.trim(),
          pickCount: data.pickCount ?? null,
          sortOrder: data.sortOrder ?? 0,
          unitListPrice: data.unitListPrice,
          unitMemberPrice: memberPrice,
        }).returning({ id: mallBundleGroups.id })
        newId = row.id
        
        await recomputeBundlePrice(data.productId, tx)
      })

      await logOperation(session, 'bundle_group.create', 'mall_bundle_group', String(newId), { productId: data.productId, groupName: data.groupName })
      revalidatePath('/mall')
      return { success: true, message: '分组已创建', id: newId }
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '该商品下已存在同名分组' }
      if (pgErrorCode(err) === '23503') return { success: false, message: '商品不存在' }
      throw err
    }
  },
)

export const updateBundleGroup = withPermission(
  'product:update',
  async (
    session,
    id: number,
    data: Partial<{ groupName: string; pickCount: number | null; sortOrder: number; unitListPrice: string; unitMemberPrice: string | null }>,
  ): Promise<{ success: boolean; message: string }> => {
    if (data.groupName !== undefined && !data.groupName.trim()) {
      return { success: false, message: '分组名称不能为空' }
    }
    if (data.pickCount !== undefined && data.pickCount !== null && data.pickCount < 1) {
      return { success: false, message: '可选数量必须大于 0' }
    }

    
    const [before] = await db.select().from(mallBundleGroups).where(eq(mallBundleGroups.id, id)).limit(1)
    if (!before) return { success: false, message: '分组不存在' }

    
    if (data.unitListPrice !== undefined || data.unitMemberPrice !== undefined) {
      const finalList = data.unitListPrice !== undefined ? data.unitListPrice : before.unitListPrice
      const finalMember = data.unitMemberPrice !== undefined ? data.unitMemberPrice : before.unitMemberPrice
      const priceErr = validateBundleUnitPrices(finalList, finalMember)
      if (priceErr) return { success: false, message: priceErr }
    }

    const updateData: Record<string, unknown> = {}
    if (data.groupName !== undefined) updateData.groupName = data.groupName.trim()
    if (data.pickCount !== undefined) updateData.pickCount = data.pickCount
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder
    if (data.unitListPrice !== undefined) updateData.unitListPrice = data.unitListPrice
    if (data.unitMemberPrice !== undefined) {
      updateData.unitMemberPrice = data.unitMemberPrice !== null && data.unitMemberPrice !== '' ? data.unitMemberPrice : null
    }

    try {
      await db.transaction(async (tx) => {
        if (Object.keys(updateData).length > 0) {
          await tx.update(mallBundleGroups).set(updateData).where(eq(mallBundleGroups.id, id))
        }
        
        await syncBundleGroupSkuPrices(id, tx)
        await recomputeBundlePrice(before.productId, tx)
      })
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '该商品下已存在同名分组' }
      if (pgErrorCode(err) === '23514') return { success: false, message: '会员价单价不能高于标价单价' }
      throw err
    }

    await logUpdate(session, 'bundle_group.update', 'mall_bundle_group', String(id), before as Record<string, unknown>, data)
    revalidatePath('/mall')
    return { success: true, message: '分组已更新' }
  },
)

export const deleteBundleGroup = withPermission(
  'product:update',
  async (session, id: number): Promise<{ success: boolean; message: string }> => {
    
    const [grp] = await db
      .select({ productId: mallBundleGroups.productId })
      .from(mallBundleGroups)
      .where(eq(mallBundleGroups.id, id))
      .limit(1)
    if (!grp) return { success: false, message: '分组不存在' }
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(mallProductSkus)
      .where(eq(mallProductSkus.bundleGroupId, id))
    if (Number(cnt) > 0) {
      return { success: false, message: '请先移除该分组下的所有规格，再删除分组' }
    }

    await db.transaction(async (tx) => {
      await tx.delete(mallBundleGroups).where(eq(mallBundleGroups.id, id))
      await recomputeBundlePrice(grp.productId, tx)
    })

    await logOperation(session, 'bundle_group.delete', 'mall_bundle_group', String(id), {})
    revalidatePath('/mall')
    return { success: true, message: '分组已删除' }
  },
)

export const updateSkuBundleGroup = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    skuId: string,
    bundleGroupId: number | null,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [before] = await db.select().from(mallProductSkus).where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId))).limit(1)

    const [prod] = await db
      .select({ isBundle: products.isBundle })
      .from(products)
      .where(eq(products.productId, productId))
      .limit(1)
    
    if (prod?.isBundle) {
      if (bundleGroupId == null) return { success: false, message: '套餐商品的规格必须归入分组' }
      const [grp] = await db
        .select({ id: mallBundleGroups.id })
        .from(mallBundleGroups)
        .where(and(eq(mallBundleGroups.id, bundleGroupId), eq(mallBundleGroups.productId, productId)))
        .limit(1)
      if (!grp) return { success: false, message: '分组不存在或不属于该商品' }
    }

    let moved = false
    await db.transaction(async (tx) => {
      const result = await tx
        .update(mallProductSkus)
        .set({ bundleGroupId })
        .where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId)))
      if ((result as any).count === 0) return
      moved = true
      
      if (prod?.isBundle && bundleGroupId != null) {
        await syncBundleGroupSkuPrices(bundleGroupId, tx)
        await recomputeBundlePrice(productId, tx)
      }
    })

    if (!moved) {
      return { success: false, message: '关联记录不存在' }
    }

    await logUpdate(session, 'mall_product_sku.update', 'mall_product_sku', productId, before as Record<string, unknown>, { skuId, bundleGroupId })
    revalidatePath('/mall')
    return { success: true, message: '规格分组已更新' }
  },
)



export const getMallCategories = withPermission(
  'product:list',
  async (_session): Promise<MallCategory[]> => {
    const rows = await db
      .select()
      .from(mallCategories)
      
      .orderBy(asc(mallCategories.sortOrder))

    return rows.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      categoryGroup: c.categoryGroup,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  },
)


export const getMallCategoryGroups = withPermission(
  'product:list',
  async (_session): Promise<MallCategory[]> => {
    const rows = await db
      .select()
      .from(mallCategories)
      .where(sql`${mallCategories.categoryGroup} IS NULL`)
      
      .orderBy(asc(mallCategories.sortOrder))

    return rows.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      categoryGroup: null,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  },
)


export const createMallCategoryGroup = withPermission(
  'product:create',
  async (
    session,
    data: {
      categoryName: string
      sortOrder?: number
    },
  ): Promise<{ success: boolean; message: string }> => {
    if (!data.categoryName.trim()) {
      return { success: false, message: '请输入分组名称' }
    }

    const [existing] = await db
      .select({ categoryId: mallCategories.categoryId })
      .from(mallCategories)
      .where(and(
        sql`${mallCategories.categoryGroup} IS NULL`,
        eq(mallCategories.categoryName, data.categoryName.trim()),
      ))
      .limit(1)
    if (existing) {
      return { success: false, message: `分组「${data.categoryName.trim()}」已存在` }
    }

    const categoryId = `mgrp-${Date.now()}`
    await db.insert(mallCategories).values({
      categoryId,
      categoryName: data.categoryName.trim(),
      categoryGroup: null,
      sortOrder: data.sortOrder ?? 0,
    })

    await logOperation(session, 'mall_category_group.create', 'mall_category', categoryId, { categoryName: data.categoryName.trim() })
    revalidatePath('/mall')
    return { success: true, message: '分组创建成功' }
  },
)


export const updateMallCategoryGroup = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    data: Partial<{
      categoryName: string
      sortOrder: number
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    const [current] = await db
      .select()
      .from(mallCategories)
      .where(eq(mallCategories.categoryId, categoryId))
      .limit(1)
    if (!current) {
      return { success: false, message: '分组不存在' }
    }

    if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) {
      return { success: false, message: '数据已被其他人修改，请刷新后重试' }
    }

    const newName = data.categoryName?.trim()

    if (newName && newName !== current.categoryName) {
      const [dup] = await db
        .select({ categoryId: mallCategories.categoryId })
        .from(mallCategories)
        .where(and(
          sql`${mallCategories.categoryGroup} IS NULL`,
          eq(mallCategories.categoryName, newName),
        ))
        .limit(1)
      if (dup) {
        return { success: false, message: `分组「${newName}」已存在` }
      }
    }

    await db.transaction(async (tx) => {
      const updateData: Record<string, unknown> = {}
      if (newName !== undefined) updateData.categoryName = newName
      if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder

      await tx
        .update(mallCategories)
        .set(updateData)
        .where(eq(mallCategories.categoryId, categoryId))

      if (newName && newName !== current.categoryName) {
        await tx
          .update(mallCategories)
          .set({ categoryGroup: newName })
          .where(eq(mallCategories.categoryGroup, current.categoryName))
      }
    })

    await logUpdate(session, 'mall_category_group.update', 'mall_category', categoryId, current as Record<string, unknown>, data)
    revalidatePath('/mall')
    return { success: true, message: '分组已更新' }
  },
)


export const deleteMallCategoryGroup = withPermission(
  'product:update',
  async (session, categoryId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [current] = await db
      .select({ categoryName: mallCategories.categoryName })
      .from(mallCategories)
      .where(eq(mallCategories.categoryId, categoryId))
      .limit(1)
    if (!current) {
      return { success: false, message: '分组不存在' }
    }

    await db.transaction(async (tx) => {
      
      await tx.delete(mallCategories).where(eq(mallCategories.categoryGroup, current.categoryName))
      
      await tx.delete(mallCategories).where(eq(mallCategories.categoryId, categoryId))
    })

    await logOperation(session, 'mall_category_group.delete', 'mall_category', categoryId, { categoryName: current.categoryName })
    revalidatePath('/mall')
    return { success: true, message: '分组已删除' }
  },
)

export const getProducts = withPermission(
  'product:list',
  async (_session): Promise<Product[]> => {
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
        categoryGroup: mallCategories.categoryGroup,
        skuCount: skuCountSq.count,
      })
      .from(products)
      .leftJoin(mallCategories, eq(products.categoryId, mallCategories.categoryId))
      .leftJoin(skuCountSq, eq(products.productId, skuCountSq.productId))
      .where(isNull(products.deletedAt))
      
      .orderBy(asc(products.sortOrder))
      .limit(500)

    return rows.map((r) => ({
      productId: r.product.productId,
      categoryId: r.product.categoryId,
      name: r.product.name,
      coverImage: r.product.coverImage,
      detailImages: r.product.detailImages,
      description: r.product.description,
      isBundle: r.product.isBundle,
      price: r.product.price,
      specialPrice: r.product.specialPrice,
      manageScope: r.product.manageScope,
      marketScope: r.product.marketScope,
      sortOrder: r.product.sortOrder,
      isVisible: r.product.isVisible,
      createdAt: r.product.createdAt.toISOString(),
      updatedAt: r.product.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
      categoryGroup: r.categoryGroup ?? undefined,
      skuCount: r.skuCount ?? 0,
    }))
  },
)

export const getProductById = withPermission(
  'product:list',
  async (_session, productId: string): Promise<Product | null> => {
    const rows = await db
      .select({
        product: products,
        categoryName: mallCategories.categoryName,
      })
      .from(products)
      .leftJoin(mallCategories, eq(products.categoryId, mallCategories.categoryId))
      .where(and(eq(products.productId, productId), isNull(products.deletedAt)))
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
      price: r.product.price,
      specialPrice: r.product.specialPrice,
      manageScope: r.product.manageScope,
      marketScope: r.product.marketScope,
      sortOrder: r.product.sortOrder,
      isVisible: r.product.isVisible,
      createdAt: r.product.createdAt.toISOString(),
      updatedAt: r.product.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
    }
  },
)

export const createProduct = withPermission(
  'product:create',
  async (
    session,
    data: {
      productId: string
      categoryId: string
      name: string
      coverImage?: string | null
      detailImages?: string[] | null
      description?: string | null
      isBundle?: boolean
      price: string
      specialPrice?: string | null
      manageScope?: string | null
      marketScope?: string | null
      sortOrder?: number
      isVisible?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
    
    const isBundle = data.isBundle === true
    if (!isBundle) {
      const price = Number(data.price)
      if (isNaN(price) || price < 0) {
        return { success: false, message: '价格必须为非负数' }
      }
    }

    
    const [cat] = await db
      .select({ categoryId: mallCategories.categoryId })
      .from(mallCategories)
      .where(eq(mallCategories.categoryId, data.categoryId))
      .limit(1)
    if (!cat) {
      return { success: false, message: '商品分类不存在' }
    }

    const insertValues = isBundle ? { ...data, price: '0', specialPrice: null } : data

    try {
      await db.insert(products).values(insertValues)
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '商品编号已存在' }
      throw err
    }

    await logOperation(session, 'product.create', 'product', data.productId, { name: data.name })
    revalidatePath('/mall')
    return { success: true, message: '商品创建成功' }
  },
)

export const updateProduct = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    data: Partial<{
      categoryId: string
      name: string
      coverImage: string | null
      detailImages: string[] | null
      description: string | null
      isBundle: boolean
      price: string
      specialPrice: string | null
      manageScope: string | null
      marketScope: string | null
      sortOrder: number
      isVisible: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [before] = await db.select().from(products).where(eq(products.productId, productId)).limit(1)

    
    const finalIsBundle = data.isBundle ?? before?.isBundle ?? false
    const setData: Record<string, unknown> = { ...data }
    if (finalIsBundle) {
      delete setData.price
      delete setData.specialPrice
    }
    if (Object.keys(setData).length === 0) {
      return { success: true, message: '商品信息已更新' }
    }

    const whereConditions = expectedUpdatedAt
      ? and(eq(products.productId, productId), isNull(products.deletedAt), sql`date_trunc('milliseconds', ${products.updatedAt}) = ${expectedUpdatedAt}`)
      : and(eq(products.productId, productId), isNull(products.deletedAt))

    const result = await db
      .update(products)
      .set(setData)
      .where(whereConditions)

    if ((result as any).count === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商品不存在或已删除',
      }
    }

    await logUpdate(session, 'product.update', 'product', productId, before as Record<string, unknown>, data)
    revalidatePath('/mall')
    return { success: true, message: '商品信息已更新' }
  },
)


export const deleteProduct = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    const [before] = await db
      .select()
      .from(products)
      .where(and(eq(products.productId, productId), isNull(products.deletedAt)))
      .limit(1)
    if (!before) {
      return { success: false, message: '商品不存在或已删除' }
    }

    const whereConditions = expectedUpdatedAt
      ? and(eq(products.productId, productId), isNull(products.deletedAt), sql`date_trunc('milliseconds', ${products.updatedAt}) = ${expectedUpdatedAt}`)
      : and(eq(products.productId, productId), isNull(products.deletedAt))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await db
      .update(products)
      .set({ deletedAt: nowTs(), deletedBy: session.employeeId })
      .where(whereConditions)

    if (result.count === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商品状态变更，请刷新重试',
      }
    }

    await logOperation(session, 'product.delete', 'product', productId, {
      snapshot: {
        name: before.name,
        categoryId: before.categoryId,
        price: before.price,
        isBundle: before.isBundle,
      },
    })
    revalidatePath('/mall')
    return { success: true, message: '商品已删除' }
  },
)

export const createMallCategory = withPermission(
  'product:create',
  async (
    session,
    data: {
      categoryId: string
      categoryName: string
      categoryGroup?: string | null
      sortOrder?: number
    },
  ): Promise<{ success: boolean; message: string }> => {
    try {
      await db.insert(mallCategories).values(data)
    } catch (err: any) {
      if (pgErrorCode(err) === '23505') return { success: false, message: '分类编号已存在' }
      throw err
    }

    await logOperation(session, 'mall_category.create', 'mall_category', data.categoryId, { categoryName: data.categoryName })
    revalidatePath('/mall')
    return { success: true, message: '商品分类创建成功' }
  },
)

export const updateMallCategory = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    data: Partial<{
      categoryName: string
      sortOrder: number
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    
    const [before] = await db.select().from(mallCategories).where(eq(mallCategories.categoryId, categoryId)).limit(1)

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

    await logUpdate(session, 'mall_category.update', 'mall_category', categoryId, before as Record<string, unknown>, data)
    revalidatePath('/mall')
    return { success: true, message: '商品分类已更新' }
  },
)


export const deleteMallCategory = withPermission(
  'product:update',
  async (session, categoryId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    
    const [ref] = await db
      .select({ productId: products.productId })
      .from(products)
      .where(eq(products.categoryId, categoryId))
      .limit(1)
    if (ref) {
      return { success: false, message: '该分类下还有商品，无法删除' }
    }

    const result = await db.delete(mallCategories).where(eq(mallCategories.categoryId, categoryId))
    if ((result as any).count === 0) {
      return { success: false, message: '分类不存在' }
    }

    await logOperation(session, 'mall_category.delete', 'mall_category', categoryId, {})
    revalidatePath('/mall')
    return { success: true, message: '分类已删除' }
  },
)




export type ProductKindForOrder = string | '__bundle__' | '__normal__'

export interface OrderPickerSku {
  skuId: string
  categoryId: string
  categoryName: string
  productType: '疗程卡' | '家居产品'
  specName: string
  price: string
  specialPrice: string | null
  sessionCount: number | null
  serviceFee: string
  sortOrder: number
  
  isManagerSpecial: boolean
  
  isExperience: boolean
}

export interface OrderPickerCategory {
  categoryId: string
  categoryName: string
  salesCategory: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
  sortOrder: number
  skus: OrderPickerSku[]
}

export interface OrderPickerBundleSkuRef {
  skuId: string
  specName: string
  productType: '疗程卡' | '家居产品'
  
  sessionCount: number | null
  price: string
  bundlePrice: string | null
  bundleGroupId: number | null
  sortOrder: number
}

export interface OrderPickerBundleGroup {
  id: number
  groupName: string
  
  pickCount: number | null
  sortOrder: number
  skus: OrderPickerBundleSkuRef[]
}

export interface OrderPickerBundle {
  productId: string
  name: string
  coverImage: string | null
  price: string
  specialPrice: string | null
  sortOrder: number
  groups: OrderPickerBundleGroup[]
  
  ungroupedSkus: OrderPickerBundleSkuRef[]
}


export interface OrderPickerNormalGroup {
  productKind: string
  categories: OrderPickerCategory[]
}


export type OrderPickerResult =
  | OrderPickerNormalResult
  | OrderPickerBundleResult
  | OrderPickerFlatResult

export interface OrderPickerNormalResult {
  kind: '__normal__'
  groups: OrderPickerNormalGroup[]
}

export interface OrderPickerBundleResult {
  kind: '__bundle__'
  bundles: OrderPickerBundle[]
}

export interface OrderPickerFlatResult {
  kind: string
  categories: OrderPickerCategory[]
}

export const getProductsByKind = withPermission(
  'product:list',
  async (_session, kind: ProductKindForOrder): Promise<OrderPickerResult> => {
  if (kind === '__bundle__') {
    
    const bundleRows = await db
      .select({
        productId: products.productId,
        name: products.name,
        coverImage: products.coverImage,
        price: products.price,
        specialPrice: products.specialPrice,
        sortOrder: products.sortOrder,
      })
      .from(products)
      .where(and(eq(products.isBundle, true), eq(products.isVisible, true), isNull(products.deletedAt)))
      
      .orderBy(asc(products.sortOrder))

    if (bundleRows.length === 0) {
      return { kind: '__bundle__', bundles: [] }
    }

    const productIds = bundleRows.map((b) => b.productId)

    
    const groupRows = await db
      .select()
      .from(mallBundleGroups)
      .where(inArray(mallBundleGroups.productId, productIds))
      
      .orderBy(asc(mallBundleGroups.sortOrder))

    
    const mpsRows = await db
      .select({
        productId: mallProductSkus.productId,
        skuId: mallProductSkus.skuId,
        bundleGroupId: mallProductSkus.bundleGroupId,
        bundlePrice: mallProductSkus.bundlePrice,
        bundleListPrice: mallProductSkus.bundleListPrice,
        sortOrder: mallProductSkus.sortOrder,
        sku: productSkus,
      })
      .from(mallProductSkus)
      .innerJoin(productSkus, eq(mallProductSkus.skuId, productSkus.skuId))
      .where(and(inArray(mallProductSkus.productId, productIds), eq(productSkus.isEnabled, true)))
      
      .orderBy(asc(mallProductSkus.sortOrder))

    const bundles: OrderPickerBundle[] = bundleRows.map((b) => {
      const myGroups = groupRows.filter((g) => g.productId === b.productId)
      const mySkus = mpsRows.filter((m) => m.productId === b.productId)
      const groups: OrderPickerBundleGroup[] = myGroups.map((g) => ({
        id: g.id,
        groupName: g.groupName,
        pickCount: g.pickCount,
        sortOrder: g.sortOrder,
        skus: mySkus
          .filter((m) => m.bundleGroupId === g.id)
          .map((m) => ({
            skuId: m.skuId,
            specName: m.sku.specName,
            productType: m.sku.productType as OrderPickerBundleSkuRef['productType'],
            sessionCount: m.sku.sessionCount,
            price: m.bundleListPrice ?? m.sku.price,
            bundlePrice: m.bundlePrice ?? m.bundleListPrice ?? m.sku.price,
            bundleGroupId: m.bundleGroupId,
            sortOrder: m.sortOrder,
          })),
      }))
      const ungroupedSkus = mySkus
        .filter((m) => m.bundleGroupId === null)
        .map((m) => ({
          skuId: m.skuId,
          specName: m.sku.specName,
          productType: m.sku.productType as OrderPickerBundleSkuRef['productType'],
          sessionCount: m.sku.sessionCount,
          price: m.bundleListPrice ?? m.sku.price,
          bundlePrice: m.bundlePrice ?? m.bundleListPrice ?? m.sku.price,
          bundleGroupId: m.bundleGroupId,
          sortOrder: m.sortOrder,
        }))
      return {
        productId: b.productId,
        name: b.name,
        coverImage: b.coverImage,
        price: b.price,
        specialPrice: b.specialPrice,
        sortOrder: b.sortOrder,
        groups,
        ungroupedSkus,
      }
    })

    return { kind: '__bundle__', bundles }
  }

  if (kind === '__normal__') {
    
    
    
    
    const parentCat = alias(productCategories, 'parent_cat') as unknown as typeof productCategories

    const rows = await db
      .select({
        category: productCategories,
        sku: productSkus,
        parentProductKind: parentCat.categoryName,
        parentSortOrder: parentCat.sortOrder,
      })
      .from(productSkus)
      .innerJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .innerJoin(
        parentCat,
        and(
          isNull(parentCat.productKind),
          eq(parentCat.categoryName, productCategories.productKind),
          eq(parentCat.isValid, true),
        )!,
      )
      .where(
        and(
          isNotNull(productCategories.productKind),
          
          eq(productSkus.isExperience, false),
          eq(productCategories.isValid, true),
          eq(productSkus.isEnabled, true),
          isNull(productSkus.deletedAt),
          
          
        ),
      )
      
      .orderBy(asc(parentCat.sortOrder), asc(productCategories.sortOrder), asc(productSkus.sortOrder))

    
    type GroupAccum = {
      productKind: string
      parentSortOrder: number
      catMap: Map<string, OrderPickerCategory>
    }
    const groupMap = new Map<string, GroupAccum>()
    for (const r of rows) {
      const kindName = r.category.productKind
      if (!kindName) continue 
      if (!groupMap.has(kindName)) {
        groupMap.set(kindName, {
          productKind: kindName,
          parentSortOrder: r.parentSortOrder ?? 0,
          catMap: new Map<string, OrderPickerCategory>(),
        })
      }
      const grp = groupMap.get(kindName)!
      if (!grp.catMap.has(r.category.categoryId)) {
        grp.catMap.set(r.category.categoryId, {
          categoryId: r.category.categoryId,
          categoryName: r.category.categoryName,
          salesCategory: r.category.salesCategory as OrderPickerCategory['salesCategory'],
          sortOrder: r.category.sortOrder,
          skus: [],
        })
      }
      grp.catMap.get(r.category.categoryId)!.skus.push({
        skuId: r.sku.skuId,
        categoryId: r.sku.categoryId,
        categoryName: r.category.categoryName,
        productType: r.sku.productType as OrderPickerSku['productType'],
        specName: r.sku.specName,
        price: r.sku.price,
        specialPrice: r.sku.specialPrice,
        sessionCount: r.sku.sessionCount,
        serviceFee: r.sku.serviceFee,
        sortOrder: r.sku.sortOrder,
        isManagerSpecial: r.sku.isManagerSpecial,
        isExperience: r.sku.isExperience === true,
      })
    }

    const groups: OrderPickerNormalGroup[] = Array.from(groupMap.values())
      .sort((a, b) => a.parentSortOrder - b.parentSortOrder)
      .map((g) => ({
        productKind: g.productKind,
        categories: Array.from(g.catMap.values()).sort((a, b) => a.sortOrder - b.sortOrder),
      }))
      
      .filter((g) => g.categories.length > 0)

    return { kind: '__normal__', groups }
  }

  
  
  
  
  const capabilityCondition =
    kind === '体验卡'
      ? eq(productSkus.isExperience, true)
      : eq(productCategories.productKind, kind)

  const rows = await db
    .select({
      category: productCategories,
      sku: productSkus,
    })
    .from(productSkus)
    .innerJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(and(capabilityCondition, eq(productSkus.isEnabled, true), eq(productCategories.isValid, true), isNull(productSkus.deletedAt)))
    
    .orderBy(asc(productCategories.sortOrder), asc(productSkus.sortOrder))

  
  const catMap = new Map<string, OrderPickerCategory>()
  for (const r of rows) {
    if (!catMap.has(r.category.categoryId)) {
      catMap.set(r.category.categoryId, {
        categoryId: r.category.categoryId,
        categoryName: r.category.categoryName,
        salesCategory: r.category.salesCategory as OrderPickerCategory['salesCategory'],
        sortOrder: r.category.sortOrder,
        skus: [],
      })
    }
    catMap.get(r.category.categoryId)!.skus.push({
      skuId: r.sku.skuId,
      categoryId: r.sku.categoryId,
      categoryName: r.category.categoryName,
      productType: r.sku.productType as OrderPickerSku['productType'],
      specName: r.sku.specName,
      price: r.sku.price,
      specialPrice: r.sku.specialPrice,
      sessionCount: r.sku.sessionCount,
      serviceFee: r.sku.serviceFee,
      sortOrder: r.sku.sortOrder,
      isManagerSpecial: r.sku.isManagerSpecial,
      isExperience: r.sku.isExperience === true,
    })
  }
  const categories = Array.from(catMap.values()).sort((a, b) => a.sortOrder - b.sortOrder)
  return { kind, categories }
  },
)
