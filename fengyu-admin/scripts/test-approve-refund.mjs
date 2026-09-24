import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'

const connectionString = 'postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp'
const client = postgres(connectionString, { max: 2 })
const db = drizzle(client)

async function testApproveRefund() {
  const now = new Date()
  const nowIso = now.toISOString()  // Fix: use ISO string not Date object
  const REAL_SKU_ID = 'c2bf48ea9449996b'
  
  try {
    console.log('=== Creating test data ===')
    
    await db.execute(sql`
      INSERT INTO sale_orders (sale_order_id, status, sale_order_type, market_name, store_id, 
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by, prepaid_card_amount, paid_amount, payable_amount)
      VALUES ('FY-XSD-WX-TEST9001', '已支付', '销售单', '南昌市场', 'store-nc01',
        NOW(), 'FY-FIX-CLIENT-01', '13800138000', '测试顾客',
        200.00, '线下', 'FY-TEST-MGR', 0, 200, 200)
    `)
    
    await db.execute(sql`
      INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
        product_name, session_count, remaining_sessions, unit_price, quantity,
        unit_real_price, sale_amount, received, sales_category, service_fee, sku_id)
      VALUES ('XSLSH-WX-TEST0001', 'FY-XSD-WX-TEST9001', 'store-nc01', '购买',
        '安吉丽面膜', 1, 1, '100', 1, '100', '100', '100', '自销自耗', '0', ${REAL_SKU_ID})
    `)
    
    await db.execute(sql`
      INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, 
        status, source_end, operator_employee_id, note)
      VALUES ('FY-XSD-WX-TEST9001', '首次支付', 200.00, '线下', '已支付', 'admin', 'FY-TEST-MGR', 'test')
    `)
    
    await db.execute(sql`
      INSERT INTO sale_orders (sale_order_id, status, sale_order_type, ref_sale_order_id,
        market_name, store_id, sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by, prepaid_card_amount, paid_amount, payable_amount, refund_reason)
      VALUES ('FY-TKD-WX-TEST9001', '待审批', '退款单', 'FY-XSD-WX-TEST9001',
        '南昌市场', 'store-nc01', NOW(), 'FY-FIX-CLIENT-01', '13800138000', '测试顾客',
        -100.00, '线下', 'FY-TEST-FIN', 0, 0, 0, '测试退款原因')
    `)
    
    await db.execute(sql`
      INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
        ref_sale_item_id, product_name, session_count,
        unit_price, quantity, unit_real_price, sale_amount, received, sales_category, service_fee, sku_id)
      VALUES ('XSLSH-WX-TEST0002', 'FY-TKD-WX-TEST9001', 'store-nc01', '退出',
        'XSLSH-WX-TEST0001', '安吉丽面膜', 1,
        '100', 1, '100', '-100', '-100', '自销自耗', '0', ${REAL_SKU_ID})
    `)
    
    await db.execute(sql`
      INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method,
        status, source_end, operator_employee_id, note)
      VALUES ('FY-XSD-WX-TEST9001', '退款', -100.00, '线下', '待支付', 'admin', 'FY-TEST-FIN',
        'FY-TKD=FY-TKD-WX-TEST9001; reason=测试')
    `)
    
    console.log('Test data created OK')
    
    console.log('\n=== Running approve transaction (with ISO date fix) ===')
    
    await db.transaction(async (tx) => {
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
           SET status = '已支付', paid_at = ${nowIso}, approved_by = 'FY-TEST-ADM',
               approved_at = ${nowIso}, allocation_status = '待分配',
               prepaid_card_amount = '0'::numeric,
               paid_amount = '-100'::numeric,
               updated_at = ${nowIso}
         WHERE sale_order_id = 'FY-TKD-WX-TEST9001' AND status = '待审批'
      `)
      console.log(`  step1 rowCount: ${updRes.rowCount}`)
      if (updRes.rowCount === 0) throw new Error('CONCURRENT_CHANGED')
      
      const refundItemRows = await tx.execute(sql`
        SELECT sale_item_id, ref_sale_item_id, quantity, session_count
        FROM sale_items WHERE sale_order_id = 'FY-TKD-WX-TEST9001' AND item_direction = '退出'
      `)
      console.log(`  step2 items: ${refundItemRows.length}`)
      
      for (const ri of refundItemRows) {
        if (ri.ref_sale_item_id && ri.session_count) {
          const sessRes = await tx.execute(sql`
            UPDATE sale_items
               SET remaining_sessions = remaining_sessions - ${ri.quantity},
                   updated_at = ${nowIso}
             WHERE sale_item_id = ${ri.ref_sale_item_id} AND remaining_sessions >= ${ri.quantity}
          `)
          console.log(`  step3 sessRes.rowCount: ${sessRes.rowCount}`)
          if (sessRes.rowCount === 0) throw new Error('INSUFFICIENT_SESSIONS')
        }
      }
      
      await tx.execute(sql`
        UPDATE sale_order_payments
           SET status = '已支付', paid_at = ${nowIso}
         WHERE sale_order_id = 'FY-XSD-WX-TEST9001'
           AND change_type = '退款' AND status = '待支付'
           AND note LIKE ${'FY-TKD=FY-TKD-WX-TEST9001' + '%'}
      `)
      console.log('  step4 payments updated')
      
      const sumRes = await tx.execute(sql`
        SELECT COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','退款')
                                  THEN amount::numeric ELSE 0 END), 0) AS new_paid
        FROM sale_order_payments WHERE sale_order_id = 'FY-XSD-WX-TEST9001'
      `)
      const newPaid = Math.round(Number(sumRes[0]?.new_paid || 0) * 100) / 100
      await tx.execute(sql`
        UPDATE sale_orders SET paid_amount = ${newPaid.toFixed(2)}::numeric, updated_at = ${nowIso}
        WHERE sale_order_id = 'FY-XSD-WX-TEST9001'
      `)
      console.log(`  step5 newPaid: ${newPaid}`)
      
      // refreshSpendingTierTx
      let threshold = 1990
      const cfgRows = await tx.execute(sql`SELECT value FROM system_configs WHERE key = 'new_member_threshold' LIMIT 1`)
      const first = cfgRows[0]
      if (first?.value != null) {
        const v = Number(first.value)
        if (Number.isFinite(v) && v > 0) threshold = v
      }
      
      await tx.execute(sql`
        UPDATE client_wechat_users
           SET spending_tier = CASE
             WHEN t.total >= 100000 THEN '10W+'
             WHEN t.total >= 60000  THEN '6-10W'
             WHEN t.total >= 30000  THEN '3-6W'
             WHEN t.total >= 10000  THEN '1-3W'
             WHEN t.total >= ${threshold} THEN '1990-1W'
             ELSE '<1990'
           END::spending_tier,
           updated_at = NOW()
           FROM (SELECT COALESCE(SUM(total_amount), 0) AS total FROM sale_orders
                 WHERE client_user_id = 'FY-FIX-CLIENT-01' AND status IN ('已支付', '已完成')) t
         WHERE user_id = 'FY-FIX-CLIENT-01'
      `)
      console.log('  step6 spending_tier updated')
    })
    
    console.log('\n✅ TRANSACTION SUCCEEDED!')
    
    const [result] = await db.execute(sql`
      SELECT sale_order_id, status, approved_by FROM sale_orders WHERE sale_order_id = 'FY-TKD-WX-TEST9001'
    `)
    console.log('Final state:', result)
    
  } catch (err) {
    console.error('\n❌ ERROR:', err?.message)
    if (err?.cause) console.error('   Cause:', err.cause?.message || err.cause)
  } finally {
    try {
      await db.execute(sql`DELETE FROM sale_order_payments WHERE sale_order_id IN ('FY-XSD-WX-TEST9001','FY-TKD-WX-TEST9001')`)
      await db.execute(sql`DELETE FROM sale_items WHERE sale_order_id IN ('FY-XSD-WX-TEST9001','FY-TKD-WX-TEST9001')`)
      await db.execute(sql`DELETE FROM sale_orders WHERE sale_order_id IN ('FY-XSD-WX-TEST9001','FY-TKD-WX-TEST9001')`)
      console.log('\nCleanup done')
    } catch (e) {
      console.error('Cleanup error:', e.message)
    }
    await client.end()
  }
}

testApproveRefund()
