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
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_MARKET_ORG_ID,
  TEST_MALL_CATEGORY_ID, TEST_PRODUCT_CATEGORY_ID,
  TEST_PRODUCT_ID, TEST_SKU_NORMAL_ID,
} from '../setup.mjs'
import { invokeAs, invokePublic } from '../helpers/invoke-client.mjs'
import {
  ensureTestCategories, createTestProduct, createTestSku,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'
import { cleanupTestData, createTestClient } from '../helpers/fixtures.mjs'

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

async function caseProductMarketScopeByBoundStore() {
  await createTestClient()
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    productMarketScope: `${NS}_OTHER_MARKET,${TEST_MARKET_ORG_ID}`,
  })

  async function expectProductVisible(expected, label) {
    const res = await invokeAs(TEST_CLIENT_OPENID, 'product.spuList', {
      categoryId: TEST_MALL_CATEGORY_ID,
    })
    if (res.code !== 0) throw new Error(`${label}: expect code=0, got ${res.code}: ${res.message}`)
    const visible = (res.data?.spuList || []).some(p => p.product_id === TEST_PRODUCT_ID)
    if (visible !== expected) {
      throw new Error(`${label}: expect visible=${expected}, got ${visible}`)
    }
  }

  await expectProductVisible(true, '多市场 ID 包含顾客门店所属市场')

  await pgQuery(`UPDATE products SET market_scope = $1 WHERE product_id = $2`, [
    `${NS}_OTHER_MARKET`,
    TEST_PRODUCT_ID,
  ])
  await expectProductVisible(false, '市场 ID 未命中')

  await pgQuery(`UPDATE products SET market_scope = '' WHERE product_id = $1`, [TEST_PRODUCT_ID])
  await expectProductVisible(false, '空字符串范围')

  await pgQuery(`UPDATE products SET market_scope = $1 WHERE product_id = $2`, [
    `${NS}_市场`,
    TEST_PRODUCT_ID,
  ])
  await expectProductVisible(true, '历史市场名称')

  await pgQuery(`UPDATE products SET market_scope = NULL WHERE product_id = $1`, [TEST_PRODUCT_ID])
  await expectProductVisible(true, '全部市场')
}

async function caseGlobalProductVisibleWithoutBoundStore() {
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    productMarketScope: null,
    skuMarketScope: `${NS}_OTHER_MARKET`,
  })

  async function getPublicSpuList() {
    const res = await invokePublic('product.spuList', { categoryId: TEST_MALL_CATEGORY_ID })
    if (res.code !== 0) throw new Error(`spuList: expect code=0, got ${res.code}: ${res.message}`)
    return res.data?.spuList || []
  }

  let list = await getPublicSpuList()
  let hit = list.find(p => p.product_id === TEST_PRODUCT_ID)
  if (!hit || !hit.skuList?.some(s => s.sku_id === TEST_SKU_NORMAL_ID)) {
    throw new Error('全市场 SPU 应向未绑店用户展示指定市场 SKU')
  }

  const categories = await invokePublic('product.categories', {})
  if (categories.code !== 0) throw new Error(`categories: expect code=0, got ${categories.code}: ${categories.message}`)
  if (!(categories.data?.categories || []).some(c => c.category_id === TEST_MALL_CATEGORY_ID)) {
    throw new Error('全市场 SPU 应让未绑店用户看到所属分类')
  }

  const search = await invokePublic('product.search', { keyword: '测试商品' })
  if (search.code !== 0) throw new Error(`search: expect code=0, got ${search.code}: ${search.message}`)
  if (!(search.data?.spuList || []).some(p => p.product_id === TEST_PRODUCT_ID)) {
    throw new Error('全市场 SPU 应可被未绑店用户搜索到')
  }

  const detail = await invokePublic('product.spuDetail', { productId: TEST_PRODUCT_ID })
  if (detail.code !== 0) throw new Error(`spuDetail: expect code=0, got ${detail.code}: ${detail.message}`)
  if (!(detail.data?.spu?.skuList || []).some(s => s.sku_id === TEST_SKU_NORMAL_ID)) {
    throw new Error('全市场 SPU 详情应包含指定市场 SKU')
  }

  await pgQuery(`UPDATE product_skus SET market_scope = '' WHERE sku_id = $1`, [TEST_SKU_NORMAL_ID])
  list = await getPublicSpuList()
  if (list.some(p => p.product_id === TEST_PRODUCT_ID)) {
    throw new Error('空字符串 SKU 范围应继续对未绑店用户隐藏商品')
  }

  await pgQuery(`UPDATE product_skus SET market_scope = NULL WHERE sku_id = $1`, [TEST_SKU_NORMAL_ID])
  await pgQuery(`UPDATE products SET market_scope = $1 WHERE product_id = $2`, [
    `${NS}_OTHER_MARKET`,
    TEST_PRODUCT_ID,
  ])
  list = await getPublicSpuList()
  if (list.some(p => p.product_id === TEST_PRODUCT_ID)) {
    throw new Error('指定市场 SPU 不应向未绑店用户展示')
  }
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

