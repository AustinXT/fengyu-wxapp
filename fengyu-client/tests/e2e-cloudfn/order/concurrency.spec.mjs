#!/usr/bin/env bun
/**
 * clientApi.order.create 并发与序号守卫
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - line 432: pg_advisory_xact_lock(hashtext('sale_order_id_gen')) — 全局序号锁
 *   - line 492-502: SELECT ... LIKE 'FY-XSD-WX-{YYMMDD}%' DESC LIMIT 1 → seq+1 → padStart(4,'0')
 *
 * 关键发现/约束：
 *   - 序号是"按日"全局共享（跨 store 不独立）；advisory lock 是全局 `sale_order_id_gen` 名义锁
 *   - 同一顾客存在 '待支付' 订单时无法 create（uq_sale_orders_client_pending）→ 并发必须用 N 个独立顾客
 *   - 序号 9999 → 10000 时 padStart(4) 实际产出 5 位（'10000'），下一次 LIKE+DESC 排序会按文本逆序，
 *     '...9999' 文本大于 '...10000'（'9'>'1'），将再次回到 10000 → PK 冲突。本 spec 把"溢出"作为
 *     文档化用例，断言至少能产出 1 张 10000 号订单（不强求第二张），同时验证非溢出区段正常。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery, getPool,
  TEST_STORE_ID, TEST_SKU_NORMAL_ID, TEST_PRODUCT_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { ensureTestStore, cleanupTestData } from '../helpers/fixtures.mjs'
import { createTestSku, cleanupClientExtras } from '../helpers/client-fixtures.mjs'

/**
 * 批量创建测试顾客（手机号绑定 + 已绑 store）。返回 [{userId, openid}, ...]
 */
async function createNClients(n, { storeId = TEST_STORE_ID } = {}) {
  await ensureTestStore()
  const arr = []
  for (let i = 0; i < n; i++) {
    const userId = `${NS}_CCL_${i}`
    const openid = `${NS}_CCL_OP_${i}`
    const phone = `1999909${String(8000 + i).padStart(4, '0')}`
    await pgQuery(
      `INSERT INTO client_wechat_users (
         user_id, openid, phone, name, gender, bound_store_id,
         customer_type, spending_tier, points_balance
       )
       VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
       ON CONFLICT (user_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
             bound_store_id = EXCLUDED.bound_store_id`,
      [userId, openid, phone, `${NS}_并发${i}`, storeId]
    )
    arr.push({ userId, openid })
  }
  return arr
}

function todayPrefix() {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  return `FY-XSD-WX-${d}`
}

function parseSeq(saleOrderId) {
  // 4 位常态：tail = saleOrderId.slice(-4)；溢出场景 tail 可能是 5 位
  const prefix = todayPrefix()
  if (!saleOrderId.startsWith(prefix)) {
    throw new Error(`unexpected prefix: ${saleOrderId}`)
  }
  return Number(saleOrderId.slice(prefix.length))
}

async function caseConcurrentRapidFire() {
  const N = 5
  const clients = await createNClients(N)
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '100.00' })

  // 并发触发 N 个 order.create — 每个顾客 1 张
  const results = await Promise.all(
    clients.map(c =>
      invokeAs(c.openid, 'order.create', {
        storeId: TEST_STORE_ID,
        items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
        paymentMethod: '微信',
      })
    )
  )

  for (const r of results) {
    if (r.code !== 0) {
      throw new Error(`concurrent create failed: code=${r.code} ${r.message}`)
    }
  }
  const orderNos = results.map(r => r.data.saleOrderId)
  const unique = new Set(orderNos)
  if (unique.size !== N) {
    throw new Error(`expect ${N} distinct order_ids, got ${unique.size}: ${[...unique].join(',')}`)
  }
  const seqs = orderNos.map(parseSeq).sort((a, b) => a - b)
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      throw new Error(`sequence gap: ${seqs.join(',')}`)
    }
  }
}

