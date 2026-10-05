/** admin savePaymentAllocations 真实 PG 路径：同 SKU 双实例、4/5 人与跨标签独立池。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
process.env.ALLOW_TEST_OPENID = 'true'
const { NS, TEST_MANAGER_EMP_ID, TEST_CLIENT_USER_ID, pgQuery, closePool } = await import(path.join(testsDir, 'setup.mjs'))
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING
const { ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder, cleanupTestData } = await import(path.join(testsDir, 'helpers/fixtures.mjs'))
const { savePaymentAllocations, getPaymentAllocatables } = await import(path.resolve(testsDir, '../../src/actions/allocations.ts'))

const saleOrderId = `${NS}_ALLOC_4`
const categoryId = `${NS}_CAT_ALLOC4`
const skuId = `${NS}_SKU_ALLOC4`
const employeeIds = [1, 2, 3, 4, 5].map((i) => `${NS}_ALLOC_E${i}`)
let passed = false

async function cleanup() {
  await pgQuery(`DELETE FROM sale_payment_item_allocations WHERE sale_payment_item_receipt_id IN
    (SELECT id FROM sale_payment_item_receipts WHERE sale_order_id LIKE $1)`, [`${NS}%`])
  await pgQuery('DELETE FROM sale_payment_item_receipts WHERE sale_order_id LIKE $1', [`${NS}%`])
  await cleanupTestData(NS)
  await pgQuery('DELETE FROM product_skus WHERE sku_id = $1', [skuId])
  await pgQuery('DELETE FROM product_categories WHERE category_id = $1', [categoryId])
}

try {
  await cleanup()
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  for (const employeeId of employeeIds) {
    await createTestStaff({ employeeId, openid: `${employeeId}_OPENID`, phone: null, name: employeeId, isManager: false })
    await pgQuery('UPDATE staff_wechat_users SET skills = $2::text[] WHERE employee_id = $1', [employeeId, ['养生师', '美容师']])
  }
  await pgQuery(
    `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, $2, '护理项目', '自销自耗'::sales_category, 0, true)`,
    [categoryId, `${NS}_分配分类`],
  )
  await pgQuery(
    `INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price, session_count)
     VALUES ($1, $2, '疗程卡'::product_type, $3, 100, 1)`,
    [skuId, categoryId, `${NS}_分配商品`],
  )
  const { saleItemId } = await createTestSaleOrder({
    saleOrderId, clientUserId: TEST_CLIENT_USER_ID, totalAmount: 100, status: '已支付',
  })
  const secondSaleItemId = `${saleOrderId}_ITEM_2`
  await pgQuery('UPDATE sale_items SET sku_id = $2, sales_category = $3 WHERE sale_item_id = $1', [saleItemId, skuId, '自销自耗'])
  await pgQuery(
    `INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
       sku_id, product_name, product_type, unit_price, quantity, unit_real_price,
       sale_amount, received, is_experience, sales_category)
     SELECT $2, sale_order_id, store_id, '购买'::item_direction,
       $3, product_name, product_type, 80, 1, 80, 80, 80, false, '自销自耗'::sales_category
       FROM sale_items WHERE sale_item_id = $1`,
    [saleItemId, secondSaleItemId, skuId],
  )
  await pgQuery(
    'UPDATE sale_orders SET total_amount = 180, payable_amount = 180, received = 180 WHERE sale_order_id = $1',
    [saleOrderId],
  )
  const [{ id }] = await pgQuery(
    `INSERT INTO sale_order_payments
      (sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, paid_at, allocation_status, created_at)
     VALUES ($1, '首次支付'::payment_change_type, 180, '线下'::payment_method,
       '已支付'::payment_flow_status, 'admin'::payment_source_end,
       $2, NOW(), '待分配'::allocation_status, NOW()) RETURNING id`,
    [saleOrderId, TEST_MANAGER_EMP_ID],
  )
  const salePaymentId = id
  await pgQuery(
    `INSERT INTO sale_payment_item_receipts
      (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
     VALUES ($1, $2, $3, 100, '自销自耗'::sales_category, NOW()),
            ($1, $2, $4, 80, '自销自耗'::sales_category, NOW())`,
    [salePaymentId, saleOrderId, saleItemId, secondSaleItemId],
  )

  const itemIds = [saleItemId, secondSaleItemId]
  const allocations = itemIds.flatMap((itemId) => employeeIds.slice(0, 4).map((employeeId) => ({
    saleItemId: itemId, employeeId, roleType: '养生师', allocationRatio: '0.250',
  })))
  const saved = await savePaymentAllocations(salePaymentId, allocations)
  assert.equal(saved.success, true, saved.message)
  const rows = await pgQuery(
    `SELECT spir.sale_item_id, spia.employee_id, spia.allocation_ratio, spia.allocated_amount
       FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      WHERE spir.sale_payment_id = $1 AND spia.is_void = false ORDER BY spir.sale_item_id, spia.employee_id`,
    [salePaymentId],
  )
  for (const [itemId, amount] of [[saleItemId, 25], [secondSaleItemId, 20]]) {
    const itemRows = rows.filter((row) => row.sale_item_id === itemId)
    assert.deepEqual(itemRows.map((row) => row.employee_id), employeeIds.slice(0, 4))
    assert.deepEqual(itemRows.map((row) => Number(row.allocation_ratio)), [0.25, 0.25, 0.25, 0.25])
    assert.deepEqual(itemRows.map((row) => Number(row.allocated_amount)), [amount, amount, amount, amount])
  }
  const detail = await getPaymentAllocatables(salePaymentId)
  assert.equal(detail?.existingAllocations?.length, 8)

  const expanded = itemIds.flatMap((itemId) => employeeIds.map((employeeId) => ({
    saleItemId: itemId, employeeId, roleType: '养生师', allocationRatio: '0.200',
  })))
  expanded.push({ saleItemId, employeeId: employeeIds[0], roleType: '美容师', allocationRatio: '1.000' })
  const expandedSaved = await savePaymentAllocations(salePaymentId, expanded)
  assert.equal(expandedSaved.success, true, '同池 5 人且另一技能标签独立 100% 应可保存')
  const expandedDetail = await getPaymentAllocatables(salePaymentId)
  assert.equal(expandedDetail?.existingAllocations?.length, 11)
  assert.equal(expandedDetail.existingAllocations.filter((row) => row.saleItemId === saleItemId && row.roleType === '美容师').length, 1)

  for (const [name, bad] of [
    ['比例超额', allocations.map((row) => row.saleItemId === saleItemId ? { ...row, allocationRatio: '0.300' } : row)],
    ['重复员工', [allocations[0], allocations[0], ...allocations.slice(2)]],
    ['无效比例', [{ ...allocations[0], allocationRatio: '0' }]],
  ]) {
    const rejected = await savePaymentAllocations(salePaymentId, bad)
    assert.equal(rejected.success, false, `${name}应被拒绝`)
  }
  const count = await pgQuery(
    `SELECT count(*)::int AS count FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      WHERE spir.sale_payment_id = $1 AND spia.is_void = false`,
    [salePaymentId],
  )
  assert.equal(count[0].count, 11, '非法请求不得覆盖已保存分配')
  passed = true
  console.log('PASS — admin 真实 PG 同 SKU 双实例各 4/5 人、跨标签独立池及原有校验')
} catch (error) {
  console.error('[smoke-allocation-unlimited] FAIL:', error)
} finally {
  try { await cleanup() } catch (error) { console.error('[cleanup error]', error); passed = false }
  await closePool()
  process.exit(passed ? 0 : 1)
}
