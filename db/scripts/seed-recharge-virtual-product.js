#!/usr/bin/env node
/**
 * Seed 虚拟「预付充值卡」商品
 *
 * 用途：充值卡充值功能（顾客端 card.recharge）走"销售单 + 虚拟 SPU"模型。
 * 此脚本一次性插入：
 *   - mall_categories 已存在 mall-cat-cz-01（储值卡），不动
 *   - product_categories 已存在 cat-cz-01（储值卡 / product_kind=充值卡），不动 —— product_kind
 *     仍作为分类标签保留；业务判定权威源是 product_skus.is_recharge_card capability 列
 *   - products: prod-recharge-virtual（is_visible=false, is_enabled=false 双重隐藏）
 *   - product_skus: sku-recharge-virtual（is_enabled=false, product_type='家居产品' 避免被 payNotify
 *     设到期日；is_recharge_card=true 作为充值卡判定权威源）
 *   - mall_product_skus: 关联两者
 *
 * 幂等：基于固定 product_id / sku_id，重复运行只 SELECT 不写。
 *
 * 使用：
 *   # dev
 *   DATABASE_URL=postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp node db/scripts/seed-recharge-virtual-product.js
 *   # prod
 *   DATABASE_URL=postgresql://fengyu:fengyu123@118.178.196.26:5433/fengyu_wxapp node db/scripts/seed-recharge-virtual-product.js
 *
 * 双库执行：先后用两个 DATABASE_URL 各跑一次。DATABASE_URL 必填，无默认值。
 */

const { Client } = require('pg')

const PRODUCT_ID = 'prod-recharge-virtual'
const SKU_ID = 'sku-recharge-virtual'
const MALL_CATEGORY_ID = 'mall-cat-cz-01'   // 储值卡
const PRODUCT_CATEGORY_ID = 'cat-cz-01'     // 储值卡 / product_kind=充值卡

async function main() {
  // DATABASE_URL 必填：不提供默认值，避免忘传时静默连到已弃用的旧 dev 库（见 db/CLAUDE.md）
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('✗ 必须显式传 DATABASE_URL（dev=101.34.242.103:5433/fengyu_wxapp / prod=118.178.196.26:5433/fengyu_wxapp）')
    process.exit(1)
  }
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    // 0. 前置依赖检查
    const mallCat = await client.query(
      'SELECT category_id FROM mall_categories WHERE category_id = $1',
      [MALL_CATEGORY_ID],
    )
    if (mallCat.rows.length === 0) {
      throw new Error(`[seed] mall_categories 缺少 ${MALL_CATEGORY_ID}（储值卡），请先确认基础数据`)
    }
    const prodCat = await client.query(
      'SELECT category_id, product_kind FROM product_categories WHERE category_id = $1',
      [PRODUCT_CATEGORY_ID],
    )
    if (prodCat.rows.length === 0) {
      throw new Error(`[seed] product_categories 缺少 ${PRODUCT_CATEGORY_ID}（储值卡），请先确认基础数据`)
    }
    if (prodCat.rows[0].product_kind !== '充值卡') {
      throw new Error(`[seed] ${PRODUCT_CATEGORY_ID} 的 product_kind 不是「充值卡」，停止 seed`)
    }

    await client.query('BEGIN')

    // 1. products
    const productExisting = await client.query(
      'SELECT product_id, is_visible, is_enabled FROM products WHERE product_id = $1',
      [PRODUCT_ID],
    )
    if (productExisting.rows.length === 0) {
      await client.query(
        `INSERT INTO products (
           product_id, category_id, name, description,
           is_bundle, price, is_enabled, is_visible, sort_order,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, false, 0, false, false, 0, NOW(), NOW())`,
        [
          PRODUCT_ID,
          MALL_CATEGORY_ID,
          '预付充值卡',
          '系统虚拟商品：用于承载顾客端预付卡充值订单。该商品不向顾客或员工展示。',
        ],
      )
      console.log(`[seed] inserted products.${PRODUCT_ID}`)
    } else {
      const row = productExisting.rows[0]
      if (row.is_visible || row.is_enabled) {
        await client.query(
          `UPDATE products
           SET is_visible = false, is_enabled = false, updated_at = NOW()
           WHERE product_id = $1`,
          [PRODUCT_ID],
        )
        console.log(`[seed] updated products.${PRODUCT_ID} → is_visible=false, is_enabled=false`)
      } else {
        console.log(`[seed] products.${PRODUCT_ID} already exists & hidden`)
      }
    }

    // 2. product_skus
    const skuExisting = await client.query(
      'SELECT sku_id, is_enabled, product_type, unit, is_recharge_card FROM product_skus WHERE sku_id = $1',
      [SKU_ID],
    )
    if (skuExisting.rows.length === 0) {
      await client.query(
        `INSERT INTO product_skus (
           sku_id, category_id, product_type, spec_name,
           price, special_price, session_count, unit, sort_order,
           service_fee, is_shengmei, is_enabled, is_recharge_card,
           created_at, updated_at
         ) VALUES ($1, $2, '家居产品', $3, 0, NULL, NULL, '盒', 0, 0, NULL, false, true, NOW(), NOW())`,
        [SKU_ID, PRODUCT_CATEGORY_ID, '预付充值卡（虚拟）'],
      )
      console.log(`[seed] inserted product_skus.${SKU_ID} (is_recharge_card=true)`)
    } else {
      const row = skuExisting.rows[0]
      const needsUpdate =
        row.is_enabled || row.product_type !== '家居产品' || row.unit !== '盒' || row.is_recharge_card !== true
      if (needsUpdate) {
        await client.query(
          `UPDATE product_skus
           SET is_enabled = false,
               product_type = '家居产品',
               unit = '盒',
               is_recharge_card = true,
               updated_at = NOW()
           WHERE sku_id = $1`,
          [SKU_ID],
        )
        console.log(
          `[seed] updated product_skus.${SKU_ID} → is_enabled=false, product_type='家居产品', is_recharge_card=true`,
        )
      } else {
        console.log(`[seed] product_skus.${SKU_ID} already exists & disabled & is_recharge_card=true`)
      }
    }

    // 3. mall_product_skus 关联
    const linkExisting = await client.query(
      'SELECT id FROM mall_product_skus WHERE product_id = $1 AND sku_id = $2',
      [PRODUCT_ID, SKU_ID],
    )
    if (linkExisting.rows.length === 0) {
      await client.query(
        `INSERT INTO mall_product_skus (product_id, sku_id, sort_order, created_at)
         VALUES ($1, $2, 0, NOW())`,
        [PRODUCT_ID, SKU_ID],
      )
      console.log(`[seed] linked mall_product_skus(${PRODUCT_ID}, ${SKU_ID})`)
    } else {
      console.log(`[seed] mall_product_skus link already exists`)
    }

    await client.query('COMMIT')
    console.log(`[seed] DONE on ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
