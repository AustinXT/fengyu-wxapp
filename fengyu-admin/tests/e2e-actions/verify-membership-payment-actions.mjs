/** #301 完整收款Action私有PG回归：按journal重放实际迁移，不接共享库/真实渠道。
 * bun --preload ./tests/e2e-actions/_admin-preload.mjs ./tests/e2e-actions/verify-membership-payment-actions.mjs
 * Next会话/权限/审计/cache使用既有preload；资金、receipt、会员标签均由真实Action执行。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const { Client } = require('../../../fengyu-client/cloudfunctions/clientApi/node_modules/pg')
const container = `pg-301-actions-${process.pid}-${randomBytes(3).toString('hex')}`
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim()
let started=false, client, clientPg, staffPg
try {
  docker('run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=verify','-e','POSTGRES_DB=verify','-p','127.0.0.1::5432','postgres:16'); started=true
  let ready=false
  for(let i=0;i<30;i++){try{docker('exec',container,'pg_isready','-U','postgres');ready=true;break}catch{await sleep(1000)}}
  assert.ok(ready)
  const port=docker('port',container,'5432/tcp').split(':').at(-1)
  process.env.E2E_DATABASE_URL=`postgres://postgres:verify@127.0.0.1:${port}/verify`
  client=new Client({connectionString:process.env.E2E_DATABASE_URL});await client.connect()
  const migrationRoot = new URL('../../../db/migrations/',import.meta.url)
  const journal=JSON.parse(readFileSync(new URL('meta/_journal.json',migrationRoot),'utf8'))
  for(const entry of journal.entries){
    const source=readFileSync(new URL(`${entry.tag}.sql`,migrationRoot),'utf8')
    try{await client.query('BEGIN');for(const statement of source.split('--> statement-breakpoint')) if(statement.trim())await client.query(statement);await client.query('COMMIT')}
    catch(error){throw new Error(`private migration ${entry.tag}: ${error.message}`)}
  }
  console.log(`PASS 私有空PG按journal重放${journal.entries.length}条迁移`)
  await client.query(`INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('HQ-TEST','测试总部','总部',NULL),('MARKET-TEST','测试市场','市场','HQ-TEST'),('STORE-NODE-TEST','测试门店','门店','MARKET-TEST');
    INSERT INTO stores(store_id,store_name,org_node_id) VALUES ('TE2A_STORE','测试门店','STORE-NODE-TEST');
    INSERT INTO staff_wechat_users(employee_id,name,store_id,skills) VALUES ('TE2A_MGR','测试店长','TE2A_STORE',ARRAY['美容师']),('EMP-1','人工指定员工','TE2A_STORE',ARRAY['美容师']);
    INSERT INTO client_wechat_users(user_id,openid,name,phone,bound_store_id) VALUES ('CUSTOMER-1','wx-private-301','测试顾客','19999000001','TE2A_STORE');
    INSERT INTO system_configs(key,value) VALUES ('new_member_threshold','500') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO prepaid_cards(card_id,user_id,balance) VALUES ('CARD-1','CUSTOMER-1',1000);`)
  const { confirmOfflinePayment, recordPayment }=await import('../../src/actions/orders.ts')
  const { assignCustomer }=await import('../../src/actions/customers.ts')
  const seed=async(id,total=600,card=300,experience=false)=>{
    await client.query(`INSERT INTO sale_orders(sale_order_id,market_name,store_id,sale_order_datetime,client_user_id,total_amount,payable_amount,pending_prepaid_card_amount,payment_method,opened_by)
      VALUES ($1,'测试市场','TE2A_STORE',NOW(),'CUSTOMER-1',$2,$2::numeric-$3::numeric,$3,'线下','TE2A_MGR')`,[id,total,card])
    await client.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,pending_received,received,is_experience,product_type,sales_category)
      VALUES ($1,$2,'TE2A_STORE',$3,$3,$3,$3,0,$4,'家居产品','自销自耗')`,[`ITEM-${id}`,id,total,experience])
  }
  await seed('ADMIN-NEG')
  const before=(await client.query('SELECT balance FROM prepaid_cards')).rows[0].balance
  const rejected=await confirmOfflinePayment('ADMIN-NEG')
  assert.equal(rejected.success,false); assert.match(rejected.message,/店长分配所属员工/)
  assert.equal((await client.query('SELECT balance FROM prepaid_cards')).rows[0].balance,before)
  assert.equal((await client.query('SELECT count(*) FROM card_transactions')).rows[0].count,'0')
  assert.equal((await client.query('SELECT count(*) FROM sale_order_payments')).rows[0].count,'0')
  assert.equal((await client.query('SELECT count(*) FROM sale_payment_item_receipts')).rows[0].count,'0')
  assert.equal((await client.query('SELECT count(*) FROM point_transactions')).rows[0].count,'0')
  assert.equal((await client.query("SELECT status FROM sale_orders WHERE sale_order_id='ADMIN-NEG'")).rows[0].status,'待支付')
  assert.equal((await client.query('SELECT customer_type FROM client_wechat_users')).rows[0].customer_type,'流量客')
  console.log('PASS 完整admin.confirmOfflinePayment缺绑定拒绝，现金/扣卡/receipt/积分/订单/会员全部回滚')
  const assigned=await assignCustomer('CUSTOMER-1','EMP-1');assert.equal(assigned.success,true,assigned.message)
  const paid=await confirmOfflinePayment('ADMIN-NEG');assert.equal(paid.success,true,paid.message)
  assert.equal(paid.status,'已支付')
  const customer=(await client.query('SELECT customer_type,bound_employee_id,became_member_at FROM client_wechat_users')).rows[0]
  assert.equal(customer.customer_type,'会员客');assert.equal(customer.bound_employee_id,'EMP-1');assert.ok(customer.became_member_at)
  assert.equal(Number((await client.query('SELECT balance FROM prepaid_cards')).rows[0].balance),700)
  assert.equal(Number((await client.query('SELECT SUM(amount) AS amount FROM sale_payment_item_receipts')).rows[0].amount),600)
  assert.equal((await client.query("SELECT is_membership_upgrade FROM sale_orders WHERE sale_order_id='ADMIN-NEG'")).rows[0].is_membership_upgrade,true)
  console.log('PASS 真实assignCustomer→同一完整收款Action→现金+扣卡入账/receipt/首次会员标签/升级单标记，由生产代码完成')
  await client.query("UPDATE client_wechat_users SET customer_type='流量客',became_member_at=NULL,bound_employee_id=NULL,bound_employee_name=NULL; UPDATE sale_orders SET status='已关闭' WHERE sale_order_id='ADMIN-NEG'")
  await seed('ADMIN-PART',600,0)
  const partial=await confirmOfflinePayment('ADMIN-PART',300);assert.equal(partial.success,true,partial.message);assert.equal(partial.status,'部分支付')
  const repay=await recordPayment({saleOrderId:'ADMIN-PART',repayAmount:300,paymentMethod:'线下'})
  assert.equal(repay.success,false); assert.match(repay.error.message,/店长分配所属员工/)
  assert.equal((await client.query("SELECT status FROM sale_orders WHERE sale_order_id='ADMIN-PART'")).rows[0].status,'部分支付')
  assert.equal(Number((await client.query("SELECT received FROM sale_orders WHERE sale_order_id='ADMIN-PART'")).rows[0].received),300)
  console.log('PASS 完整admin部分收款放行，最终recordPayment缺绑定拒绝且保留首笔款')
  // 云函数用真实pg池，只明确注入同一临时库；路由接已认证上下文，真实requireManager/Phone仍执行。
  process.env.PG_CONNECTION_STRING=process.env.E2E_DATABASE_URL
  clientPg=require('../../../fengyu-client/cloudfunctions/clientApi/db/pg.js')
  staffPg=require('../../../fengyu-staff/cloudfunctions/staffApi/db/pg.js')
  const clientRoutes=require('../../../fengyu-client/cloudfunctions/clientApi/routes/order.js')
  const staffRoutes=require('../../../fengyu-staff/cloudfunctions/staffApi/routes/order.js')
  const reset=async()=>client.query("UPDATE client_wechat_users SET customer_type='流量客',became_member_at=NULL,bound_employee_id=NULL,bound_employee_name=NULL,member_level=NULL; UPDATE sale_orders SET status='已关闭'; UPDATE prepaid_cards SET balance=1000")
  const manager={staffWfId:'TE2A_MGR',name:'测试店长',phone:'19999088001',effectiveStoreId:'TE2A_STORE',loginLevel:'store',managerStoreIds:['TE2A_STORE'],roleBindings:[{role:'manager',scopeType:'门店',scopeId:'STORE-NODE-TEST',scopeName:'测试门店',isStoreManager:true}]}
  const counts=async()=>{
    const r=(await client.query(`SELECT (SELECT COUNT(*) FROM sale_order_payments) AS payments,
      (SELECT COUNT(*) FROM card_transactions) AS cards,(SELECT COUNT(*) FROM sale_payment_item_receipts) AS receipts,
      (SELECT COUNT(*) FROM point_transactions) AS points,(SELECT balance FROM prepaid_cards WHERE card_id='CARD-1') AS balance`)).rows[0]
    return r
  }
  await reset();await seed('STAFF-NEG')
  const staffCtx={auth:manager,event:{payload:{saleOrderId:'STAFF-NEG'}},wxContext:{OPENID:'wx-private-staff'},result:null}
  const staffBefore=await counts()
  await assert.rejects(staffRoutes.confirmOffline(staffCtx),/店长分配所属员工/)
  assert.deepEqual(await counts(),staffBefore)
  assert.equal((await client.query("SELECT status FROM sale_orders WHERE sale_order_id='STAFF-NEG'")).rows[0].status,'待支付')
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  await staffRoutes.confirmOffline(staffCtx);assert.equal(staffCtx.result.status,'已支付')
  const staffCustomer=(await client.query('SELECT customer_type,became_member_at,bound_employee_id FROM client_wechat_users')).rows[0]
  assert.equal(staffCustomer.customer_type,'会员客');assert.equal(staffCustomer.bound_employee_id,'EMP-1');assert.ok(staffCustomer.became_member_at)
  assert.equal(Number((await client.query('SELECT balance FROM prepaid_cards')).rows[0].balance),700)
  console.log('PASS 完整staff.confirmOffline缺绑定现金+扣卡回滚，人工分配后真实入会/时间/归属')
  await reset();await seed('CLIENT-NEG',600,600)
  const clientCtx={auth:{userId:'CUSTOMER-1',phone:'19999000001'},event:{payload:{saleOrderId:'CLIENT-NEG'}},wxContext:{OPENID:'wx-private-301'},result:null}
  const clientBefore=await counts()
  await assert.rejects(clientRoutes.confirmPrepaidFull(clientCtx),/店长分配所属员工/)
  assert.deepEqual(await counts(),clientBefore)
  assert.equal((await client.query("SELECT status FROM sale_orders WHERE sale_order_id='CLIENT-NEG'")).rows[0].status,'待支付')
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  await clientRoutes.confirmPrepaidFull(clientCtx)
  const finalCustomer=(await client.query('SELECT customer_type,became_member_at,bound_employee_id FROM client_wechat_users')).rows[0]
  assert.equal(finalCustomer.customer_type,'会员客');assert.equal(finalCustomer.bound_employee_id,'EMP-1');assert.ok(finalCustomer.became_member_at)
  assert.equal(Number((await client.query('SELECT balance FROM prepaid_cards')).rows[0].balance),400)
  assert.equal((await client.query("SELECT is_membership_upgrade FROM sale_orders WHERE sale_order_id='CLIENT-NEG'")).rows[0].is_membership_upgrade,true)
  console.log('PASS 完整client.confirmPrepaidFull缺绑定全卡回滚，人工分配后真实扣卡/会员/升级单标记')

} finally {if(clientPg)await clientPg.getPool().end();if(staffPg)await staffPg.getPool().end();if(client)await client.end();if(globalThis.pgClient)await globalThis.pgClient.end();if(started)docker('stop',container)}
