'use server'

import { db } from '@/db'
import { productCategories, products, productSkus, mallCategories, mallBundleGroups, mallProductSkus } from '@db/product'
import { orgNodes } from '@db/org'
import { alias } from 'drizzle-orm/pg-core'
import { eq, and, asc, sql, inArray, isNotNull, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import crypto from 'crypto'
import type { ProductCategory, Product, ProductSku, MallCategory, MallBundleGroup } from '@/lib/types'
import { withPermission } from '@/lib/with-permission'
import { logOperation, logUpdate } from '@/lib/operation-log'

/**
 * 获取所有市场节点（type='市场'），用于商品可见范围选择。
 */
export const getMarkets = withPermission(
  'product:list',
  async (_session): Promise<{ id: string; name: string }[]> => {
    const rows = await db
      .select({ id: orgNodes.id, name: orgNodes.name })
      .from(orgNodes)
      .where(and(eq(orgNodes.type, '市场'), eq(orgNodes.isActive, true)))
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

// ===== 品项分类（商品管理） =====

export const getCategories = withPermission(
  'product:list',
  async (_session): Promise<ProductCategory[]> => {
    // LEFT JOIN 父级一级行（productKind IS NULL AND categoryName = child.productKind），
    // 把父级 capability 列回填到二级行；一级行 parent.* 列均为 NULL（自身字段已带）。
    const parent = alias(productCategories, 'parent_cat')
    const rows = await db
      .select({
        child: productCategories,
        parentDisplayColor: parent.displayColor,
        parentDisplayIcon: parent.displayIcon,
        parentIsCardKind: parent.isCardKind,
        parentRequiresShengmeiFlag: parent.requiresShengmeiFlag,
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

    return rows.map((r) => ({
      categoryId: r.child.categoryId,
      categoryName: r.child.categoryName,
      productKind: r.child.productKind ?? null,
      salesCategory: r.child.salesCategory as ProductCategory['salesCategory'],
      sortOrder: r.child.sortOrder,
      isValid: r.child.isValid,
      isCardKind: r.child.isCardKind,
      displayColor: r.child.displayColor,
      displayIcon: r.child.displayIcon,
      requiresShengmeiFlag: r.child.requiresShengmeiFlag,
      parentDisplayColor: r.parentDisplayColor,
      parentDisplayIcon: r.parentDisplayIcon,
      parentIsCardKind: r.parentIsCardKind ?? undefined,
      parentRequiresShengmeiFlag: r.parentRequiresShengmeiFlag ?? undefined,
      createdAt: r.child.createdAt.toISOString(),
      updatedAt: r.child.updatedAt.toISOString(),
    }))
  },
)

/**
 * 获取所有一级分类（品项类型），即 product_kind IS NULL 的行。
 * 返回 capability 列（isCardKind/displayColor/displayIcon/requiresShengmeiFlag），
 * 供前端"普通商品 vs 卡类"判断、tag 颜色渲染、表单显隐使用。
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
      isCardKind: c.isCardKind,
      displayColor: c.displayColor,
      displayIcon: c.displayIcon,
      requiresShengmeiFlag: c.requiresShengmeiFlag,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }))
  },
)

/**
 * 卡类一级 kind 名单的运行时 SSoT。从 DB 查 `is_card_kind=true AND isValid=true`。
 * 替代 lib/product-kind.ts 的常量，admin 内新代码请优先使用本函数。
 */
export const getCardKindNamesFromDb = withPermission(
  'product:list',
  async (): Promise<string[]> => {
    const rows = await db
      .select({ name: productCategories.categoryName })
      .from(productCategories)
      .where(and(
        isNull(productCategories.productKind),
        eq(productCategories.isCardKind, true),
        eq(productCategories.isValid, true),
      ))
    return rows.map((r) => r.name)
  },
)

/**
 * 创建一级分类（品项类型）
 */
export const createProductKind = withPermission(
  'product:create',
  async (
    session,
    data: {
      categoryName: string
      sortOrder?: number
      isValid?: boolean
      isCardKind?: boolean
      displayColor?: string | null
      displayIcon?: string | null
      requiresShengmeiFlag?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
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
      isCardKind: data.isCardKind ?? false,
      displayColor: data.displayColor ?? null,
      displayIcon: data.displayIcon ?? null,
      requiresShengmeiFlag: data.requiresShengmeiFlag ?? false,
    })

    await logOperation(session, 'product_kind.create', 'product_category', categoryId, {
      categoryName: data.categoryName.trim(),
      isCardKind: data.isCardKind ?? false,
      displayColor: data.displayColor ?? null,
    })
    revalidatePath('/products')
    return { success: true, message: '品项类型创建成功' }
  },
)

/**
 * 更新一级分类（品项类型）
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
      isCardKind: boolean
      displayColor: string | null
      displayIcon: string | null
      requiresShengmeiFlag: boolean
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
      if (data.isCardKind !== undefined) updateData.isCardKind = data.isCardKind
      if (data.displayColor !== undefined) updateData.displayColor = data.displayColor
      if (data.displayIcon !== undefined) updateData.displayIcon = data.displayIcon
      if (data.requiresShengmeiFlag !== undefined) updateData.requiresShengmeiFlag = data.requiresShengmeiFlag

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
    return { success: true, message: '品项类型已更新' }
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
      return { success: false, message: 'INVALID_PARAMS: 一级品项类型不存在或已停用' }
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
      if (err?.code === '23505') return { success: false, message: '分类编号已存在' }
      throw err
    }

    await logOperation(session, 'category.create', 'product_category', categoryId, { categoryName: data.categoryName })
    revalidatePath('/products')
    return { success: true, message: '分类创建成功' }
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
        return { success: false, message: 'INVALID_PARAMS: 一级品项类型不存在或已停用' }
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
      })
      .from(productSkus)
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      // 例外：sortOrder 手工排序权重
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
      isRechargeCard: r.sku.isRechargeCard,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
      productKind: r.productKind ?? undefined,
      salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
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
      isExperience: r.sku.isExperience,
      isRechargeCard: r.sku.isRechargeCard,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
      categoryName: r.categoryName ?? undefined,
      productKind: r.productKind ?? undefined,
      salesCategory: (r.salesCategory as ProductSku['salesCategory']) ?? undefined,
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
      sortOrder: r.sku.sortOrder,
      serviceFee: r.sku.serviceFee,
      isShengmei: r.sku.isShengmei,
      isExperience: r.sku.isExperience,
      isRechargeCard: r.sku.isRechargeCard,
      marketScope: r.sku.marketScope,
      isEnabled: r.sku.isEnabled,
      bundlePrice: r.bundlePrice,
      bundleGroupId: r.bundleGroupId,
      groupName: r.groupName,
      createdAt: r.sku.createdAt.toISOString(),
      updatedAt: r.sku.updatedAt.toISOString(),
    }))
  },
)

const VALID_PRODUCT_TYPES = ['疗程卡', '单品', '家居产品'] as const

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
      /** 体验卡 capability 列（与 isRechargeCard 互斥） */
      isExperience?: boolean
      /** 充值卡 capability 列（与 isExperience 互斥） */
      isRechargeCard?: boolean
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

    // 2026-04-26 ticket：体验卡与充值卡 capability 列互斥（DB CHECK 双重保护）
    if (data.isExperience === true && data.isRechargeCard === true) {
      return {
        success: false,
        message: 'INVALID_PARAMS: 体验卡与充值卡互斥，不能同时勾选',
      }
    }

    try {
      await db.insert(productSkus).values({
        ...data,
        productType: data.productType as typeof productSkus.$inferInsert['productType'],
      })
    } catch (err: any) {
      if (err?.code === '23505') return { success: false, message: '商品编号已存在' }
      if (err?.code === '23503') return { success: false, message: '品项分类不存在，请检查 categoryId' }
      // chk_sku_not_both_capabilities CHECK 违反（理论上应用层已先拦截，DB 兜底）
      if (err?.code === '23514' && /not_both_capabilities/i.test(err?.constraint || err?.message || '')) {
        return {
          success: false,
          message: 'INVALID_PARAMS: 体验卡与充值卡互斥，不能同时勾选',
        }
      }
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
      /** 体验卡 capability 列（与 isRechargeCard 互斥） */
      isExperience: boolean
      /** 充值卡 capability 列（与 isExperience 互斥） */
      isRechargeCard: boolean
      marketScope: string | null
      isEnabled: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(productSkus).where(eq(productSkus.skuId, skuId)).limit(1)

    // 2026-04-26 ticket：体验卡与充值卡 capability 互斥应用层校验
    // 需要拼接 before 的当前值再判（增量 update 可能只传一个字段）
    if (before) {
      const finalIsExp = data.isExperience !== undefined ? data.isExperience : before.isExperience
      const finalIsRc = data.isRechargeCard !== undefined ? data.isRechargeCard : before.isRechargeCard
      if (finalIsExp === true && finalIsRc === true) {
        return {
          success: false,
          message: 'INVALID_PARAMS: 体验卡与充值卡互斥，不能同时勾选',
        }
      }
    }

    const whereConditions = expectedUpdatedAt
      ? and(eq(productSkus.skuId, skuId), sql`date_trunc('milliseconds', ${productSkus.updatedAt}) = ${expectedUpdatedAt}`)
      : eq(productSkus.skuId, skuId)

    let result: any
    try {
      result = await db
        .update(productSkus)
        .set({
          ...data,
          productType: data.productType as typeof productSkus.$inferInsert['productType'],
        })
        .where(whereConditions)
    } catch (err: any) {
      if (err?.code === '23514' && /not_both_capabilities/i.test(err?.constraint || err?.message || '')) {
        return {
          success: false,
          message: 'INVALID_PARAMS: 体验卡与充值卡互斥，不能同时勾选',
        }
      }
      throw err
    }

    if ((result as any).count === 0) {
      return {
        success: false,
        message: expectedUpdatedAt ? '数据已被其他人修改，请刷新后重试' : '商品不存在',
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

    // 先删关联
    await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))
    await db.delete(productSkus).where(eq(productSkus.skuId, skuId))

    await logOperation(session, 'sku.delete', 'product_sku', skuId)
    revalidatePath('/products')
    return { success: true, message: '商品已删除' }
  },
)

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
    try {
      await db.insert(mallProductSkus).values({
        productId,
        skuId,
        sortOrder: sortOrder ?? 0,
        bundleGroupId: bundleGroupId ?? null,
      })
    } catch (err: any) {
      if (err?.code === '23505') return { success: false, message: '该规格已关联到此商品' }
      if (err?.code === '23503') return { success: false, message: '商品或规格不存在' }
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
    const result = await db
      .delete(mallProductSkus)
      .where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId)))

    if ((result as any).count === 0) {
      return { success: false, message: '关联记录不存在' }
    }

    await logOperation(session, 'mall_product_sku.delete', 'mall_product_sku', productId, { skuId })
    revalidatePath('/mall')
    return { success: true, message: '规格已移除' }
  },
)

