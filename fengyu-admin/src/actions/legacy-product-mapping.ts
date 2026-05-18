'use server'

import { db } from '@/db'
import { legacyProductMapping } from '@db/legacy-product-mapping'
import { productCategories, productSkus } from '@db/product'
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'

/**
 * 行解析结果（admin 上传页用）。
 *
 * 校验语义（D13=A）：
 *  - error: 同 batch 内 (name, code) 重复；或 target_category_id / target_sku_id 填了但不存在 → 不入库
 *  - warning: target_category_id 与 target_sku_id 都为空 → 标黄，但允许入库（confirmed=false）
 *  - ok: 至少一个 target 非空且对应实体存在
 */
export interface ParsedRow {
  rowIndex: number // CSV 行号（含表头，data 从 2 起）
  legacyProductName: string
  legacyProductCode: string
  targetCategoryId: string | null
  targetSkuId: string | null
  source: string
  note: string | null
  level: 'ok' | 'warning' | 'error'
  messages: string[]
}

export interface UploadPreviewResult {
  totalRows: number
  okCount: number
  warningCount: number
  errorCount: number
  rows: ParsedRow[] // 仅前 100 行用于预览
}

export interface UploadCommitResult {
  inserted: number
  updated: number
  skipped: number // 错误行
  warnings: number
}

export interface MappingListRow {
  id: number
  legacyProductName: string
  legacyProductCode: string
  targetCategoryId: string | null
  targetCategoryName: string | null
  targetSkuId: string | null
  targetSkuSpecName: string | null
  source: string
  confirmed: boolean
  note: string | null
  updatedAt: string
  createdAt: string
}

export interface PaginatedMappings {
  data: MappingListRow[]
  total: number
}

export interface ListMappingFilters {
  search?: string
  source?: 'ai_inferred' | 'business_confirmed' | 'manual_override'
  onlyUnmapped?: boolean // target 全空
  onlyUnconfirmed?: boolean // confirmed=false
  page?: number
  pageSize?: number
}

/** CSV 单行入参（前端解析后传入） */
export interface CsvRowInput {
  rowIndex: number
  legacyProductName: string
  legacyProductCode?: string
  targetCategoryId?: string
  targetSkuId?: string
  source?: string
  note?: string
}

const VALID_SOURCES = new Set(['ai_inferred', 'business_confirmed', 'manual_override'])

/**
 * 预校验 CSV 行（不入库）。
 *
 * 服务端校验：
 *  - legacyProductName 必填
 *  - targetCategoryId / targetSkuId 在 DB 存在性校验
 *  - 同 batch 内 (name, code) 重复检测
 *  - source 缺省 'business_confirmed'；非白名单 → error
 *
 * 返回前 100 行 + 汇总统计。
 */
export const previewLegacyProductMappingCsv = withPermission(
  'legacy_product_mapping:write',
  async (_session, rows: CsvRowInput[]): Promise<UploadPreviewResult> => {
    return await parseAndValidate(rows)
  },
)

/**
 * 入库（UPSERT）：错误行丢弃，警告行 + 合法行写入。
 *
 * 既有 mapping 行被 CSV 覆盖时（同 legacyProductName + legacyProductCode）：
 *  - source 强制改为 'manual_override'
 *  - operation_log 记录 upload 批次
 */
export const uploadLegacyProductMappingCsv = withPermission(
  'legacy_product_mapping:write',
  async (
    session,
    rows: CsvRowInput[],
  ): Promise<UploadCommitResult> => {
    const preview = await parseAndValidate(rows)
    // 全量校验后筛选入库范围（ok + warning）
    const fullValidated = await validateFullBatch(rows)
    const eligible = fullValidated.filter((r) => r.level !== 'error')

    let inserted = 0
    let updated = 0

    await db.transaction(async (tx) => {
      for (const r of eligible) {
        // 检测是否已存在
        const existing = await tx
          .select({ id: legacyProductMapping.id, source: legacyProductMapping.source })
          .from(legacyProductMapping)
          .where(
            and(
              eq(legacyProductMapping.legacyProductName, r.legacyProductName),
              eq(legacyProductMapping.legacyProductCode, r.legacyProductCode),
            ),
          )
          .limit(1)

        if (existing.length > 0) {
          // 覆盖：source 强制 'manual_override'
          await tx
            .update(legacyProductMapping)
            .set({
              targetCategoryId: r.targetCategoryId,
              targetSkuId: r.targetSkuId,
              source: 'manual_override',
              note: r.note,
              updatedAt: new Date(),
            })
            .where(eq(legacyProductMapping.id, existing[0].id))
          updated++
        } else {
          await tx.insert(legacyProductMapping).values({
            legacyProductName: r.legacyProductName,
            legacyProductCode: r.legacyProductCode,
            targetCategoryId: r.targetCategoryId,
            targetSkuId: r.targetSkuId,
            source: r.source,
            confirmed: false,
            note: r.note,
          })
          inserted++
        }
      }
    })

    await logOperation(session, 'legacy_product_mapping.upload', 'legacy_product_mapping', '_batch', {
      _v: 3,
      _t: 'batch_upload',
      total: rows.length,
      inserted,
      updated,
      warnings: preview.warningCount,
      errors: preview.errorCount,
    })

    revalidatePath('/legacy-product-mapping')
    return {
      inserted,
      updated,
      skipped: rows.length - inserted - updated,
      warnings: eligible.filter((r) => r.level === 'warning').length,
    }
  },
)

