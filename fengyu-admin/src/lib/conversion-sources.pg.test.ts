import { describe, it, expect } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { initializeConversionSources, recordConversionRefundSources, conversionSourceQuery } from './conversion-sources'
import { settlePointsForOrder } from './points-settle'
const run = process.env.ISSUE548_PG_URL ? describe : describe.skip
run('#548 admin真实PG来源、积分与参数绑定', () => {
  it('800折抵+200补款全退，本单冲销10点且原单后续不复发', async () => {
    const url = new URL(process.env.ISSUE548_PG_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('仅私有PG')
    const connection = postgres(url.toString(), { max: 1 })
    const privateDb = drizzle(connection)
    const rollback = new Error('test-rollback')
    try {
      await privateDb.transaction(async tx => {
        await tx.execute(sql`INSERT INTO org_nodes(id,name,type) VALUES('H548A','测试总部','总部')`)
        await tx.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES('M548A','测试市场','市场','H548A')`)
        await tx.execute(sql`INSERT INTO org_nodes(id,name,type,parent_id) VALUES('S548A','测试门店','门店','M548A')`)
        await tx.execute(sql`INSERT INTO stores(store_id,store_name,org_node_id) VALUES('T548A','测试','S548A')`)
        await tx.execute(sql`INSERT INTO client_wechat_users(user_id) VALUES('T548A')`)
        for (const [id,type,total,received] of [['O548A','销售单',800,800],['C548A','转换单',200,200]] as const) {
          await tx.execute(sql`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,total_amount,payment_method,received,status,sale_order_type,client_user_id)
            VALUES(${id},'测试','T548A',NOW(),${total},'线下',${received},'已支付',${type},'T548A')`)
        }
        await tx.execute(sql`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,received,quantity,session_count,remaining_sessions,paid_sessions,product_type,item_direction)
          VALUES('OLD548A','O548A','T548A',800,800,800,800,1,1,0,1,'疗程卡','购买'),('OUT548A','C548A','T548A',800,800,-800,-800,1,1,0,1,'疗程卡','转出'),('IN548A','C548A','T548A',1000,100,1000,1000,1,10,10,10,'疗程卡','转入')`)
        await tx.execute(sql`UPDATE sale_items SET ref_sale_item_id='OLD548A' WHERE sale_item_id='OUT548A'`)
        await tx.execute(sql`INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end) VALUES('C548A','首次支付',200,'线下','已支付','admin')`)
        const query = conversionSourceQuery(tx)
        expect((await settlePointsForOrder(tx,'O548A')).delta).toBe(8)
        await initializeConversionSources(query,'C548A')
        expect((await settlePointsForOrder(tx,'C548A')).delta).toBe(2)
        expect((await query("SELECT conversion_value_snapshot FROM sale_items WHERE sale_item_id=$1",['IN548A']))[0].conversion_value_snapshot.valueCents).toBe(100000)
        const note=JSON.stringify({ conversionRefund:true, items:[{refSaleItemId:'IN548A',refundAmount:1000,paidAmount:1000}] })
        const rows=await query("INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,note,source_end) VALUES($1,'退款',-1000,'线下','已支付',$2,'admin') RETURNING id",['C548A',note])
        expect(await recordConversionRefundSources(query,'C548A',Number(rows[0].id))).toEqual(['C548A'])
        expect((await settlePointsForOrder(tx,'C548A')).delta).toBe(-10)
        expect((await settlePointsForOrder(tx,'O548A')).delta).toBe(0)
        // 来源维护重复调用不再消耗本金。
        expect(await recordConversionRefundSources(query,'C548A',Number(rows[0].id))).toEqual(['C548A'])
        expect(Number((await query('SELECT points_balance FROM client_wechat_users WHERE user_id=$1',['T548A']))[0].points_balance)).toBe(0)
        throw rollback
      })
    } catch (err) { if(err !== rollback) throw err }
    finally { await connection.end() }
  })
})