export const updateSkuBundlePrice = withPermission(
  'product:update',
  async (
    session,
    productId: string,
    skuId: string,
    bundlePrice: string | null,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(mallProductSkus).where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId))).limit(1)

    const result = await db
      .update(mallProductSkus)
      .set({ bundlePrice })
      .where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId)))

    if ((result as any).count === 0) {
      return { success: false, message: '关联记录不存在' }
    }

    await logUpdate(session, 'mall_product_sku.update', 'mall_product_sku', productId, before as Record<string, unknown>, { skuId, bundlePrice })
    revalidatePath('/mall')
    return { success: true, message: '套餐价已更新' }
  },
)

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
      sortOrder: r.sortOrder,
      createdAt: r.createdAt.toISOString(),
    }))
  },
)

export const createBundleGroup = withPermission(
  'product:update',
  async (
    session,
    data: {
      productId: string
      groupName: string
      pickCount?: number | null
      sortOrder?: number
    },
  ): Promise<{ success: boolean; message: string; id?: number }> => {
    if (!data.groupName.trim()) {
      return { success: false, message: '分组名称不能为空' }
    }
    if (data.pickCount !== undefined && data.pickCount !== null && data.pickCount < 1) {
      return { success: false, message: '可选数量必须大于 0' }
    }

    try {
      const [row] = await db.insert(mallBundleGroups).values({
        productId: data.productId,
        groupName: data.groupName.trim(),
        pickCount: data.pickCount ?? null,
        sortOrder: data.sortOrder ?? 0,
      }).returning({ id: mallBundleGroups.id })

      await logOperation(session, 'bundle_group.create', 'mall_bundle_group', String(row.id), { productId: data.productId, groupName: data.groupName })
      revalidatePath('/mall')
      return { success: true, message: '分组已创建', id: row.id }
    } catch (err: any) {
      if (err?.code === '23505') return { success: false, message: '该商品下已存在同名分组' }
      if (err?.code === '23503') return { success: false, message: '商品不存在' }
      throw err
    }
  },
)

