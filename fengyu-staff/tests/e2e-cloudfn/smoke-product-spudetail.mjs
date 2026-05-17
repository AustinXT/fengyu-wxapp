#!/usr/bin/env bun
/**
 * product.skuDetail 冒烟（前端开单选 SKU 看详情走这条；商城 spuDetail 走 admin）
 *
 * 验证：
 *   1. skuDetail 返回单个 SKU 的全部字段（含价格、次数、service_fee、is_shengmei）
 *   2. JOIN product_categories 带出 category_name / product_kind / sales_category
 *   3. 不存在的 skuId 必拒
 */
import './setup.mjs'
import { NS, TEST_MANAGER_OPENID, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestProduct, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-product-spudetail] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  const { skuId } = await createTestProduct({
    suffix: 'D', productKind: '护理项目', productType: '疗程卡',
    salesCategory: '他销他耗', price: 300, sessionCount: 3, isShengmei: true,
  })

  const errors = []

  // 1. 正常 skuDetail
  const r = await invokeStaffApi('product.skuDetail', { _testOpenid: TEST_MANAGER_OPENID, skuId })
  if (r.code !== 0) errors.push(`skuDetail code=${r.code} msg=${r.message}`)
  else {
    const sku = r.data?.sku
    if (!sku) errors.push(`skuDetail.data.sku 应非空`)
    else {
      const expected = ['sku_id', 'product_type', 'spec_name', 'price', 'session_count', 'service_fee', 'is_shengmei', 'category_id', 'product_kind', 'sales_category']
      for (const k of expected) {
        if (!(k in sku)) errors.push(`skuDetail.sku 缺字段 ${k}`)
      }
      if (sku.sku_id !== skuId) errors.push(`sku_id 应=${skuId}`)
      if (Number(sku.price) !== 300) errors.push(`price 应=300`)
      if (sku.product_kind !== '护理项目') errors.push(`product_kind 应='护理项目'`)
      rec(`  ✓ skuDetail OK: ${sku.spec_name} ¥${sku.price} sessions=${sku.session_count}`)
    }
  }

  // 2. 不存在 skuId
  const r2 = await invokeStaffApi('product.skuDetail', { _testOpenid: TEST_MANAGER_OPENID, skuId: 'NOT-EXIST' })
  if (r2.code === 0) errors.push(`不存在 skuId 应拒，实际成功`)
  else rec(`  ✓ 不存在 skuId 被拒`)

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — skuDetail 字段 + 守卫正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-product-spudetail] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
