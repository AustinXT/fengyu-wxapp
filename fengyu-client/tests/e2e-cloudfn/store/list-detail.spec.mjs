#!/usr/bin/env bun
/**
 * clientApi.store.list / store.detail
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/store.js → list / detail
 *
 * 用例：
 *   1. list 无参 → 包含测试店（断言 length ≥ 1 且能找到 TEST_STORE_ID）
 *   2. list city='不存在的城市' → 路由用 LIKE 'XX%'，期望空数组
 *   3. detail by storeId → 返回 store_name/staff_count/customer_count
 *   4. detail by storeName → 同上
 *   5. detail 不存在 → INVALID_PARAMS: 门店不存在
 *   6. detail 缺参 → INVALID_PARAMS: 缺少 storeId 或 storeName
 *
 * 注意：store.list / store.detail 不需要 OPENID 鉴权（公开接口），但 invokeAs 仍传 openid
 *       兼容 mock 模式。
 *
 * 注意：路由源返回 staff_count（不是 employee_count），断言用 staff_count。
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_STORE_ID,
  TEST_CLIENT_OPENID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

async function caseListAll() {
  await ensureTestStore()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.stores) || res.data.stores.length < 1) {
    throw new Error(`expect stores.length >= 1, got ${res.data.stores?.length}`)
  }
  const found = res.data.stores.find(s => s.store_id === TEST_STORE_ID)
  if (!found) throw new Error(`expect to find ${TEST_STORE_ID} in stores list`)
}

async function caseListByUnknownCity() {
  await ensureTestStore()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.list', { city: '不存在的城市XYZ' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.stores) || res.data.stores.length !== 0) {
    throw new Error(`expect 0 stores for unknown city, got ${res.data.stores?.length}`)
  }
}

async function caseDetailByStoreId() {
  await ensureTestStore()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.detail', { storeId: TEST_STORE_ID })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.store) throw new Error(`expect store payload`)
  if (res.data.store.store_id !== TEST_STORE_ID) {
    throw new Error(`store_id mismatch: ${res.data.store.store_id}`)
  }
  if (typeof res.data.store.staff_count !== 'number') {
    throw new Error(`expect staff_count number, got ${typeof res.data.store.staff_count}`)
  }
  if (typeof res.data.store.customer_count !== 'number') {
    throw new Error(`expect customer_count number, got ${typeof res.data.store.customer_count}`)
  }
}

async function caseDetailByStoreName() {
  await ensureTestStore()
  const storeName = `${NS}_测试店`
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.detail', { storeName })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.store?.store_name !== storeName) {
    throw new Error(`store_name mismatch: ${res.data.store?.store_name}`)
  }
}

async function caseDetailNotFound() {
  await ensureTestStore()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.detail', { storeId: 'NOT_EXIST_999' })
  if (res.code === 0) throw new Error(`expect non-zero, got success`)
  if (!String(res.message || '').includes('门店不存在')) {
    throw new Error(`expect "门店不存在", got: ${res.message}`)
  }
}

async function caseDetailMissingParam() {
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.detail', {})
  if (res.code === 0) throw new Error(`expect non-zero, got success`)
  if (!String(res.message || '').includes('缺少 storeId 或 storeName')) {
    throw new Error(`expect "缺少 storeId 或 storeName", got: ${res.message}`)
  }
}

const CASES = [
  ['list (no city) → includes test store', caseListAll],
  ['list (unknown city) → empty array', caseListByUnknownCity],
  ['detail by storeId → store_name + counts', caseDetailByStoreId],
  ['detail by storeName → same shape', caseDetailByStoreName],
  ['detail not found → INVALID_PARAMS', caseDetailNotFound],
  ['detail missing param → INVALID_PARAMS', caseDetailMissingParam],
]

let pass = 0, fail = 0
console.log(`[list-detail.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[list-detail.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