export const updateBundleGroup = withPermission(
  'product:update',
  async (
    session,
    id: number,
    data: Partial<{ groupName: string; pickCount: number | null; sortOrder: number }>,
  ): Promise<{ success: boolean; message: string }> => {
    if (data.groupName !== undefined && !data.groupName.trim()) {
      return { success: false, message: '分组名称不能为空' }
    }
    if (data.pickCount !== undefined && data.pickCount !== null && data.pickCount < 1) {
      return { success: false, message: '可选数量必须大于 0' }
    }

    // 获取旧值用于日志 diff
    const [before] = await db.select().from(mallBundleGroups).where(eq(mallBundleGroups.id, id)).limit(1)

    const updateData: Record<string, unknown> = {}
    if (data.groupName !== undefined) updateData.groupName = data.groupName.trim()
    if (data.pickCount !== undefined) updateData.pickCount = data.pickCount
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder

    try {
      const result = await db.update(mallBundleGroups).set(updateData).where(eq(mallBundleGroups.id, id))
      if ((result as any).count === 0) {
        return { success: false, message: '分组不存在' }
      }
    } catch (err: any) {
      if (err?.code === '23505') return { success: false, message: '该商品下已存在同名分组' }
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
    // 先将该分组下的 SKU 关联清除（设 bundleGroupId = null）
    await db.update(mallProductSkus).set({ bundleGroupId: null }).where(eq(mallProductSkus.bundleGroupId, id))

    const result = await db.delete(mallBundleGroups).where(eq(mallBundleGroups.id, id))
    if ((result as any).count === 0) {
      return { success: false, message: '分组不存在' }
    }

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

    const result = await db
      .update(mallProductSkus)
      .set({ bundleGroupId })
      .where(and(eq(mallProductSkus.productId, productId), eq(mallProductSkus.skuId, skuId)))

    if ((result as any).count === 0) {
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
      // 例外：sortOrder 手工排序权重
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
      isEnabled: r.product.isEnabled,
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
      price: r.product.price,
      specialPrice: r.product.specialPrice,
      manageScope: r.product.manageScope,
      marketScope: r.product.marketScope,
      sortOrder: r.product.sortOrder,
      isEnabled: r.product.isEnabled,
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
      isEnabled?: boolean
      isVisible?: boolean
    },
  ): Promise<{ success: boolean; message: string }> => {
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

    try {
      await db.insert(products).values(data)
    } catch (err: any) {
      if (err?.code === '23505') return { success: false, message: '商品编号已存在' }
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
      isEnabled: boolean
      isVisible: boolean
    }>,
    expectedUpdatedAt?: string,
  ): Promise<{ success: boolean; message: string }> => {
    // 获取旧值用于日志 diff
    const [before] = await db.select().from(products).where(eq(products.productId, productId)).limit(1)

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

    await logUpdate(session, 'product.update', 'product', productId, before as Record<string, unknown>, data)
    revalidatePath('/mall')
    return { success: true, message: '商品信息已更新' }
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
      if (err?.code === '23505') return { success: false, message: '分类编号已存在' }
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
 * 具名 kind（二级分类的 product_kind 值，例如 '体验卡' / '充值卡'）：
 *   返回 `product_skus JOIN product_categories WHERE pc.product_kind=$kind`
 *   的 categories（分类分组）+ skus 列表，过滤 isEnabled + 排除 bundle SKU。
 *   类型签名上用 string 表达（productKindEnum 已删除，运营可自由新建 kind）。
 *
 * 特殊 '__bundle__'：
 *   返回 `products WHERE is_bundle=true AND is_enabled AND is_visible` 的套餐，
 *   展开关联的 mall_bundle_groups + mall_product_skus（N 选 M 所需数据）。
 *
 * 特殊 '__normal__'（普通商品 = 非卡类的所有二级分类）：
 *   JOIN 一级行（productKind IS NULL）+ 二级行（productKind IS NOT NULL
 *   AND parent.is_card_kind = false），并 EXISTS 过滤非 bundle 有效 SKU。
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
  productType: '疗程卡' | '单品' | '家居产品'
  specName: string
  price: string
  specialPrice: string | null
  sessionCount: number | null
  serviceFee: string
  sortOrder: number
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
  productType: '疗程卡' | '单品' | '家居产品'
  /** 疗程卡次数（非疗程卡为 null），开单时需快照到 sale_items.session_count */
  sessionCount: number | null
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
    // 套餐商品：products WHERE is_bundle AND is_enabled AND is_visible
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
      .where(and(eq(products.isBundle, true), eq(products.isEnabled, true), eq(products.isVisible, true)))
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
            price: m.sku.price,
            bundlePrice: m.bundlePrice,
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
          price: m.sku.price,
          bundlePrice: m.bundlePrice,
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
    const parentCat = alias(productCategories, 'parent_cat')

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
          // 普通商品 = 父级一级行 isCardKind=false（DB 驱动；不再读 CARD_PRODUCT_KINDS 常量）
          eq(parentCat.isCardKind, false),
          eq(productCategories.isValid, true),
          eq(productSkus.isEnabled, true),
          // 排除 bundle SKU（SKU 被任何 is_bundle=true 的 products 通过 mall_product_skus 关联）
          sql`NOT EXISTS (
            SELECT 1 FROM mall_product_skus mps_b
            INNER JOIN products p_b ON p_b.product_id = mps_b.product_id
            WHERE mps_b.sku_id = product_skus.sku_id
              AND p_b.is_bundle = true
          )`,
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
        serviceFee: r.sku.serviceFee,
        sortOrder: r.sku.sortOrder,
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

  // 具名 kind（如 '体验卡' / '充值卡'）：平铺 categories
  const rows = await db
    .select({
      category: productCategories,
      sku: productSkus,
    })
    .from(productSkus)
    .innerJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
    .where(and(eq(productCategories.productKind, kind), eq(productSkus.isEnabled, true), eq(productCategories.isValid, true)))
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
      serviceFee: r.sku.serviceFee,
      sortOrder: r.sku.sortOrder,
    })
  }
  const categories = Array.from(catMap.values()).sort((a, b) => a.sortOrder - b.sortOrder)
  return { kind, categories }
  },
)
