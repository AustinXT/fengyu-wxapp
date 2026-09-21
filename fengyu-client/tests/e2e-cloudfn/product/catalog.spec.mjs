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

  // 直接下单的结算页以 skuDetail 重取权威价格；该接口必须与 SPU 详情使用同一未绑店可见性。
  const skuDetail = await invokePublic('product.skuDetail', {
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
  })
  if (skuDetail.code !== 0 || skuDetail.data?.sku?.sku_id !== TEST_SKU_NORMAL_ID) {
    throw new Error(`未绑店用户应能加载指定市场 SKU 的结算价格: ${skuDetail.message || 'SKU 缺失'}`)
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

// ─── issue #248：商品列表硬分页 ───────────────────────────
//
// 全部用例都限定 categoryId=TEST_MALL_CATEGORY_ID，与库里的真实商品隔离。
// 注意 caseSpuListAll（不传 categoryId）之所以在默认 LIMIT 20 下稳定命中测试商品，
// 是因为 fixture 的 sort_order=0 而真实商品 sort_order 都 ≥ 10001 —— 排序键决定的，
// 不是运气，但也别再往那条用例上加依赖。

/** 造 n 个测试商品，sort_order 故意重复，专打「单列游标会漏行」的场景 */
async function createPagingProducts(sortOrders) {
  const ids = []
  for (let i = 0; i < sortOrders.length; i++) {
    const productId = `${NS}_PG_P${String(i + 1).padStart(2, '0')}`
    await createTestSku({
      skuId: `${NS}_PG_SKU${String(i + 1).padStart(2, '0')}`,
      productId,
      productSortOrder: sortOrders[i],
      linkToProduct: true,
    })
    ids.push({ productId, sortOrder: sortOrders[i] })
  }
  // 期望顺序 = (sort_order, product_id) 升序
  ids.sort((a, b) => a.sortOrder - b.sortOrder || a.productId.localeCompare(b.productId))
  return ids.map(x => x.productId)
}

async function caseSpuListPaging() {
  await ensureTestCategories()
  // 7 个商品，sort_order 只有 3 个取值
  const expected = await createPagingProducts([5, 5, 5, 7, 7, 9, 9])

  const seen = []
  let cursor
  let pages = 0
  for (;;) {
    pages++
    if (pages > 20) throw new Error('翻页未收敛，疑似游标不前进')
    const payload = { categoryId: TEST_MALL_CATEGORY_ID, limit: 3 }
    if (cursor) payload.cursor = cursor
    const res = await invokePublic('product.spuList', payload)
    if (res.code !== 0) throw new Error(`page${pages}: expect code=0, got ${res.code}: ${res.message}`)

    const list = res.data?.spuList || []
    if (list.length > 3) throw new Error(`page${pages}: 单页应 ≤ limit(3)，got ${list.length}`)
    seen.push(...list.map(p => p.product_id))

    if (!res.data?.hasMore) {
      if (res.data?.nextCursor !== null) throw new Error('hasMore=false 时 nextCursor 应为 null')
      break
    }
    if (!res.data?.nextCursor) throw new Error(`page${pages}: hasMore=true 但没给 nextCursor`)
    cursor = res.data.nextCursor
  }

  const uniq = new Set(seen)
  if (uniq.size !== seen.length) throw new Error(`翻页出现重复行: ${seen.join(',')}`)
  if (seen.length !== expected.length) {
    throw new Error(`翻页共 ${seen.length} 行，期望 ${expected.length}（漏行）`)
  }
  if (seen.join(',') !== expected.join(',')) {
    throw new Error(`翻页顺序不符合 (sort_order, product_id) 升序\n  got: ${seen.join(',')}\n  exp: ${expected.join(',')}`)
  }
  if (pages !== 3) throw new Error(`7 行 / limit 3 应翻 3 页，实际 ${pages}`)
}

async function caseSearchPaging() {
  await ensureTestCategories()
  const expected = await createPagingProducts([5, 5, 5, 7])

  const seen = []
  let cursor
  for (;;) {
    const payload = { keyword: '测试商品', limit: 2 }
    if (cursor) payload.cursor = cursor
    const res = await invokePublic('product.search', payload)
    if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
    const list = res.data?.spuList || []
    if (list.length > 2) throw new Error(`search 单页应 ≤ limit(2)，got ${list.length}`)
    seen.push(...list.map(p => p.product_id))
    if (!res.data?.hasMore) break
    cursor = res.data.nextCursor
    if (seen.length > 50) throw new Error('search 翻页未收敛')
  }

  for (const id of expected) {
    if (!seen.includes(id)) throw new Error(`search 分页漏掉 ${id}`)
  }
  if (new Set(seen).size !== seen.length) throw new Error(`search 分页出现重复: ${seen.join(',')}`)
}

async function caseSpuListLimitClamped() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  // 超大 limit 不报错，但被后端夹到 PRODUCT_PAGE_SIZE_MAX(50)
  const res = await invokePublic('product.spuList', { limit: 9999 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (list.length > 50) throw new Error(`limit 未被夹取，返回 ${list.length} 行`)
}

async function caseInvalidPagingParams() {
  const bad = [
    ['limit=0', { categoryId: TEST_MALL_CATEGORY_ID, limit: 0 }],
    ['limit=-1', { categoryId: TEST_MALL_CATEGORY_ID, limit: -1 }],
    ['limit 非整数', { categoryId: TEST_MALL_CATEGORY_ID, limit: 1.5 }],
    ['cursor 空串', { categoryId: TEST_MALL_CATEGORY_ID, cursor: '' }],
    ['cursor 乱码', { categoryId: TEST_MALL_CATEGORY_ID, cursor: '!!!not-a-cursor!!!' }],
    ['cursor 结构不对', { categoryId: TEST_MALL_CATEGORY_ID, cursor: Buffer.from('[1]').toString('base64') }],
  ]
  for (const [label, payload] of bad) {
    const res = await invokePublic('product.spuList', payload)
    if (res.code !== -400) throw new Error(`${label}: expect code=-400, got ${res.code}: ${res.message}`)
  }
}

async function caseShopInitPaging() {
  await ensureTestCategories()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.shopInit', { limit: 5 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)

  const { spuList, spuCategoryId, nextCursor, hasMore } = res.data || {}
  if (!Array.isArray(spuList)) throw new Error('shopInit spuList not array')
  if (spuList.length > 5) throw new Error(`shopInit 未按 limit 截断，got ${spuList.length}`)
  if (typeof hasMore !== 'boolean') throw new Error('shopInit 应下发 hasMore')
  if (spuList.length > 0 && !spuCategoryId) {
    throw new Error('有商品时 shopInit 必须下发 spuCategoryId，前端据它挂游标')
  }
  if (spuCategoryId) {
    // 下发的商品必须全部属于 spuCategoryId，否则前端翻页会翻错分类
    const wrong = spuList.find(p => p.category_id !== spuCategoryId)
    if (wrong) throw new Error(`spuCategoryId=${spuCategoryId} 与商品 category_id=${wrong.category_id} 不符`)
  }
  if (hasMore && !nextCursor) throw new Error('shopInit hasMore=true 但没给 nextCursor')
  if (!hasMore && nextCursor !== null) throw new Error('shopInit hasMore=false 时 nextCursor 应为 null')
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
  // issue #248
  ['spuList keyset 翻页：sort_order 重复也不漏行不重复', caseSpuListPaging],
  ['search 同样支持 keyset 翻页', caseSearchPaging],
  ['spuList limit 超上限被夹到 50', caseSpuListLimitClamped],
  ['非法 limit / 畸形 cursor 返回 -400', caseInvalidPagingParams],
  ['shopInit 下发 spuCategoryId + 分页字段且自洽', caseShopInitPaging],
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
