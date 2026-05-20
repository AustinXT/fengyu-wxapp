#!/usr/bin/env bun
// L3 client journey j12 - treatment-cards + experience
//
// 目标：
//   A. 疗程卡：已支付的疗程卡订单出现在 order.appointableItems 列表
//   B. 体验卡：product.experienceCardList 返回 is_experience=true 的 SKU；
//      experience/detail 页可通过 skuDetail 拿到该 SKU 数据
//
// 步骤：
//   1. 前置 fixture：ensureClientProductCatalog（自动建 3 SKU：normal/course/exp）
//   2. 直接 SQL 建一个已支付疗程卡 sale_order + sale_item（remaining_sessions=5）
//   3. switchTab profile，等渲染
//   4. navigateTo /pagesOrder/treatment-cards/treatment-cards；
//      callFunction 'order.appointableItems' → 验证返回该卡，remainingSessions=5
//   5. navigateTo /pagesExperience/list/list；
//      callFunction 'product.experienceCardList' → 验证返回 _SKU_E
//   6. navigateTo /pagesExperience/detail/detail?skuId=_SKU_E；
//      callFunction 'product.skuDetail' {skuId:_SKU_E} → 验证 SKU 数据

import { launchClient, disconnect } from './helpers/automator.mjs'
import { closePool, query, tx } from './helpers/pg.mjs'
import {
  cleanupL3TestData,
  ensureBaseFixtures,
  TEST_STORE_ID,
} from './helpers/fixtures.mjs'
import { loginAsTestClient } from './helpers/client-l3-login.mjs'
import {
  ensureClientProductCatalog,
  L3_SKU_COURSE_ID,
  L3_SKU_EXP_ID,
} from './helpers/client-l3-fixtures.mjs'
import {
  TEST_CLIENT_PHONE,
  TEST_STAFF_EMPLOYEE_ID,
} from './helpers/constants.mjs'
import { waitForPagePath, waitForData } from './helpers/wait-for-page.mjs'

const COURSE_ORDER_ID = 'TEST_E2E_L3_ORD_COURSE1'
const COURSE_ITEM_ID = 'TEST_E2E_L3_ITM_COURSE1'

