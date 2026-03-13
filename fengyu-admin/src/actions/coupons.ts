'use server'

import { db } from '@/db'
import { couponTemplates } from '@db/coupon'
import { eq } from 'drizzle-orm'
import type { CouponTemplate } from '@/lib/types'
import { desc } from 'drizzle-orm'

function serializeTemplate(r: typeof couponTemplates.$inferSelect): CouponTemplate {
  return {
    templateId: r.templateId,
    name: r.name,
    couponType: r.couponType as CouponTemplate['couponType'],
    discountValue: r.discountValue,
    minSpend: r.minSpend,
    maxDiscount: r.maxDiscount,
    totalCount: r.totalCount,
    applicableProductIds: r.applicableProductIds,
    applicableCategoryIds: r.applicableCategoryIds,
    applicableStoreIds: r.applicableStoreIds,
    validityMode: r.validityMode,
    validFrom: r.validFrom?.toISOString() ?? null,
    validTo: r.validTo?.toISOString() ?? null,
    validDays: r.validDays,
    description: r.description,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function getTemplates(): Promise<CouponTemplate[]> {
  const rows = await db
    .select()
    .from(couponTemplates)
    .orderBy(desc(couponTemplates.createdAt))

  return rows.map(serializeTemplate)
}

export async function getTemplateById(templateId: string): Promise<CouponTemplate | null> {
  const rows = await db
    .select()
    .from(couponTemplates)
    .where(eq(couponTemplates.templateId, templateId))
    .limit(1)

  if (rows.length === 0) return null
  return serializeTemplate(rows[0])
}

export async function createTemplate(data: {
  templateId: string
  name: string
  couponType: string
  discountValue: string
  minSpend?: string
  maxDiscount?: string | null
  totalCount?: number | null
  applicableProductIds?: string[] | null
  applicableCategoryIds?: string[] | null
  applicableStoreIds?: string[] | null
  validityMode?: string
  validFrom?: string | null
  validTo?: string | null
  validDays?: number | null
  description?: string | null
  isActive?: boolean
}) {
  await db.insert(couponTemplates).values({
    templateId: data.templateId,
    name: data.name,
    couponType: data.couponType as typeof couponTemplates.$inferInsert['couponType'],
    discountValue: data.discountValue,
    minSpend: data.minSpend,
    maxDiscount: data.maxDiscount ?? null,
    totalCount: data.totalCount ?? null,
    applicableProductIds: data.applicableProductIds ?? null,
    applicableCategoryIds: data.applicableCategoryIds ?? null,
    applicableStoreIds: data.applicableStoreIds ?? null,
    validityMode: data.validityMode as typeof couponTemplates.$inferInsert['validityMode'],
    validFrom: data.validFrom ? new Date(data.validFrom) : null,
    validTo: data.validTo ? new Date(data.validTo) : null,
    validDays: data.validDays ?? null,
    description: data.description ?? null,
    isActive: data.isActive ?? true,
  })
}

export async function updateTemplate(
  templateId: string,
  data: {
    name?: string
    couponType?: string
    discountValue?: string
    minSpend?: string
    maxDiscount?: string | null
    totalCount?: number | null
    applicableProductIds?: string[] | null
    applicableCategoryIds?: string[] | null
    applicableStoreIds?: string[] | null
    validityMode?: string
    validFrom?: string | null
    validTo?: string | null
    validDays?: number | null
    description?: string | null
    isActive?: boolean
  }
) {
  const updateData: Record<string, unknown> = { ...data }
  if (data.validFrom !== undefined) {
    updateData.validFrom = data.validFrom ? new Date(data.validFrom) : null
  }
  if (data.validTo !== undefined) {
    updateData.validTo = data.validTo ? new Date(data.validTo) : null
  }
  await db
    .update(couponTemplates)
    .set(updateData)
    .where(eq(couponTemplates.templateId, templateId))
}
