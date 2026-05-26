#!/usr/bin/env bun
/**
 * clientApi.product.{skuDetail,spuDetail,hotList,experienceCardList}
 *
 * 公开接口（无 auth）：用 invokePublic。
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/product.js
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_PRODUCT_ID, TEST_SKU_NORMAL_ID, TEST_SKU_EXPERIENCE_ID,
} from '../setup.mjs'
import { invokePublic } from '../helpers/invoke-client.mjs'
import {
  createTestSku, cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'
import { cleanupTestData } from '../helpers/fixtures.mjs'

async function caseSkuDetailHappy() {
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    price: '128.00',
  })
  const res = await invokePublic('product.skuDetail', { skuId: TEST_SKU_NORMAL_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const sku = res.data?.sku
  if (!sku) throw new Error('sku missing')
  if (sku.sku_id !== TEST_SKU_NORMAL_ID) throw new Error(`sku_id mismatch: ${sku.sku_id}`)
  if (Number(sku.price) !== 128) throw new Error(`price mismatch: ${sku.price}`)
  if (!sku.spec_name) throw new Error('spec_name missing')
}

async function caseSkuDetailMissingId() {
  const res = await invokePublic('product.skuDetail', {})
  if (res.code !== -400) throw new Error(`expect code=-400, got ${res.code}: ${res.message}`)
  if (res.errorType !== 'INVALID_PARAMS') {
    throw new Error(`expect errorType=INVALID_PARAMS, got ${res.errorType}`)
  }
}

async function caseSkuDetailNotFound() {
  const res = await invokePublic('product.skuDetail', { skuId: `${NS}_NOEXIST_SKU` })
  if (res.code !== -400) throw new Error(`expect code=-400, got ${res.code}: ${res.message}`)
  if (res.errorType !== 'INVALID_PARAMS') {
    throw new Error(`expect errorType=INVALID_PARAMS, got ${res.errorType}`)
  }
}

async function caseSpuDetailHappy() {
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.spuDetail', { productId: TEST_PRODUCT_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const spu = res.data?.spu
  if (!spu) throw new Error('spu missing')
  if (spu.product_id !== TEST_PRODUCT_ID) throw new Error(`product_id mismatch`)
  if (!Array.isArray(spu.skuList) || spu.skuList.length === 0) {
    throw new Error('skuList must be non-empty')
  }
}

async function caseSpuDetailLegacySpuId() {
  // 路由源 line 332：const productId = inputProductId || spuId — 兼容旧字段
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.spuDetail', { spuId: TEST_PRODUCT_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const spu = res.data?.spu
  if (!spu || spu.product_id !== TEST_PRODUCT_ID) {
    throw new Error('spuId fallback not honored')
  }
}

async function caseHotList() {
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokePublic('product.hotList', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.spuList || []
  if (!Array.isArray(list)) throw new Error('spuList not array')
  // 默认 limit=6
  if (list.length > 6) throw new Error(`expect ≤6, got ${list.length}`)
  // 测试商品（普通单品）应当在内
  const hit = list.find(p => p.product_id === TEST_PRODUCT_ID)
  if (!hit) throw new Error('expect test product in hotList')
}

async function caseExperienceCardList() {
  // 建一个体验卡 SKU（is_experience=true）+ 一个普通 SKU
  await createTestSku({
    skuId: TEST_SKU_EXPERIENCE_ID,
    productId: TEST_PRODUCT_ID,
    isExperience: true,
    price: '99.00',
  })
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    isExperience: false,
    price: '128.00',
    linkToProduct: false, // 已经被体验卡那次 link 关联了
  })
  const res = await invokePublic('product.experienceCardList', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const list = res.data?.skuList || []
  const exp = list.find(s => s.sku_id === TEST_SKU_EXPERIENCE_ID)
  if (!exp) throw new Error('expect experience SKU in result')
  const norm = list.find(s => s.sku_id === TEST_SKU_NORMAL_ID)
  if (norm) throw new Error('normal SKU should NOT appear in experienceCardList')
}

const CASES = [
  ['skuDetail returns sku with price/spec', caseSkuDetailHappy],
  ['skuDetail missing skuId → INVALID_PARAMS', caseSkuDetailMissingId],
  ['skuDetail unknown skuId → INVALID_PARAMS', caseSkuDetailNotFound],
  ['spuDetail returns spu with skuList', caseSpuDetailHappy],
  ['spuDetail legacy spuId field fallback', caseSpuDetailLegacySpuId],
  ['hotList returns ≤6 items including test product', caseHotList],
  ['experienceCardList returns experience SKU but not normal', caseExperienceCardList],
]

let pass = 0, fail = 0
console.log(`[detail.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[detail.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
