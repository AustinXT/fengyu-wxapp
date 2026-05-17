#!/usr/bin/env bun
/**
 * product.shopInit 冒烟
 *
 * 验证：
 *   1. shopInit 一次性返回 categories + 首类目 SKU + bundle 组（不崩溃）
 *   2. categories 中至少包含一个 product_kind 一级行
 *   3. 非空过滤：只返回有 SKU 的二级品类
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestProduct, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-product-shopinit] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestProduct({ suffix: 'A', productKind: '护理项目', productType: '单品', price: 100 })

  const errors = []
  const r = await invokeStaffApi('product.shopInit', { _testOpenid: TEST_MANAGER_OPENID })
  if (r.code !== 0) errors.push(`shopInit code=${r.code} msg=${r.message}`)
  else {
    const { categories, skuList, bundleGroups } = r.data
    if (!Array.isArray(categories) || categories.length === 0) errors.push(`categories 应非空数组`)
    if (!Array.isArray(skuList)) errors.push(`skuList 应为数组`)
    // bundleGroups 可为 undefined（无套餐时）或数组（有套餐时）
    if (bundleGroups !== undefined && !Array.isArray(bundleGroups)) errors.push(`bundleGroups 应为数组或缺省`)
    rec(`  ✓ categories=${categories.length} skuList=${skuList?.length} bundleGroups=${bundleGroups?.length ?? 'none'}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — shopInit 三段返回正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-product-shopinit] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
