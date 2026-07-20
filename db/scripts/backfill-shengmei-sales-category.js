#!/usr/bin/env node

/**
 * backfill-shengmei-sales-category.js — 一次性回填 sale_items / service_items 的快照字段
 *
 * 背景：
 *   管理层看板（mgmt-dashboard.summary）有 4 个指标过滤 sale_items.is_shengmei = TRUE
 *   或 service_items.sales_category IN ('自销自耗','他销自耗')。
 *   早期 5 个 WorkFine migration 脚本 INSERT sale_items 时未带 is_shengmei 列，
 *   service.create 又依赖 sale_items 拷贝两列 → 看板「生美实耗 / 项目数 / 派生人均」长期 0。
 *
 *   修复路径：
 *     1. service.js 已加 fallback（sale_items 上 NULL 时回查 product_skus + product_categories）
 *     2. 历史 sale_items / service_items 用本脚本一次性回填
 *
 * 用法：
 *   DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-shengmei-sales-category.js
 *   # 预览
 *   node db/scripts/backfill-shengmei-sales-category.js --dry-run
 *
 * 命中范围（2026-05-19 估测）：
 *   - sale_items: 99.965% 行 sku_id 为 NULL（WorkFine 历史 migrate 未带 sku_id），无法回填
 *     可回填仅 ~35 行（sku_id IS NOT NULL AND is_shengmei IS NULL）
 *   - service_items: 在 sale_items 回填后，可通过 sale_items 反查 + product_skus fallback 联查回填
 *
 * 幂等：只 UPDATE NULL 列，不覆盖已写入值。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const dryRun = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[BACKFILL-SHENGMEI] ${new Date().toISOString()} ${msg}`)
}

// STEP 1: sale_items ← product_skus + product_categories（按 sku_id）
const SALE_ITEMS_PREVIEW_SQL = `
SELECT
  COUNT(*) FILTER (WHERE si.is_shengmei IS NULL    AND ps.is_shengmei    IS NOT NULL) AS sm_to_fill,
  COUNT(*) FILTER (WHERE si.sales_category IS NULL AND pc.sales_category IS NOT NULL) AS sc_to_fill
FROM sale_items si
JOIN product_skus ps          ON ps.sku_id = si.sku_id
JOIN product_categories pc    ON pc.category_id = ps.category_id
WHERE si.sku_id IS NOT NULL
  AND (si.is_shengmei IS NULL OR si.sales_category IS NULL)
`

const SALE_ITEMS_UPDATE_SQL = `
UPDATE sale_items si
   SET is_shengmei    = COALESCE(si.is_shengmei, ps.is_shengmei),
       sales_category = COALESCE(si.sales_category, pc.sales_category)
  FROM product_skus ps
  JOIN product_categories pc ON pc.category_id = ps.category_id
 WHERE si.sku_id = ps.sku_id
   AND (si.is_shengmei IS NULL OR si.sales_category IS NULL)
   AND (ps.is_shengmei IS NOT NULL OR pc.sales_category IS NOT NULL)
`

// STEP 2: service_items ← sale_items（直接拷贝）+ product_skus fallback（间接）
const SERVICE_ITEMS_PREVIEW_SQL = `
SELECT COUNT(*) AS to_fill
FROM service_items sit
JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
LEFT JOIN product_skus ps          ON ps.sku_id = si.sku_id
LEFT JOIN product_categories pc    ON pc.category_id = ps.category_id
WHERE (sit.is_shengmei IS NULL OR sit.sales_category IS NULL)
  AND (
    COALESCE(si.is_shengmei, ps.is_shengmei) IS NOT NULL
    OR COALESCE(si.sales_category, pc.sales_category) IS NOT NULL
  )
`

const SERVICE_ITEMS_UPDATE_SQL = `
UPDATE service_items sit
   SET is_shengmei    = COALESCE(sit.is_shengmei,    si.is_shengmei,    ps.is_shengmei),
       sales_category = COALESCE(sit.sales_category, si.sales_category, pc.sales_category)
  FROM sale_items si
  LEFT JOIN product_skus ps        ON ps.sku_id = si.sku_id
  LEFT JOIN product_categories pc  ON pc.category_id = ps.category_id
 WHERE sit.sale_item_id = si.sale_item_id
   AND (sit.is_shengmei IS NULL OR sit.sales_category IS NULL)
`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${dryRun ? 'DRY-RUN（仅预览，不写入）' : 'EXECUTE（实际写入）'}`)

  const pool = new Pool(PG_CONFIG)
  try {
    // STEP 1
    log('--- STEP 1: sale_items ← product_skus + product_categories ---')
    const p1 = await pool.query(SALE_ITEMS_PREVIEW_SQL)
    log(`待回填 sale_items.is_shengmei: ${p1.rows[0].sm_to_fill}`)
    log(`待回填 sale_items.sales_category: ${p1.rows[0].sc_to_fill}`)

    if (!dryRun) {
      const r1 = await pool.query(SALE_ITEMS_UPDATE_SQL)
      log(`STEP 1 已回填: ${r1.rowCount} 行 sale_items`)
    }

    // STEP 2
    log('--- STEP 2: service_items ← sale_items + product_skus fallback ---')
    const p2 = await pool.query(SERVICE_ITEMS_PREVIEW_SQL)
    log(`待回填 service_items: ${p2.rows[0].to_fill}`)

    if (!dryRun) {
      const r2 = await pool.query(SERVICE_ITEMS_UPDATE_SQL)
      log(`STEP 2 已回填: ${r2.rowCount} 行 service_items`)
    }

    if (dryRun) {
      log('--dry-run 模式结束，未实际写入')
    } else {
      log('✓ 回填完成')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('回填失败:', err)
  process.exit(1)
})
