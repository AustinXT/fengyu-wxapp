import "server-only"

import { sql } from "drizzle-orm"
import { db } from "@/db"
import type { AssistantCategoryPair, AssistantProductTermOptions } from "./assistant-domain-terms"

const PRODUCT_TERMS_CACHE_TTL = 10 * 60 * 1000

interface CategoryTermRow {
  [key: string]: unknown
  productKind: unknown
  categoryName: unknown
}

interface SeriesTermRow {
  [key: string]: unknown
  name: unknown
}

interface ProductTermRow {
  [key: string]: unknown
  skuId: unknown
  productName: unknown
  productKind: unknown
  categoryName: unknown
  seriesName: unknown
}

let productTermsCache: { expiresAt: number; options: AssistantProductTermOptions } | null = null

function clean(value: unknown): string {
  return String(value ?? "").trim()
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
}

export async function getSystemProductTermOptions(): Promise<AssistantProductTermOptions> {
  const now = Date.now()
  if (productTermsCache && productTermsCache.expiresAt > now) return productTermsCache.options

  const [categoryRows, seriesRows, productRows] = await Promise.all([
    db.execute<CategoryTermRow>(sql`
      SELECT
        NULLIF(BTRIM(product_kind), '') AS "productKind",
        NULLIF(BTRIM(category_name), '') AS "categoryName"
      FROM product_categories
      WHERE is_valid = TRUE
    `),
    db.execute<SeriesTermRow>(sql`
      SELECT NULLIF(BTRIM(name), '') AS name
      FROM project_series_lookup
      WHERE is_valid = TRUE
    `),
    db.execute<ProductTermRow>(sql`
      SELECT
        sku_id AS "skuId",
        NULLIF(BTRIM(spec_name), '') AS "productName",
        NULLIF(BTRIM(pc.product_kind), '') AS "productKind",
        NULLIF(BTRIM(pc.category_name), '') AS "categoryName",
        NULLIF(BTRIM(psl.name), '') AS "seriesName"
      FROM product_skus sk
      JOIN product_categories pc ON pc.category_id = sk.category_id
      LEFT JOIN project_series_lookup psl ON psl.id = sk.project_series_id
      WHERE sk.deleted_at IS NULL
        AND sk.is_enabled = TRUE
    `),
  ])

  const categoryPairs: AssistantCategoryPair[] = []
  const productKinds: string[] = []
  const categoryNames: string[] = []

  for (const row of categoryRows) {
    const categoryName = clean(row.categoryName)
    const productKind = clean(row.productKind)
    if (productKind) {
      productKinds.push(productKind)
      if (categoryName) {
        categoryNames.push(categoryName)
        categoryPairs.push({ productKind, categoryName })
      }
    } else if (categoryName) {
      productKinds.push(categoryName)
    }
  }

  const options: AssistantProductTermOptions = {
    productKinds: unique(productKinds),
    categoryNames: unique(categoryNames),
    categoryPairs,
    categories: unique(categoryPairs.map((pair) => `${pair.productKind} / ${pair.categoryName}`)),
    seriesNames: unique(seriesRows.map((row) => clean(row.name))),
    products: productRows
      .map((row) => ({
        skuId: clean(row.skuId),
        productName: clean(row.productName),
        productNames: [clean(row.productName)],
        productKind: clean(row.productKind),
        categoryName: clean(row.categoryName),
        seriesName: clean(row.seriesName),
      }))
      .filter((row) => row.skuId && row.productName),
  }

  productTermsCache = { expiresAt: now + PRODUCT_TERMS_CACHE_TTL, options }
  return options
}
