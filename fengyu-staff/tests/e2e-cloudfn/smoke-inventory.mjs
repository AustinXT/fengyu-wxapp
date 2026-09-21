#!/usr/bin/env bun
/**
 * inventory.docList / inventory.docDetail 冒烟（门店库存单据只读，店长视角）
 *
 * 覆盖员工端实际使用的 v3 单据接口，而不是已保留的旧 inventory.list/detail 兼容路由。
 * 夹具构造一张已完成的“院入库”单，验证店长按库存主体可见、无效单据类型被拒绝，
 * 以及详情能够返回 v3 单据头和批次明细。
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

const INV_DOC_ID = `${NS}_INV_PROC_1`
const INV_SKU_ID = `${NS}_INV_SKU_1`

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function createInventoryFixture() {
  await pgQuery(
    `INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id)
     SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id
       FROM stores s
       LEFT JOIN org_nodes o ON o.id = s.org_node_id
      WHERE s.store_id = $1
     ON CONFLICT (location_id) DO UPDATE
       SET location_type = EXCLUDED.location_type,
           name = EXCLUDED.name,
           org_node_id = EXCLUDED.org_node_id,
           store_id = EXCLUDED.store_id,
           parent_location_id = EXCLUDED.parent_location_id,
           updated_at = NOW()`,
    [TEST_STORE_ID],
  )
  await pgQuery(
    `INSERT INTO inventory_skus (sku_id, product_code, product_name, spec_name, retail_price, is_active)
     VALUES ($1, $2, $3, '默认规格', 100, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET product_code = EXCLUDED.product_code,
           product_name = EXCLUDED.product_name,
           spec_name = EXCLUDED.spec_name,
           retail_price = EXCLUDED.retail_price,
           is_active = true,
           updated_at = NOW()`,
    [INV_SKU_ID, `${NS}_PCODE_1`, `${NS}_采购商品`],
  )
  const lots = await pgQuery(
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, spec_name, batch_no, expiry_date_key,
       is_gift, quantity_on_hand, store_standard_unit_price, store_actual_unit_price
     )
     VALUES ($1, $2, $2 || '|INV||||100', $3, '默认规格', 'INV', '', false, 5, 100, 100)
     ON CONFLICT (location_id, lot_key)
     DO UPDATE SET quantity_on_hand = 5,
                   sku_name = EXCLUDED.sku_name,
                   spec_name = EXCLUDED.spec_name,
                   updated_at = NOW()
     RETURNING id`,
    [TEST_STORE_ID, INV_SKU_ID, `${NS}_采购商品`],
  )
  const lotId = lots[0]?.id
  await pgQuery(
    `INSERT INTO inventory_docs (
       id, doc_type, status, target_org_node_id, doc_date, total_quantity,
       remark, created_by, confirmed_by, confirmed_at
     )
     VALUES ($1, '院入库', '已完成', $2, CURRENT_DATE, 5, $3, $4, $4, NOW())
     ON CONFLICT (id) DO UPDATE
       SET target_org_node_id = EXCLUDED.target_org_node_id,
           total_quantity = EXCLUDED.total_quantity,
           status = EXCLUDED.status,
           updated_at = NOW()`,
    [INV_DOC_ID, TEST_STORE_ORG_ID, `${NS}_采购备注`, TEST_MANAGER_EMP_ID],
  )
  await pgQuery(
    `INSERT INTO inventory_doc_items (
       doc_id, lot_id, sku_id, sku_name, spec_name, batch_no, is_gift,
       quantity, stock_snapshot, standard_unit_price, actual_unit_price, amount
     )
     SELECT $1, $2, $3, $4, '默认规格', 'INV', false, 5, 0, 100, 100, 500
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_doc_items WHERE doc_id = $1 AND sku_id = $3
      )`,
    [INV_DOC_ID, lotId, INV_SKU_ID, `${NS}_采购商品`],
  )
}

async function main() {
  rec('[smoke-inventory] start')
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createInventoryFixture()

  const errors = []
  const rList = await invokeStaffApi('inventory.docList', {
    _testOpenid: TEST_MANAGER_OPENID,
    docType: '院入库',
    page: 1,
    pageSize: 20,
  })
  if (rList.code !== 0) {
    errors.push(`inventory.docList code=${rList.code} msg=${rList.message}`)
  } else {
    const items = rList.data?.items || []
    const found = items.find((item) => item.id === INV_DOC_ID)
    if (!found) {
      errors.push(`inventory.docList 应含本店单据 ${INV_DOC_ID}，实际 ${items.length} 项`)
    } else {
      if (found.targetOrgNodeId !== TEST_STORE_ORG_ID) {
        errors.push(`list.targetOrgNodeId=${found.targetOrgNodeId}，期望 ${TEST_STORE_ORG_ID}`)
      }
      if (found.docType !== '院入库') errors.push(`list.docType=${found.docType}，期望 院入库`)
      if (found.status !== '已完成') errors.push(`list.status=${found.status}，期望 已完成`)
      if (errors.length === 0) rec(`  ✓ inventory.docList 含本店 v3 单据（接收主体=${found.targetOrgNodeName}）`)
    }
  }

  const rBad = await invokeStaffApi('inventory.docList', {
    _testOpenid: TEST_MANAGER_OPENID,
    docType: 'not_a_doc_type',
  })
  if (rBad.code !== -400) {
    errors.push(`非法 docType 期望 code=-400，实际 code=${rBad.code} msg=${rBad.message}`)
  } else {
    rec('  ✓ inventory.docList 非法 docType → INVALID_PARAMS')
  }

  const rDetail = await invokeStaffApi('inventory.docDetail', {
    _testOpenid: TEST_MANAGER_OPENID,
    id: INV_DOC_ID,
  })
  if (rDetail.code !== 0) {
    errors.push(`inventory.docDetail code=${rDetail.code} msg=${rDetail.message}`)
  } else {
    const detail = rDetail.data || {}
    if (detail.id !== INV_DOC_ID) errors.push(`detail.id=${detail.id}，期望 ${INV_DOC_ID}`)
    if (detail.targetOrgNodeId !== TEST_STORE_ORG_ID) {
      errors.push(`detail.targetOrgNodeId=${detail.targetOrgNodeId}，期望 ${TEST_STORE_ORG_ID}`)
    }
    const item = (detail.items || []).find((row) => row.skuId === INV_SKU_ID)
    if (!item) {
      errors.push(`detail.items 应含 ${INV_SKU_ID}`)
    } else if (Number(item.quantity) !== 5) {
      errors.push(`detail.items 数量=${item.quantity}，期望 5`)
    }
    if (errors.length === 0) rec(`  ✓ inventory.docDetail 返回单据头 + ${(detail.items || []).length} 行 v3 明细`)
  }

  if (errors.length) {
    rec('  ✗ FAIL')
    for (const error of errors) rec(`    - ${error}`)
    return
  }
  pass = true
  exitCode = 0
  rec('  ✅ PASS')
}

try {
  await main()
} catch (error) {
  console.error('EXCEPTION:', error.message)
} finally {
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
