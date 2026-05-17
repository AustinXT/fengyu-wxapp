#!/usr/bin/env bun
/**
 * product.skuList 冒烟
 *
 * 验证：
 *   1. by category（categoryId）返回该类目下 SKU
 *   2. by kind（productKind）返回该一级品类下所有 SKU
 *   3. 测试 SKU（is_enabled=true）应在返回里
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestProduct, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-product-skulist] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  const { categoryId, skuId } = await createTestProduct({ suffix: 'L', productKind: '护理项目', productType: '单品', price: 200 })

  const errors = []
  // 1. by categoryId
  const r1 = await invokeStaffApi('product.skuList', {
    _testOpenid: TEST_MANAGER_OPENID, categoryId,
  })
  if (r1.code !== 0) errors.push(`skuList by cat code=${r1.code} msg=${r1.message}`)
  else {
    const found = (r1.data || []).find(s => s.skuId === skuId)
    if (!found) errors.push(`skuList by cat 应包含 ${skuId}`)
    else rec(`  ✓ by category: ${r1.data.length} skus 含测试 sku`)
  }

  // 2. by productKind
  const r2 = await invokeStaffApi('product.skuList', {
    _testOpenid: TEST_MANAGER_OPENID, productKind: '护理项目',
  })
  if (r2.code !== 0) errors.push(`skuList by kind code=${r2.code}`)
  else {
    const found = (r2.data || []).find(s => s.skuId === skuId)
    if (!found) errors.push(`skuList by kind 应包含 ${skuId}`)
    else rec(`  ✓ by kind: ${r2.data.length} skus 含测试 sku`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — skuList 双路径正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-product-skulist] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