// hotList 路由 line 286-290 用 EXISTS (... SKU_VALID_FILTER) 兜底；SKU_VALID_FILTER 要求 is_enabled=true。
// 建一个 product 但其唯一 SKU 设 is_enabled=false → hotList 不应返回该 product。
async function caseHotListEmptySkuMarketScope() {
  await ensureTestCategories()
  // 建 product
  await createTestProduct({ productId: TEST_PRODUCT_ID })
  // 建 SKU（is_enabled 默认 true）
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, linkToProduct: true })
  // 把 SKU 禁用
  await pgQuery(
    `UPDATE product_skus SET is_enabled = false WHERE sku_id = $1`,
    [TEST_SKU_NORMAL_ID]
  )

  const res = await invokePublic('product.hotList', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  // 测试 product 不应在 hotList
  const hit = list.find(p => p.product_id === TEST_PRODUCT_ID)
  if (hit) {
    throw new Error(`expect TEST_PRODUCT_ID excluded (no enabled SKU), but found with priceFrom=${hit.priceFrom}`)
  }
}

// product.search：全量按商品名搜索（不依赖 categoryId，跨全部分类）
async function caseSearchByName() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.search', { keyword: '测试商品' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  const hit = list.find(p => p.product_id === TEST_PRODUCT_ID)
  if (!hit) throw new Error(`search('测试商品') 未命中 ${TEST_PRODUCT_ID}，got ${list.map(p => p.product_id).join(',')}`)
  if (!Array.isArray(hit.skuList) || hit.skuList.length === 0) {
    throw new Error('search 命中商品应含 skuList')
  }
}

async function caseSearchNoMatch() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.search', { keyword: 'ZZZ绝不存在ZZZ' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (list.length !== 0) throw new Error(`expect empty, got ${list.length}`)
}

async function caseSearchEmptyKeyword() {
  const res = await invokePublic('product.search', { keyword: '   ' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (list.length !== 0) throw new Error(`expect empty for blank keyword, got ${list.length}`)
}

const CASES = [
  ['categories returns array containing test mall category', caseCategoriesHasTest],
  ['spuList without categoryId returns test product', caseSpuListAll],
  ['spuList by categoryId scoped to that category', caseSpuListByCategory],
  ['spuList for unknown categoryId returns empty', caseSpuListEmptyCategory],
  ['spuList 按商城商品 market_scope 过滤绑定门店市场', caseProductMarketScopeByBoundStore],
  ['未绑店用户可浏览全市场 SPU 及其指定市场 SKU', caseGlobalProductVisibleWithoutBoundStore],
  ['shopInit returns { groups, categories, spuList }', caseShopInit],
  ['hotList 排除 disabled SKU 的 product', caseHotListEmptySkuMarketScope],
  ['search by name 命中商品（跨分类·不传 categoryId）', caseSearchByName],
  ['search 无匹配返回空', caseSearchNoMatch],
  ['search 空 keyword 返回空', caseSearchEmptyKeyword],
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
