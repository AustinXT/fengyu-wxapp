#!/usr/bin/env bun
/**
 * clientApi.product.{categories,spuList,shopInit}
 *
 * 公开接口（无 auth）：用 invokePublic。
 * 数据源：mall_categories + products + mall_product_skus + product_skus + product_categories。
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/product.js
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_MALL_CATEGORY_ID, TEST_PRODUCT_CATEGORY_ID,
  TEST_PRODUCT_ID, TEST_SKU_NORMAL_ID,
} from '../setup.mjs'
import { invokePublic } from '../helpers/invoke-client.mjs'
import {
  ensureTestCategories, createTestProduct, createTestSku,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'
import { cleanupTestData } from '../helpers/fixtures.mjs'

async function caseCategoriesHasTest() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.categories', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const arr = res.data?.categories || []
  if (!Array.isArray(arr)) throw new Error('categories not array')
  const hit = arr.find(c => c.category_id === TEST_MALL_CATEGORY_ID)
  if (!hit) throw new Error(`expect TEST_MALL_CATEGORY_ID in categories, got ${arr.map(c => c.category_id).join(',')}`)
}

async function caseSpuListAll() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.spuList', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  const hit = list.find(p => p.product_id === TEST_PRODUCT_ID)
  if (!hit) throw new Error(`expect TEST_PRODUCT_ID in spuList`)
  if (!Array.isArray(hit.skuList) || hit.skuList.length === 0) {
    throw new Error('expect skuList non-empty')
  }
}

async function caseSpuListByCategory() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.spuList', { categoryId: TEST_MALL_CATEGORY_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (list.length === 0) throw new Error('expect ≥1 product for category')
  for (const p of list) {
    if (p.category_id !== TEST_MALL_CATEGORY_ID) {
      throw new Error(`unexpected category_id=${p.category_id}`)
    }
  }
}

async function caseSpuListEmptyCategory() {
  const res = await invokePublic('product.spuList', { categoryId: `${NS}_NOEXIST` })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (list.length !== 0) throw new Error(`expect empty list, got ${list.length}`)
}

async function caseShopInit() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.shopInit', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const { groups, categories, spuList } = res.data || {}
  if (!Array.isArray(groups)) throw new Error('shopInit groups not array')
  if (!Array.isArray(categories)) throw new Error('shopInit categories not array')
  if (!Array.isArray(spuList)) throw new Error('shopInit spuList not array')
}

const CASES = [
  ['categories returns array containing test mall category', caseCategoriesHasTest],
  ['spuList without categoryId returns test product', caseSpuListAll],
  ['spuList by categoryId scoped to that category', caseSpuListByCategory],
  ['spuList for unknown categoryId returns empty', caseSpuListEmptyCategory],
  ['shopInit returns { groups, categories, spuList }', caseShopInit],
]

let pass = 0, fail = 0
console.log(`[catalog.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[catalog.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
