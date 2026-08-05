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

/**
 * 获取所有市场节点（type='市场'），用于商品可见范围选择。
 * 按当前账号 scope 过滤：总部全开；市场/门店级仅返回所在市场。
 */
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(orgNodes.sortOrder))

    return rows
  },
)

/**
 * 根据当前用户 session 自动判断管理范围。
 */
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

// ===== 项目系列字典 =====

/**
 * 获取所有启用的项目系列（SKU 的"项目系列"下拉选项来源）。
 */
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(projectSeriesLookup.sortOrder), asc(projectSeriesLookup.id))
    return rows
  },
)

// ===== 品项分类（商品管理） =====

export const getCategories = withPermission(
  'product:list',
  async (_session): Promise<ProductCategory[]> => {
    // LEFT JOIN 父级一级行（productKind IS NULL AND categoryName = child.productKind），
    // 把父级 capability 列回填到二级行；一级行 parent.* 列均为 NULL（自身字段已带）。
    // drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(productCategories.sortOrder))

    // drizzle 0.45 alias 后 select 类型推断退化成 never[]；用 any 解锁 build
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

/**
 * 获取所有一级分类（品项一级分类），即 product_kind IS NULL 的行。
 * 返回 capability 列（displayColor），供前端 tag 颜色渲染使用。
 */
export const getProductKinds = withPermission(
  'product:list',
  async (_session): Promise<ProductCategory[]> => {
    const rows = await db
      .select()
      .from(productCategories)
      .where(sql`${productCategories.productKind} IS NULL`)
      // 例外：sortOrder 手工排序权重
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

/**
 * 创建一级分类（品项一级分类）
 */
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

/**
 * 更新一级分类（品项一级分类）
 * 若 categoryName 变更，事务内同步更新所有子级的 product_kind 值。
 */
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
    // 查当前行（获取旧名称用于级联更新）
    const [current] = await db
      .select()
      .from(productCategories)
      .where(eq(productCategories.categoryId, categoryId))
      .limit(1)
    if (!current) {
      return { success: false, message: '品项一级分类不存在' }
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
        return { success: false, message: `品项一级分类「${newName}」已存在` }
      }
    }

    // 事务：更新自身 + 级联更新子级 product_kind
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

      // 若改名，级联更新所有子级的 product_kind
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
    // 业务校验：productKind 必须存在于"一级行"集合（productKind IS NULL 的有效行）
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

/**
 * 硬删除品项分类（决策 D11=A：未引用允许硬删，否则提示停用）。
 *
 * 校验顺序：
 *   1. SKU 引用（product_skus.category_id 含软删）→ 拒绝
 *   2. 优惠券引用（coupon_templates.applicable_category_ids @> categoryId）→ 拒绝
 *   3. CAS 守卫：UPDATED_AT 匹配才允许 DELETE
 *
 * 复用 product:update 权限（与 deleteSku / deleteMallCategory / deleteProduct 一致）。
 */
export const deleteCategory = withPermission(
  'product:update',
  async (
    session,
    categoryId: string,
    expectedUpdatedAt: string,
  ): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    // 1. 校验：无 SKU 引用（含软删的 SKU 也算引用，避免误删历史）
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

    // 2. 校验：无 coupon_templates.applicable_category_ids 引用
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

    // 3. 真删（CAS 守卫）
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
    // 业务校验：若传了 productKind，必须存在于"一级行"集合
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

    // 获取旧值用于日志 diff
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

// ===== SKU（商品管理，独立实体） =====

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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(productSkus.sortOrder))

    return rows.map((r) => ({
      skuId: r.sku.skuId,
      categoryId: r.sku.categoryId,
      productType: r.sku.productType as ProductSku['productType'],
      specName: r.sku.specName,
      price: r.sku.price,
      specialPrice: r.sku.specialPrice,
      sessionCount: r.sku.sessionCount,
      purchaseLimit: r.sku.purchaseLimit,
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

/** 根据 skuId 获取单个 SKU 详情 */
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
      purchaseLimit: r.sku.purchaseLimit,
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

/** 获取商城商品关联的 SKU 列表（通过 mall_product_skus） */
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(mallProductSkus.sortOrder))

    return rows.map((r) => ({
      skuId: r.sku.skuId,
      categoryId: r.sku.categoryId,
      productType: r.sku.productType as ProductSku['productType'],
      specName: r.sku.specName,
      price: r.sku.price,
      specialPrice: r.sku.specialPrice,
      sessionCount: r.sku.sessionCount,
      purchaseLimit: r.sku.purchaseLimit,
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

function validatePurchaseLimit(purchaseLimit: number | null | undefined): string | null {
  if (purchaseLimit == null) return null
  if (!Number.isInteger(purchaseLimit) || purchaseLimit < 1) {
    return '限购次数必须为正整数'
  }
  return null
}

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
      purchaseLimit?: number | null
      sortOrder?: number
      serviceFee?: string
      isShengmei?: boolean | null
      /** 体验卡 capability 列 */
      isExperience?: boolean
      /** 店长特别优惠 capability 列（开单可改应付金额） */
      isManagerSpecial?: boolean
      /** 项目系列 lookup id（FK → project_series_lookup.id），null=未设置 */
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
    const purchaseLimitError = validatePurchaseLimit(data.purchaseLimit)
    if (purchaseLimitError) return { success: false, message: purchaseLimitError }

    // 充值卡剥离 SKU 化（2026-05-20）后，capability 互斥校验仅剩 isExperience 单值，
    // 无需互斥防护；chk_sku_not_both_capabilities CHECK 同 migration 0043 已 DROP。

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
      purchaseLimit: number | null
      sortOrder: number
      serviceFee: string
      isShengmei: boolean | null
      /** 体验卡 capability 列 */
      isExperience: boolean
      /** 店长特别优惠 capability 列（开单可改应付金额） */
      isManagerSpecial: boolean
      /** 项目系列 lookup id（FK → project_series_lookup.id），null=未设置 */
      projectSeriesId: number | null
      marketScope: string | null
      isEnabled: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff（不取已软删 SKU）
    const [before] = await db.select().from(productSkus).where(and(eq(productSkus.skuId, skuId), isNull(productSkus.deletedAt))).limit(1)

    // 疗程卡次数校验（与 createSku 对齐）：最终 productType=疗程卡 时 sessionCount 必须 >= 1
    if (before && (data.productType ?? before.productType) === '疗程卡') {
      const finalSessionCount = data.sessionCount !== undefined ? data.sessionCount : before.sessionCount
      if (!finalSessionCount || finalSessionCount < 1) {
        return { success: false, message: '疗程卡的次数必须 >= 1' }
      }
    }
    const purchaseLimitError = validatePurchaseLimit(data.purchaseLimit)
    if (purchaseLimitError) return { success: false, message: purchaseLimitError }

    // 充值卡剥离 SKU 化（2026-05-20）后，capability 互斥校验已失去对象，应用层守卫删除。

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

    // isEnabled 切换会改变套餐「计入数量」（启用 SKU 计价），但本函数不经 recomputeBundlePrice
    // —— 唯一缺口，故在此显式重算所有含该 SKU 的套餐展示价，避免禁用后划线/会员价与可选项脱节。
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

    // 取 SKU 快照用于审计（含规格名/价格/类别）
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

    // 关联表 mall_product_skus 物理删（无 PII，纯关联数据）
    await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))

    // product_skus 软删
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

// ===== 套餐定价：组级单价下沉 + 套餐价重算（内部 helper，事务内调用） =====

type ProductTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 把分组级单价下沉到组内所有子项副本（子项价格的唯一写入点）：
 * - bundle_list_price = 组 unit_list_price（标价单价 → sale_items.unit_price 划线）
 * - bundle_price      = coalesce(组 unit_member_price, unit_list_price)（成交价 → sale_items.unit_real_price）
 */
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

/**
 * 重算套餐展示价（权威只读组级单价，绝不读子项副本）：
 * - price         = Σ 各组 unit_list_price × 计入数量
 * - special_price = Σ 各组 coalesce(unit_member_price, unit_list_price) × 计入数量；仅当 < price 时落值，否则 null
 * 计入数量 = pickCount（N选M）或 组内 SKU 数（全选组 pickCount=null）。组内同价，故套餐价与具体如何选无关。
 */
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

  // 计入数量只数「启用」SKU——与开单选择器 getProductsByKind（innerJoin productSkus + isEnabled=true）口径一致，
  // 否则禁用 SKU 仍被计价 → 套餐划线/会员价虚高于实际可选项。
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

// ===== 商城商品-SKU 关联 =====

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
    // 套餐：所有子商品必须归入分组，且分组须属于该商品
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
        // 套餐：新子项继承组单价（下沉副本）+ 重算套餐价（全选组计入数量 +1）
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
      // 套餐：移除子项后重算套餐价（全选组计入数量 -1）
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

// updateSkuBundlePrice 已废弃（2026-06）：套餐子项价格不再逐个改价，统一由分组级
// unit_list_price / unit_member_price 经 syncBundleGroupSkuPrices 下沉到组内所有子项副本。

// ===== 套餐分组管理（mall_bundle_groups） =====

export const getBundleGroupsByProductId = withPermission(
  'product:list',
  async (_session, productId: string): Promise<MallBundleGroup[]> => {
    const rows = await db
      .select()
      .from(mallBundleGroups)
      .where(eq(mallBundleGroups.productId, productId))
      // 例外：sortOrder 手工排序权重
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

/** 校验组单价：标价必填且 ≥0；会员价可空、≥0 且 ≤ 标价。返回错误消息或 null。 */
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
        // 新组建立后重算（按 pickCount 计入；空全选组贡献 0）
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

    // 获取旧值（含 productId + 现有单价，用于校验与重算）
    const [before] = await db.select().from(mallBundleGroups).where(eq(mallBundleGroups.id, id)).limit(1)
    if (!before) return { success: false, message: '分组不存在' }

    // 单价校验：用「最终值」（入参优先，否则沿用旧值）
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
        // 改单价 → 下沉到组内所有子项副本；改 pickCount/单价 → 重算套餐价（sync 幂等，统一调）
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
    // 取分组归属商品；组非空则拒绝删除（避免子项游离、套餐价错算）
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
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(mallProductSkus).where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId))).limit(1)

    const [prod] = await db
      .select({ isBundle: products.isBundle })
      .from(products)
      .where(eq(products.productId, productId))
      .limit(1)
    // 套餐：子项必须归入分组，且目标分组须属于该商品
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
      // 套餐：移入新组继承其单价 + 重算（两个全选组的计入数量都可能变化）
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

// ===== 商城管理（mall_categories + products + mall_product_skus） =====

export const getMallCategories = withPermission(
  'product:list',
  async (_session): Promise<MallCategory[]> => {
    const rows = await db
      .select()
      .from(mallCategories)
      // 例外：sortOrder 手工排序权重
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

/** 获取商城一级分组（category_group IS NULL 的行） */
export const getMallCategoryGroups = withPermission(
  'product:list',
  async (_session): Promise<MallCategory[]> => {
    const rows = await db
      .select()
      .from(mallCategories)
      .where(sql`${mallCategories.categoryGroup} IS NULL`)
      // 例外：sortOrder 手工排序权重
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

/** 创建商城一级分组 */
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

/** 更新商城一级分组，改名时级联更新子级 category_group */
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

/** 删除商城一级分组（级联删除子级分类） */
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
      // 先删子级分类
      await tx.delete(mallCategories).where(eq(mallCategories.categoryGroup, current.categoryName))
      // 再删一级分组
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
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(products.sortOrder))

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
    // 套餐：展示价由各组单价自动算（创建时尚无分组），强制 0；非套餐校验手填价
    const isBundle = data.isBundle === true
    if (!isBundle) {
      const price = Number(data.price)
      if (isNaN(price) || price < 0) {
        return { success: false, message: '价格必须为非负数' }
      }
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
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(products).where(eq(products.productId, productId)).limit(1)

    // 套餐：展示价由各组单价自动算，剔除表单手填的 price/specialPrice，避免覆盖重算结果
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

/** 软删除商品（设置 deleted_at 和 deleted_by）。复用 product:update 权限。 */
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
    // 获取旧值用于日志 diff
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

/** 删除商城二级分类（硬删除） */
export const deleteMallCategory = withPermission(
  'product:update',
  async (session, categoryId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    // 检查是否有商品引用
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

// ===== 开单页：按商品类型驱动的选品数据源 =====

/**
 * 开单页 Step 2 数据源：按 kind 返回可加购的 SKU/套餐。
 *
具名 kind：平铺 categories + skus，过滤 isEnabled。
 *   - '体验卡' → WHERE product_skus.is_experience=true（SKU 级 capability SSoT）
 *   - 其他字面量 kind → WHERE product_categories.product_kind=$kind（向后兼容）
 *   类型签名用 string 表达（productKindEnum 已删除，运营可自由新建 kind）。
 *   2026-05-20：'充值卡' 已退出 SKU/商品域，admin 走独立充值单入口（card 模块）。
 *
 * 特殊 '__bundle__'：
 *   返回 `products WHERE is_bundle=true AND deleted_at IS NULL` 的套餐（开单页无视 is_visible），
 *   展开关联的 mall_bundle_groups + mall_product_skus（N 选 M 所需数据）。
 *
 * 特殊 '__normal__'（普通商品 = 非体验卡 SKU 的所有二级分类）：
 *   JOIN 一级行（productKind IS NULL）+ 二级行（productKind IS NOT NULL），
 *   过滤 SKU 的 isExperience=false，并 EXISTS 排除 bundle SKU。
 *   返回分组结构 `{ kind: '__normal__', groups: [{ productKind, categories }] }`，
 *   group 顺序按一级行 sortOrder，组内按二级行 sortOrder。
 *
 * 无权限：product:list。
 */
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
  purchaseLimit: number | null
  serviceFee: string
  sortOrder: number
  /** 店长特别优惠：true 时开单（销售单 + 普通商品）允许店长改应付金额 */
  isManagerSpecial: boolean
  /** 体验卡 capability：#6=B 起同口径走会员价分流（仅会员享 special_price，非会员标价），不再豁免 */
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
  /** 疗程卡次数（非疗程卡为 null），开单时需快照到 sale_items.session_count */
  sessionCount: number | null
  purchaseLimit: number | null
  price: string
  bundlePrice: string | null
  bundleGroupId: number | null
  sortOrder: number
}

export interface OrderPickerBundleGroup {
  id: number
  groupName: string
  /** N 选 M 的 M（null = 全选） */
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
  /** 未分组的 SKU（bundle_group_id IS NULL） */
  ungroupedSkus: OrderPickerBundleSkuRef[]
}

/**
 * "普通商品"模式下按 productKind 分组的二级分类集合。
 * group 顺序由一级行 sortOrder 决定；组内 categories 按二级行 sortOrder。
 */
export interface OrderPickerNormalGroup {
  productKind: string
  categories: OrderPickerCategory[]
}

/**
 * discriminated union：
 * - '__normal__' → groups（分组）
 * - '__bundle__' → bundles
 * - 其余具名 kind（如 '体验卡' / '充值卡'）→ categories（平铺）
 *   使用 `Exclude<string, '__normal__' | '__bundle__'>` 语义由 TS 通过
 *   类型守卫自动识别——平铺分支声明为 string，narrowing 靠运行时 if-else 顺序。
 */
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
    // 套餐商品：products WHERE is_bundle AND deleted_at IS NULL（开单页无视 is_visible，与普通商品/体验卡口径一致）
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
      .where(and(eq(products.isBundle, true), isNull(products.deletedAt)))
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(products.sortOrder))

    if (bundleRows.length === 0) {
      return { kind: '__bundle__', bundles: [] }
    }

    const productIds = bundleRows.map((b) => b.productId)

    // 关联分组
    const groupRows = await db
      .select()
      .from(mallBundleGroups)
      .where(inArray(mallBundleGroups.productId, productIds))
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(mallBundleGroups.sortOrder))

    // 关联 SKU（含 bundleGroupId / bundlePrice）
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
      // 例外：sortOrder 手工排序权重
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
            purchaseLimit: m.sku.purchaseLimit,
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
          purchaseLimit: m.sku.purchaseLimit,
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
    // 普通商品：排除卡类 + 必须有非 bundle 有效 SKU 的二级分类
    // JOIN 一级行（parent.productKind IS NULL AND parent.categoryName = child.productKind）
    // 以便按一级行 sortOrder 排序 group。
    // drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
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
          // 普通商品 = 非体验卡 SKU（充值卡 2026-05-20 已退出 SKU 域）
          eq(productSkus.isExperience, false),
          eq(productCategories.isValid, true),
          eq(productSkus.isEnabled, true),
          isNull(productSkus.deletedAt),
          // 普通商品列表不再因「SKU 进过套餐」而隐藏：一个 SKU 既可单卖也可进套餐，
          // 套餐通过独立的 __bundle__ picker 选购，互不影响（2026-05-26 决策：彻底取消套餐排除）。
        ),
      )
      // 例外：sortOrder 手工排序权重
      .orderBy(asc(parentCat.sortOrder), asc(productCategories.sortOrder), asc(productSkus.sortOrder))

    // 按 productKind → categoryId 两层聚合
    type GroupAccum = {
      productKind: string
      parentSortOrder: number
      catMap: Map<string, OrderPickerCategory>
    }
    const groupMap = new Map<string, GroupAccum>()
    for (const r of rows) {
      const kindName = r.category.productKind
      if (!kindName) continue // defensive：已被 SQL isNotNull 过滤
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
        purchaseLimit: r.sku.purchaseLimit,
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
      // 防御：某 productKind 下没有任何 category → 整组丢弃（ticket §6.3）
      .filter((g) => g.categories.length > 0)

    return { kind: '__normal__', groups }
  }

  // 具名 kind：平铺 categories
  // - '体验卡' 用 SKU 级 capability 列判定（与 product_kind 字面量解耦）
  // - 其他具名 kind 保留 product_kind 字面量匹配（向后兼容）
  // - '充值卡' 已退出 SKU/商品域（2026-05-20），由独立 card 入口处理
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
    // 例外：sortOrder 手工排序权重
    .orderBy(asc(productCategories.sortOrder), asc(productSkus.sortOrder))

  // 按 categoryId 聚合
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
      purchaseLimit: r.sku.purchaseLimit,
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
