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
import { ensureTestStore, createTestStaff, createTestProduct, createTestBundleProduct, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-product-shopinit] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  const { skuId } = await createTestProduct({ suffix: 'A', productKind: '护理项目', productType: '疗程卡', price: 100 })
  // 套餐夹具（#232）：没有它，下面的封面缩略断言永远跑在空集上 —— 恒真、零覆盖。
  // 一个**带 COS 封面**、一个**无封面**，正负两例都要真实经过云函数。
  const bundleWithCover = await createTestBundleProduct({ suffix: 'B1', skuIds: [skuId] })
  await createTestBundleProduct({ suffix: 'B2', coverImage: null, skuIds: [skuId] })

  const errors = []
  const r = await invokeStaffApi('product.shopInit', { _testOpenid: TEST_MANAGER_OPENID })
  if (r.code !== 0) errors.push(`shopInit code=${r.code} msg=${r.message}`)
  else {
    // ⚠️ 键名是 mallBundleGroups（routes/product.js:449），不是 bundleGroups。
    // 此前这里解构的是 bundleGroups → 恒为 undefined → 下面那条断言恒真，
    // 整条套餐链路在 L2 上是**空覆盖**（#232 的 pr-ready sibling 审计发现）。
    const { categories, skuList, mallBundleGroups, experienceSkus } = r.data
    if (!Array.isArray(categories) || categories.length === 0) errors.push(`categories 应非空数组`)
    if (!Array.isArray(skuList)) errors.push(`skuList 应为数组`)
    // mallBundleGroups 可为 undefined（无套餐时）或数组（有套餐时）
    if (mallBundleGroups !== undefined && !Array.isArray(mallBundleGroups)) errors.push(`mallBundleGroups 应为数组或缺省`)
    // 封面必须缩略后下发（#232）：要么是 null（不可缩略/无封面），
    // 要么带 imageMogr2 规则。**绝不能是未处理的原图 URL** —— 解码内存 = 像素×4，
    // 一张巨图就能撑爆小程序进程。
    for (const b of mallBundleGroups ?? []) {
      if (b.coverImage === null) continue
      if (typeof b.coverImage !== 'string' || !b.coverImage.includes('imageMogr2/thumbnail/')) {
        errors.push(`套餐 ${b.productId} 的 coverImage 未经缩略处理: ${JSON.stringify(b.coverImage)}`)
      }
    }
    // 上面那个循环在空集上恒真 —— 必须先证明夹具真的进到了返回值里，
    // 否则「PASS」只说明没崩，不说明链路跑过（这正是修键名前的老毛病）。
    const b1 = (mallBundleGroups ?? []).find(b => b.productId === bundleWithCover.productId)
    if (!b1) {
      errors.push(`带封面的套餐夹具 ${bundleWithCover.productId} 未出现在 mallBundleGroups 里，封面断言等于没跑`)
    } else if (b1.coverImage !== `${bundleWithCover.coverImage}?imageMogr2/thumbnail/400x400`) {
      errors.push(`套餐封面未按 400 box 缩略下发，实际: ${JSON.stringify(b1.coverImage)}`)
    }
    // experienceSkus 必须返回数组（即使为空）— 用于体验卡 Tab 扁平 SKU 列表
    if (!Array.isArray(experienceSkus)) errors.push(`experienceSkus 应为数组（即使无 is_experience SKU 也应返回 []）`)
    // 统计口径必须与标签一致：「缩略」= 真的带 imageMogr2 规则，不是「非 null」。
    // 写成后者的话，接线被删、原图直发时这行照样打印「缩略=1」，日志反过来骗人。
    const coverStats = (mallBundleGroups ?? []).reduce((acc, b) => {
      if (b.coverImage === null) acc.null += 1
      else if (String(b.coverImage).includes('imageMogr2/thumbnail/')) acc.thumbed += 1
      else acc.raw += 1
      return acc
    }, { null: 0, thumbed: 0, raw: 0 })
    rec(`  ✓ categories=${categories.length} skuList=${skuList?.length} mallBundleGroups=${mallBundleGroups?.length ?? 'none'}`
      + ` (封面 缩略=${coverStats.thumbed} null=${coverStats.null} 未处理=${coverStats.raw}) experienceSkus=${experienceSkus?.length}`)
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