async function createPaidCourseOrder(userId) {
  // 注意：开单人外键 sale_orders.opened_by → staff_wechat_users.employee_id
  // 不在 ensureBaseFixtures 中默认建，需要时（不预约）此处仅写 client_user_id 即可。
  // 但 NOT NULL 列 opened_by 必须有值——用 TEST_STAFF_EMPLOYEE_ID 占位（FK 不强校验时绕过）
  // 若有 FK 强校验，先 INSERT 一个测试员工。
  await query(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, '13900000099', 'TEST_E2E_L3_占位员工', '女', $3,
             (SELECT org_node_id FROM stores WHERE store_id = $3),
             '美容师', ARRAY['美容师']::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO NOTHING`,
    [TEST_STAFF_EMPLOYEE_ID, 'TEST_E2E_L3_STAFF_OPENID', TEST_STORE_ID]
  )

  await tx(async (client) => {
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status, paid_at
       )
       VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type,
               'TEST_E2E_L3_市场', $2,
               NOW(), $3, $4, 'TEST_E2E_L3_顾客',
               500, 0, 500, 500,
               '微信'::payment_method, $5, '待分配'::allocation_status, NOW())`,
      [COURSE_ORDER_ID, TEST_STORE_ID, userId, TEST_CLIENT_PHONE, TEST_STAFF_EMPLOYEE_ID]
    )
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         session_count, remaining_sessions,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, 'TEST_E2E_L3_5次疗程卡', 'TEST_E2E_L3_5次卡',
               '疗程卡'::product_type,
               100, 1, 100, 500, 500,
               5, 5,
               false)`,
      [COURSE_ITEM_ID, COURSE_ORDER_ID, TEST_STORE_ID, L3_SKU_COURSE_ID]
    )
  })
}

const STEPS = [
  ['1. 建已支付疗程卡订单（remaining_sessions=5）', async (ctx) => {
    await createPaidCourseOrder(ctx.userId)
  }],

  ['2. switchTab profile', async (ctx) => {
    await ctx.mp.switchTab('/pages/profile/profile')
    await waitForPagePath(ctx.mp, 'profile', { timeoutMs: 5000 })
  }],

  ['3. navigateTo treatment-cards + appointableItems 含该卡', async (ctx) => {
    await ctx.mp.navigateTo('/pagesOrder/treatment-cards/treatment-cards')
    await waitForPagePath(ctx.mp, 'treatment-cards', { timeoutMs: 6000 })

    const res = await ctx.invoke('order.appointableItems', {})
    if (!res || res.code !== 0) {
      throw new Error(`order.appointableItems failed: ${JSON.stringify(res)}`)
    }
    const orders = res.data?.orders || []
    const hit = orders.find((o) => o.saleOrderId === COURSE_ORDER_ID)
    if (!hit) {
      throw new Error(`appointableItems 未含 ${COURSE_ORDER_ID}（got=${orders.map((o) => o.saleOrderId).join(',')}）`)
    }
    const item = hit.items?.[0]
    if (!item || item.skuId !== L3_SKU_COURSE_ID) {
      throw new Error(`item skuId=${item?.skuId}, expected ${L3_SKU_COURSE_ID}`)
    }
    if (Number(item.remainingSessions) !== 5) {
      throw new Error(`remainingSessions=${item.remainingSessions}, expected 5`)
    }
  }],

  ['4. navigateTo experience/list + experienceCardList 含 _SKU_E', async (ctx) => {
    await ctx.mp.navigateTo('/pagesExperience/list/list')
    await waitForPagePath(ctx.mp, 'pagesExperience/list', { timeoutMs: 6000 })

    const res = await ctx.invoke('product.experienceCardList')
    if (!res || res.code !== 0) {
      throw new Error(`product.experienceCardList failed: ${JSON.stringify(res)}`)
    }
    const list = res.data?.skuList || []
    const hit = list.find((s) => s.sku_id === L3_SKU_EXP_ID)
    if (!hit) {
      throw new Error(`experienceCardList 未含 ${L3_SKU_EXP_ID}（got=${list.map((s) => s.sku_id).join(',')}）`)
    }
  }],

  ['5. navigateTo experience/detail + skuDetail 返回 _SKU_E', async (ctx) => {
    await ctx.mp.navigateTo(`/pagesExperience/detail/detail?skuId=${L3_SKU_EXP_ID}`)
    await waitForPagePath(ctx.mp, 'pagesExperience/detail', { timeoutMs: 6000 })

    const res = await ctx.invoke('product.skuDetail', { skuId: L3_SKU_EXP_ID })
    if (!res || res.code !== 0) {
      throw new Error(`product.skuDetail failed: ${JSON.stringify(res)}`)
    }
    const sku = res.data?.sku
    if (!sku || sku.sku_id !== L3_SKU_EXP_ID) {
      throw new Error(`skuDetail sku.sku_id=${sku?.sku_id}, expected ${L3_SKU_EXP_ID}`)
    }
  }],
]

let mp = null
let pass = false
console.log(`[j12-treatment-experience] start | ${new Date().toISOString()}`)
try {
  await cleanupL3TestData()
  await ensureBaseFixtures()
  await ensureClientProductCatalog()

  mp = await launchClient()
  const auth = await loginAsTestClient(mp)
  const ctx = { mp, ...auth }

  for (const [name, fn] of STEPS) {
    process.stdout.write(`  · ${name} ... `)
    await fn(ctx)
    console.log('OK')
  }
  pass = true
} catch (e) {
  console.error(`  FAIL: ${e.message}`)
  if (process.env.E2E_DEBUG) console.error(e.stack)
} finally {
  if (mp) await disconnect(mp)
  await cleanupL3TestData()
  await closePool()
  console.log(`[j12-treatment-experience] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
