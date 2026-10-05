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

  // #524：阈值沿用本夹具500，金额1990的边界在九副本SQL夹具中验证。
  const assertMember=async(id, expected='会员客')=>{
    const c=(await client.query('SELECT customer_type,became_member_at FROM client_wechat_users')).rows[0]
    assert.equal(c.customer_type,expected)
    if(expected==='会员客'){
      assert.ok(c.became_member_at)
      const o=(await client.query('SELECT status,paid_at,is_membership_upgrade FROM sale_orders WHERE sale_order_id=$1',[id])).rows[0]
      assert.equal(o.status,'部分支付');assert.equal(o.paid_at,null);assert.equal(o.is_membership_upgrade,true)
      const p=(await client.query("SELECT MAX(paid_at) AS paid_at FROM sale_order_payments WHERE sale_order_id=$1 AND status='已支付'",[id])).rows[0]
      assert.equal(c.became_member_at.toISOString(),p.paid_at.toISOString())
    }
  }
  await reset();await seed('A524-PART',1600,0)
  let a=await confirmOfflinePayment('A524-PART',500);assert.equal(a.success,false);assert.match(a.message,/店长分配/)
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  a=await confirmOfflinePayment('A524-PART',500);assert.equal(a.success,true,a.message);await assertMember('A524-PART')
  console.log('PASS #524 admin部分首次收款即达标，缺绑定整笔回滚、分配后即时入会，时间取实际款项')
  await reset();await seed('A524-REPAY',1600,0)
  a=await confirmOfflinePayment('A524-REPAY',300);assert.equal(a.success,true,a.message);await assertMember('A524-REPAY','小美客')
  let r=await recordPayment({saleOrderId:'A524-REPAY',repayAmount:200,paymentMethod:'线下'});assert.equal(r.success,false);assert.match(r.error.message,/店长分配/)
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  r=await recordPayment({saleOrderId:'A524-REPAY',repayAmount:200,paymentMethod:'线下'});assert.equal(r.success,true,JSON.stringify(r));await assertMember('A524-REPAY')
  console.log('PASS #524 admin同单300+200仍欠款，在第二笔实际入账时入会')
  await reset();await seed('S524-PART',1600,0)
  const partialCtx={auth:manager,event:{payload:{saleOrderId:'S524-PART',confirmAmount:500}},wxContext:{OPENID:'wx-private-staff'},result:null}
  await assert.rejects(staffRoutes.confirmOffline(partialCtx),/店长分配/)
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  await staffRoutes.confirmOffline(partialCtx);await assertMember('S524-PART')
  console.log('PASS #524 staff部分收款门禁与即时入会')
  const conversion=async(id)=>{
    await seed(id,1600,0)
    await client.query("UPDATE sale_orders SET sale_order_type='转换单' WHERE sale_order_id=$1",[id])
    await client.query("UPDATE sale_items SET item_direction='转入',sale_amount=11600,received=10000 WHERE sale_order_id=$1",[id])
    await client.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,received,item_direction,is_experience,product_type)
      VALUES($1,$2,'TE2A_STORE',0,0,-10000,-10000,'转出',true,'家居产品')`,['OUT-'+id,id])
  }
  await reset();await conversion('A524-CONV')
  a=await confirmOfflinePayment('A524-CONV',300);assert.equal(a.success,true,a.message);await assertMember('A524-CONV','小美客')
  r=await recordPayment({saleOrderId:'A524-CONV',repayAmount:200,paymentMethod:'线下'});assert.equal(r.success,false);assert.match(r.error.message,/店长分配/)
  assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
  r=await recordPayment({saleOrderId:'A524-CONV',repayAmount:200,paymentMethod:'线下'});assert.equal(r.success,true,JSON.stringify(r));await assertMember('A524-CONV')
  assert.equal(Number((await client.query("SELECT SUM(amount) AS amount FROM sale_payment_item_receipts WHERE sale_order_id='A524-CONV'")).rows[0].amount),500)
  console.log('PASS #524 转换实际capture旧卡10000不入会，新收300+200才达标；转入资产不重复')
  // 在线支付前预演仍只临时UPDATE+SELECT；转换需先更新本次received再计算增量。
  const { assertOnlineMembershipBinding }=require('../../../fengyu-client/cloudfunctions/clientApi/utils/membership-payment-preview.js')
  const source=readFileSync(new URL('../../../fengyu-client/cloudfunctions/clientApi/routes/order.js',import.meta.url),'utf8')
  const customerTypeCte=source.match(/const RECALC_CUSTOMER_TYPE_CTE = `([\s\S]*?)`/)[1]
  for(const type of ['销售单','转换单']){
    await reset();if(type==='转换单')await conversion('C524-PREVIEW');else await seed('C524-SALE',1600,0)
    const id=type==='转换单'?'C524-PREVIEW':'C524-SALE'
    const beforePreview=await counts()
    const preview=async(amount)=>{
      await client.query('BEGIN')
      try{await assertOnlineMembershipBinding(client,{saleOrderId:id,clientUserId:'CUSTOMER-1',cashAmount:amount,cardAmount:0,payableAmount:1600,threshold:500,customerTypeCte});await client.query('COMMIT')}
      catch(error){await client.query('ROLLBACK');throw error}
    }
    await preview(300);await assert.rejects(preview(500),/店长分配/)
    assert.deepEqual(await counts(),beforePreview)
    const order=(await client.query('SELECT status,received FROM sale_orders WHERE sale_order_id=$1',[id])).rows[0]
    assert.equal(order.status,'待支付');assert.equal(Number(order.received),0)
    console.log('PASS #524 '+type+'线上部分款项达标预演、未达标放行、拒绝不留资金事实')
  }

  for(const type of ['销售单','转换单']){
    await reset();const id=type==='转换单'?'P524-CONV':'P524-SALE'
    if(type==='转换单')await conversion(id);else await seed(id,1600,0)
    await client.query("UPDATE sale_orders SET payment_method='微信' WHERE sale_order_id=$1",[id])
    execFileSync('node',[new URL('./_membership-callback.cjs',import.meta.url).pathname,id],{env:process.env,stdio:'pipe'})
    await assertMember(id)
    assert.equal(Number((await client.query('SELECT received FROM sale_orders WHERE sale_order_id=$1',[id])).rows[0].received),500)
    console.log('PASS #524 '+type+'真实payNotify部分款项300+200入会，重复回调幂等，成功回调不受归属门禁阻挡')
  }


  for(const end of ['staff','client']){
    await reset();const id=end==='staff'?'S524-REPAY':'C524-CARD'
    await seed(id,1600,0)
    const first=await confirmOfflinePayment(id,300);assert.equal(first.success,true,first.message)
    if(end==='client')await client.query('UPDATE sale_orders SET first_payment_amount=200 WHERE sale_order_id=$1',[id])
    const ctx={auth:end==='staff'?manager:{userId:'CUSTOMER-1',phone:'19999000001'},
      event:{payload:end==='staff'?{refSaleOrderId:id,repayAmount:200,paymentMethod:'线下'}:
        {saleOrderId:id,repayAmount:0,prepaidCardAmount:200,paymentMethod:'储值卡'}},wxContext:{OPENID:'wx-private-301'}}
    const action=end==='staff'?staffRoutes.createRepayment:clientRoutes.repay
    const before=await counts();await assert.rejects(action(ctx),/店长分配/);assert.deepEqual(await counts(),before)
    assert.equal((await assignCustomer('CUSTOMER-1','EMP-1')).success,true)
    await action(ctx);await assertMember(id)
    console.log('PASS #524 '+end+'同单仍部分支付的回款/实际扣卡达标，拒绝完整回滚，分配后即时入会')
  }
  // 真正运行每日批处理和WorkFine复用的离线SQL；比较写入结果及重复执行。
  const { PgDialect }=await import('drizzle-orm/pg-core')
  const { customerTypeBatchSql }=await import('../../src/cron/steps/refresh-customer-types.ts')
  const batch=async(threshold)=>{const q=new PgDialect().sqlToQuery(customerTypeBatchSql(threshold));await client.query(q.sql,q.params)}
  const snapshot=async()=>({customer:(await client.query('SELECT customer_type,became_member_at,member_level FROM client_wechat_users')).rows,
    orders:(await client.query("SELECT sale_order_id,is_membership_upgrade FROM sale_orders WHERE status<>'已关闭' ORDER BY sale_order_id")).rows})
  const expected=await snapshot()
  const { recomputeCustomerTagsInTx }=await import('../../src/lib/recompute-customer-tags.ts')
  await client.query("UPDATE client_wechat_users SET customer_type='流量客',became_member_at=NULL; UPDATE sale_orders SET is_membership_upgrade=false")
  await client.query('BEGIN')
  try{
    const tx={execute:async(query)=>{const q=new PgDialect().sqlToQuery(query);const r=await client.query(q.sql,q.params);return Object.assign(r.rows,{count:r.rowCount})}}
    await recomputeCustomerTagsInTx(tx,'CUSTOMER-1');await client.query('COMMIT')
  }catch(e){await client.query('ROLLBACK');throw e}
  await assertMember('C524-CARD');assert.deepEqual(await snapshot(),expected)

  await client.query("UPDATE client_wechat_users SET customer_type='流量客',became_member_at=NULL; UPDATE sale_orders SET is_membership_upgrade=false")
  await batch(500);await assertMember('C524-CARD');assert.deepEqual(await snapshot(),expected)
  await batch(500);assert.deepEqual(await snapshot(),expected)
  const all=require('../../../db/scripts/recalc-all-customer-types.js')
  await client.query("UPDATE client_wechat_users SET customer_type='流量客',became_member_at=NULL; UPDATE sale_orders SET is_membership_upgrade=false")
  const offline=async()=>{
    await client.query('BEGIN')
    try{
      await client.query(all.BUILD_TARGET_TABLE_SQL,[500]);await client.query(all.UPDATE_TYPE_SQL);await client.query(all.UPDATE_LEVEL_SQL);await client.query(all.UPDATE_BECAME_SQL)
      await client.query('COMMIT')
    }catch(e){await client.query('ROLLBACK');throw e}
    for(const name of ['recalc-became-member-at','backfill-membership-upgrade-doc-type']){
      const script=require('../../../db/scripts/'+name+'.js')
      await client.query('BEGIN');try{await client.query(script.BUILD_TARGET_SQL,[500]);await client.query(script.UPDATE_SQL);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}
    }
  }
  await offline();await assertMember('C524-CARD');assert.deepEqual(await snapshot(),expected)
  await offline();assert.deepEqual(await snapshot(),expected)
  await batch(1000)
  const lowered=await snapshot();assert.equal(lowered.customer[0].customer_type,'小美客')
  assert.deepEqual(lowered.customer[0].became_member_at,expected.customer[0].became_member_at)
  console.log('PASS #524 实时、每日、三个离线脚本真实写入同一类型/入会时间/升级单；重复执行幂等，阈值变化双向分类且保留历史')

} finally {if(clientPg)await clientPg.getPool().end();if(staffPg)await staffPg.getPool().end();if(client)await client.end();if(globalThis.pgClient)await globalThis.pgClient.end();if(started)docker('stop',container)}