/**
 * 列表查询（服务端分页）。
 */
export const listLegacyProductMappings = withPermission(
  'legacy_product_mapping:read',
  async (
    _session,
    filters: ListMappingFilters = {},
  ): Promise<PaginatedMappings> => {
    const page = Math.max(1, filters.page || 1)
    const pageSize = [10, 20, 50, 100].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
    const offset = (page - 1) * pageSize

    const conditions: (SQL | undefined)[] = []
    if (filters.search) {
      const pattern = `%${filters.search}%`
      conditions.push(
        or(
          ilike(legacyProductMapping.legacyProductName, pattern),
          ilike(legacyProductMapping.legacyProductCode, pattern),
        ),
      )
    }
    if (filters.source) {
      conditions.push(eq(legacyProductMapping.source, filters.source))
    }
    if (filters.onlyUnmapped) {
      conditions.push(
        and(
          isNull(legacyProductMapping.targetCategoryId),
          isNull(legacyProductMapping.targetSkuId),
        ),
      )
    }
    if (filters.onlyUnconfirmed) {
      conditions.push(eq(legacyProductMapping.confirmed, false))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [countRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(legacyProductMapping)
      .where(whereClause)
    const total = countRow?.count ?? 0

    const rows = await db
      .select({
        m: legacyProductMapping,
        categoryName: productCategories.categoryName,
        skuSpecName: productSkus.specName,
      })
      .from(legacyProductMapping)
      .leftJoin(
        productCategories,
        eq(legacyProductMapping.targetCategoryId, productCategories.categoryId),
      )
      .leftJoin(productSkus, eq(legacyProductMapping.targetSkuId, productSkus.skuId))
      .where(whereClause)
      .orderBy(desc(legacyProductMapping.updatedAt), desc(legacyProductMapping.id))
      .limit(pageSize)
      .offset(offset)

    return {
      total,
      data: rows.map((r) => ({
        id: r.m.id,
        legacyProductName: r.m.legacyProductName,
        legacyProductCode: r.m.legacyProductCode,
        targetCategoryId: r.m.targetCategoryId,
        targetCategoryName: r.categoryName ?? null,
        targetSkuId: r.m.targetSkuId,
        targetSkuSpecName: r.skuSpecName ?? null,
        source: r.m.source,
        confirmed: r.m.confirmed,
        note: r.m.note,
        updatedAt: r.m.updatedAt.toISOString(),
        createdAt: r.m.createdAt.toISOString(),
      })),
    }
  },
)

/** 更新单行 mapping（CAS 守卫；source 自动改为 manual_override） */
export const updateLegacyProductMapping = withPermission(
  'legacy_product_mapping:write',
  async (
    session,
    id: number,
    patch: {
      targetCategoryId?: string | null
      targetSkuId?: string | null
      note?: string | null
      confirmed?: boolean
    },
    expectedUpdatedAt: string,
  ): Promise<{ success: true }> => {
    // 校验外键存在
    if (patch.targetCategoryId !== undefined && patch.targetCategoryId !== null) {
      const exists = await db
        .select({ id: productCategories.categoryId })
        .from(productCategories)
        .where(eq(productCategories.categoryId, patch.targetCategoryId))
        .limit(1)
      if (exists.length === 0) {
        throw new Error('INVALID_PARAMS: target_category_id 不存在')
      }
    }
    if (patch.targetSkuId !== undefined && patch.targetSkuId !== null) {
      const exists = await db
        .select({ id: productSkus.skuId })
        .from(productSkus)
        .where(eq(productSkus.skuId, patch.targetSkuId))
        .limit(1)
      if (exists.length === 0) {
        throw new Error('INVALID_PARAMS: target_sku_id 不存在')
      }
    }

    const expectedDate = new Date(expectedUpdatedAt)
    const updRes = await db.execute(sql`
      UPDATE legacy_product_mapping
         SET target_category_id = COALESCE(${patch.targetCategoryId ?? null}, target_category_id),
             target_sku_id = COALESCE(${patch.targetSkuId ?? null}, target_sku_id),
             note = COALESCE(${patch.note ?? null}, note),
             confirmed = COALESCE(${patch.confirmed ?? null}, confirmed),
             source = 'manual_override',
             updated_at = NOW()
       WHERE id = ${id}
         AND date_trunc('milliseconds', updated_at) = ${expectedDate}
    `)
    if (((updRes as { rowCount?: number }).rowCount ?? 0) === 0) {
      throw new Error('CONFLICT: 该映射已被其他人修改，请刷新后重试')
    }

    await logOperation(
      session,
      'legacy_product_mapping.update',
      'legacy_product_mapping',
      String(id),
      { _v: 3, _t: 'update', patch },
    )

    revalidatePath('/legacy-product-mapping')
    return { success: true }
  },
)

/** 删除单行（CAS 守卫） */
export const deleteLegacyProductMapping = withPermission(
  'legacy_product_mapping:write',
  async (
    session,
    id: number,
    expectedUpdatedAt: string,
  ): Promise<{ success: true }> => {
    const expectedDate = new Date(expectedUpdatedAt)
    const delRes = await db.execute(sql`
      DELETE FROM legacy_product_mapping
       WHERE id = ${id}
         AND date_trunc('milliseconds', updated_at) = ${expectedDate}
    `)
    if (((delRes as { rowCount?: number }).rowCount ?? 0) === 0) {
      throw new Error('CONFLICT: 该映射已被其他人修改或已删除，请刷新后重试')
    }

    await logOperation(
      session,
      'legacy_product_mapping.delete',
      'legacy_product_mapping',
      String(id),
      { _v: 3, _t: 'delete' },
    )

    revalidatePath('/legacy-product-mapping')
    return { success: true }
  },
)

// ---------- helpers ----------

/** 公共校验（preview 仅前 100 行截断 + 全量统计） */
async function parseAndValidate(rows: CsvRowInput[]): Promise<UploadPreviewResult> {
  const validated = await validateFullBatch(rows)
  const okCount = validated.filter((r) => r.level === 'ok').length
  const warningCount = validated.filter((r) => r.level === 'warning').length
  const errorCount = validated.filter((r) => r.level === 'error').length
  return {
    totalRows: validated.length,
    okCount,
    warningCount,
    errorCount,
    rows: validated.slice(0, 100),
  }
}

/** 全量校验（用于 upload commit 阶段；包含 DB 存在性 + batch 内重复检测） */
async function validateFullBatch(
  rows: CsvRowInput[],
): Promise<Array<ParsedRow & {
  legacyProductCode: string
  targetCategoryId: string | null
  targetSkuId: string | null
}>> {
  // 1) 先收集所有 target ids 做一次性存在性查询
  const categoryIds = new Set<string>()
  const skuIds = new Set<string>()
  for (const r of rows) {
    if (r.targetCategoryId?.trim()) categoryIds.add(r.targetCategoryId.trim())
    if (r.targetSkuId?.trim()) skuIds.add(r.targetSkuId.trim())
  }

  let existingCategories: Set<string> = new Set()
  let existingSkus: Set<string> = new Set()
  if (categoryIds.size > 0) {
    const rows1 = await db
      .select({ id: productCategories.categoryId })
      .from(productCategories)
      .where(inArray(productCategories.categoryId, Array.from(categoryIds)))
    existingCategories = new Set(rows1.map((r) => r.id))
  }
  if (skuIds.size > 0) {
    const rows2 = await db
      .select({ id: productSkus.skuId })
      .from(productSkus)
      .where(inArray(productSkus.skuId, Array.from(skuIds)))
    existingSkus = new Set(rows2.map((r) => r.id))
  }

  // 2) batch 内 (name, code) 重复检测
  const seen = new Map<string, number>() // key → first rowIndex
  const duplicateRowIndexes = new Set<number>()
  for (const r of rows) {
    const name = (r.legacyProductName ?? '').trim()
    const code = (r.legacyProductCode ?? '').trim()
    if (!name) continue
    const key = `${name}${code}`
    if (seen.has(key)) {
      duplicateRowIndexes.add(r.rowIndex)
      duplicateRowIndexes.add(seen.get(key)!)
    } else {
      seen.set(key, r.rowIndex)
    }
  }

  // 3) 逐行计算 level + messages
  return rows.map((r) => {
    const name = (r.legacyProductName ?? '').trim()
    const code = (r.legacyProductCode ?? '').trim()
    const cat = r.targetCategoryId?.trim() || null
    const sku = r.targetSkuId?.trim() || null
    const source = (r.source ?? '').trim() || 'business_confirmed'
    const note = r.note?.trim() || null
    const messages: string[] = []
    let level: 'ok' | 'warning' | 'error' = 'ok'

    if (!name) {
      level = 'error'
      messages.push('legacy_product_name 必填')
    }
    if (!VALID_SOURCES.has(source)) {
      level = 'error'
      messages.push(`source 非法（取值：ai_inferred / business_confirmed / manual_override）`)
    }
    if (duplicateRowIndexes.has(r.rowIndex)) {
      level = 'error'
      messages.push('该 (legacy_product_name, legacy_product_code) 在本次 CSV 内重复')
    }
    if (cat && !existingCategories.has(cat)) {
      level = 'error'
      messages.push(`target_category_id "${cat}" 在 product_categories 中不存在`)
    }
    if (sku && !existingSkus.has(sku)) {
      level = 'error'
      messages.push(`target_sku_id "${sku}" 在 product_skus 中不存在`)
    }
    if (level !== 'error' && !cat && !sku) {
      level = 'warning'
      messages.push('target 全空，将作为"待映射"入库（D13=A）')
    }

    return {
      rowIndex: r.rowIndex,
      legacyProductName: name,
      legacyProductCode: code,
      targetCategoryId: cat,
      targetSkuId: sku,
      source,
      note,
      level,
      messages,
    }
  })
}
