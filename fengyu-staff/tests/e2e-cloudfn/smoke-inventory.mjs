#!/usr/bin/env bun
/**
 * inventory.list / inventory.detail 冒烟（门店库存只读，店长视角）
 *
 * 背景：库存域 v1（记忆 inventory-domain-v1）—— 4 类单据
 * procurement / sale / transfer / scrap 迁到 PG，员工端只读，写入入口在 admin。
 * 路由：cloudfunctions/staffApi/routes/inventory.js（list/detail，requireStaffBound）。
 *
 * 选用 procurement（采购入库）作为夹具类目：master 表外键最简单
 *   (store_id→stores, created_by→staff_wechat_users)，二者都由标准夹具
 *   ensureTestStore() + createTestStaff() 提供，无需额外造商品/顾客行。
 *
 * 验证点：
 *   1. inventory.list（docCategory=procurement）→ code=0，items 含本店造的单据
 *      （断言 scope 过滤：店长 scopeStoreIds 含本店 store_id，单据可见 + storeName 回填）。
 *   2. inventory.list 入参校验 → 非法 docCategory 抛 INVALID_PARAMS（code=-400）。
 *   3. inventory.detail（docCategory=procurement, id=该单据）→ code=0，
 *      返回单据头 + items 明细（断言 procurement 特有字段 isCompleted / docSubtype，
 *      items[0].productName/quantity 与造的夹具一致）。
 *
 * 夹具：cleanupTestData(NS) 不覆盖任何 inventory_* 表，故本 smoke 在 finally
 * 自行 DELETE `${NS}_INV_*` 的 procurement order + items（items 有 ON DELETE CASCADE，
 * 但显式删两表更稳妥）。
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

const INV_DOC_ID = `${NS}_INV_PROC_1`

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

/** 造一条采购入库单（master + 1 行 item），store_id=本店、created_by=店长 */
async function createInventoryFixture() {
  await pgQuery(
    `INSERT INTO inventory_procurement_orders (
       id, doc_subtype, status, store_id, doc_date,
       total_quantity, is_completed, remark, created_by
     )
     VALUES ($1, '院入库'::inventory_procurement_subtype, '已完成'::inventory_doc_status,
             $2, CURRENT_DATE, 5, true, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET store_id = EXCLUDED.store_id,
           total_quantity = EXCLUDED.total_quantity,
           is_completed = EXCLUDED.is_completed`,
    [INV_DOC_ID, TEST_STORE_ID, `${NS}_采购备注`, TEST_MANAGER_EMP_ID]
  )
  await pgQuery(
    `INSERT INTO inventory_procurement_order_items (
       order_id, product_code, product_name, spec_name,
       is_gift, quantity, unit_price, amount, request_quantity
     )
     VALUES ($1, $2, $3, '默认规格', false, 5, 100, 500, 5)`,
    [INV_DOC_ID, `${NS}_PCODE_1`, `${NS}_采购商品`]
  )
}

async function deleteInventoryFixture() {
  await pgQuery(`DELETE FROM inventory_procurement_order_items WHERE order_id LIKE $1`, [`${NS}_INV%`])
  await pgQuery(`DELETE FROM inventory_procurement_orders WHERE id LIKE $1 OR store_id LIKE $1`, [`${NS}%`])
}

async function main() {
  rec(`[smoke-inventory] start`)
  await deleteInventoryFixture()
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // manager, openid=TEST_MANAGER_OPENID
  await createInventoryFixture()

  const errors = []

  // ── 1) list：本店可见 ──
  const rList = await invokeStaffApi('inventory.list', {
    _testOpenid: TEST_MANAGER_OPENID,
    docCategory: 'procurement',
    page: 1,
    pageSize: 20,
  })
  if (rList.code !== 0) {
    errors.push(`inventory.list code=${rList.code} msg=${rList.message}`)
  } else {
    const items = rList.data?.items || []
    const found = items.find((i) => i.id === INV_DOC_ID)
    if (!found) {
      errors.push(`inventory.list 应含本店单据 ${INV_DOC_ID}，实际 ${items.length} 项: ${items.map((i) => i.id).join(',')}`)
    } else {
      if (found.storeId !== TEST_STORE_ID) errors.push(`list.storeId=${found.storeId} 期望 ${TEST_STORE_ID}`)
      if (found.docSubtype !== '院入库') errors.push(`list.docSubtype=${found.docSubtype} 期望 院入库`)
      if (found.isCompleted !== true) errors.push(`list.isCompleted=${found.isCompleted} 期望 true`)
      if (errors.length === 0) rec(`  ✓ inventory.list 含本店单据（scope 过滤通过，storeName=${found.storeName}）`)
    }
  }

  // ── 2) list：非法 docCategory → INVALID_PARAMS ──
  const rBad = await invokeStaffApi('inventory.list', {
    _testOpenid: TEST_MANAGER_OPENID,
    docCategory: 'not_a_category',
  })
  if (rBad.code !== -400) errors.push(`非法 docCategory 期望 code=-400，实际 code=${rBad.code} msg=${rBad.message}`)
  else rec(`  ✓ inventory.list 非法 docCategory → INVALID_PARAMS`)

  // ── 3) detail：单据明细 ──
  const rDetail = await invokeStaffApi('inventory.detail', {
    _testOpenid: TEST_MANAGER_OPENID,
    docCategory: 'procurement',
    id: INV_DOC_ID,
  })
  if (rDetail.code !== 0) {
    errors.push(`inventory.detail code=${rDetail.code} msg=${rDetail.message}`)
  } else {
    const d = rDetail.data || {}
    if (d.id !== INV_DOC_ID) errors.push(`detail.id=${d.id} 期望 ${INV_DOC_ID}`)
    if (d.storeId !== TEST_STORE_ID) errors.push(`detail.storeId=${d.storeId} 期望 ${TEST_STORE_ID}`)
    const its = d.items || []
    const it0 = its.find((x) => x.productName === `${NS}_采购商品`)
    if (!it0) errors.push(`detail.items 应含 ${NS}_采购商品，实际 ${its.length} 行`)
    else if (Number(it0.quantity) !== 5) errors.push(`detail.items[0].quantity=${it0.quantity} 期望 5`)
    if (errors.length === 0) rec(`  ✓ inventory.detail 返回单据头 + ${its.length} 行明细`)
  }

  if (errors.length) { rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true; exitCode = 0
  rec(`  ✅ PASS`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally {
  try { await deleteInventoryFixture() } catch {}
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