async function caseCrossStoreSharedSequence() {
  // 同一天两个 store_id —— advisory lock 是全局名义锁，序号也是全局按日，
  // 所以两个 store 各创一张应当拿到连续的 seq。
  const STORE_B_ID = `${NS}_STORE_B`
  const STORE_B_ORG = `${NS}_STORE_B_ORG`
  await ensureTestStore() // 建出主 store + 父级 org
  // 同 market 下挂第二个 store
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店',
       (SELECT id FROM org_nodes WHERE id = $3),
       1, true)
     ON CONFLICT (id) DO NOTHING`,
    [STORE_B_ORG, `${NS}_测试店B`, `${NS}_MARKET_ORG`]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [STORE_B_ID, `${NS}_测试店B`, STORE_B_ORG]
  )

  const [c1, c2] = await createNClients(2)
  // 把 c2 绑到 STORE_B
  await pgQuery(`UPDATE client_wechat_users SET bound_store_id = $1 WHERE user_id = $2`,
    [STORE_B_ID, c2.userId])

  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '100.00' })

  const r1 = await invokeAs(c1.openid, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  const r2 = await invokeAs(c2.openid, 'order.create', {
    storeId: STORE_B_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (r1.code !== 0) throw new Error(`r1 failed: ${r1.message}`)
  if (r2.code !== 0) throw new Error(`r2 failed: ${r2.message}`)

  const s1 = parseSeq(r1.data.saleOrderId)
  const s2 = parseSeq(r2.data.saleOrderId)
  if (Math.abs(s1 - s2) !== 1) {
    throw new Error(`expect cross-store sequence diff=1, got s1=${s1} s2=${s2}`)
  }
}

async function caseHighSeqRollsToFiveDigits() {
  // 文档化用例：手动种下 seq=9999 → 下一张 create 应生成 5 位 seq（'10000'）
  // 注：此后再 create 会因 LIKE+DESC 文本排序回到 10000 触发 PK 冲突；本 case 只验首张产出。
  //
  // 重要：seed 订单的 client_user_id **必须**指向命名空间内顾客 (TE2L2_CCL_0)，
  // 否则 cleanupClientExtras / cleanupTestData 按命名空间清理时会漏掉这一行，
  // 导致 9999 + 10000 永久污染 FY-XSD-WX-{today} 序列，破坏所有后续 order/create 测试。
  const [c1] = await createNClients(1)
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '100.00' })

  const seedOrderId = `${todayPrefix()}9999`
  // 先清理可能残留的同前缀污染（前次 run 异常退出留下的）
  const todayLike = `${todayPrefix()}%`
  await pgQuery(
    `DELETE FROM sale_items WHERE sale_order_id LIKE $1 AND sale_order_id ~ '[0-9]{5}$'`,
    [todayLike]
  )
  await pgQuery(
    `DELETE FROM sale_orders WHERE sale_order_id LIKE $1 AND sale_order_id ~ '[0-9]{5}$'`,
    [todayLike]
  )

  // 种 9999：client_user_id 绑到 TE2L2_CCL_0 让命名空间 cleanup 能回收
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received, payment_method,
       allocation_status
     )
     VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
             NOW(), $5, NULL, $4,
             1, 0, 1, 1, '微信'::payment_method,
             '待分配'::allocation_status)
     ON CONFLICT (sale_order_id) DO NOTHING`,
    [seedOrderId, `${NS}_市场`, TEST_STORE_ID, `${NS}_种子`, c1.userId]
  )

  const r = await invokeAs(c1.openid, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (r.code !== 0) throw new Error(`expect overflow create to succeed, got: ${r.message}`)
  const seq = parseSeq(r.data.saleOrderId)
  if (seq !== 10000) {
    throw new Error(`expect seq=10000 after seed 9999, got ${seq} (order=${r.data.saleOrderId})`)
  }
}

const CASES = [
  ['5 concurrent creates (distinct users, same store) → 5 unique consecutive seqs', caseConcurrentRapidFire],
  ['cross-store creates share a single daily sequence', caseCrossStoreSharedSequence],
  ['seq 9999 seed → next create produces 5-digit seq=10000 (documented overflow)', caseHighSeqRollsToFiveDigits],
]

let pass = 0, fail = 0
console.log(`[order/concurrency.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/concurrency.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
