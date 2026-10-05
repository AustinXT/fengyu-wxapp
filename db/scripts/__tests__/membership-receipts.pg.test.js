'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const root = path.resolve(__dirname, '../../..')
const files = [
  'fengyu-staff/cloudfunctions/staffApi/routes/order.js',
  'fengyu-client/cloudfunctions/clientApi/routes/order.js',
  'fengyu-client/cloudfunctions/payNotify/index.js',
  'fengyu-admin/src/actions/orders.ts',
  'fengyu-admin/src/lib/recompute-customer-tags.ts',
  'fengyu-admin/src/cron/steps/refresh-customer-types.ts',
  'db/scripts/recalc-all-customer-types.js',
  'db/scripts/recalc-became-member-at.js',
  'db/scripts/backfill-membership-upgrade-doc-type.js',
]
function queryFor(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const match = src.match(/WITH membership_settings AS \([\s\S]*?FROM membership_amounts a CROSS JOIN membership_settings cfg\s*\)/)
  assert.ok(match, file)
  return match[0].replace(/SELECT (?:NULL|\$1|\$\{clientUserId\})::text AS client_user_id, (?:\$1|\$2|\$\{threshold\}|\(SELECT v FROM threshold\))::numeric AS threshold/,
    'SELECT $1::text AS client_user_id, $2::numeric AS threshold')
}
test('#524 九处金额及首次达标时间 SQL 全文一致', () => {
  const expected = queryFor(files[0])
  for (const file of files) assert.equal(queryFor(file), expected, file)
})

const url = process.env.MEMBERSHIP_RECEIPTS_PG_TEST_URL
test('#524 真实迁移私有PG：九处金额、达标时间、特殊单与旧转换资产反例', { skip: !url }, async () => {
  const u = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname))
  assert.equal(u.pathname, '/issue524')
  assert.equal(u.search, '')
  const db = new Client({ connectionString: url })
  await db.connect()
  await db.query('BEGIN')
  try {
    await db.query(`INSERT INTO org_nodes(id,name,type,parent_id) VALUES ('M524_HQ','合成总部','总部',NULL),
      ('M524_MARKET','合成市场','市场','M524_HQ'),('M524_STORE_NODE','合成门店','门店','M524_MARKET');
      INSERT INTO stores(store_id,store_name,org_node_id) VALUES ('M524_STORE','合成测试门店','M524_STORE_NODE')`)
    await db.query("INSERT INTO client_wechat_users(user_id,name) VALUES ('M524_USER','合成顾客')")
    const order = async (id, received, type = '销售单', status = '部分支付', paid = null) => {
      await db.query(`INSERT INTO sale_orders(sale_order_id,client_user_id,market_name,store_id,sale_order_datetime,
        total_amount,payable_amount,received,payment_method,sale_order_type,status,created_at,paid_at)
        VALUES ($1,'M524_USER','合成市场','M524_STORE','2026-01-01',30000,30000,$2,'线下',$3,$4,'2026-01-01',$5)`, [id,received,type,status,paid])
    }
    const item = async (orderId, id, cap, received, trial = false, direction = '购买') => {
      await db.query(`INSERT INTO sale_items(sale_item_id,sale_order_id,store_id,unit_price,unit_real_price,sale_amount,received,
        is_experience,item_direction,product_type) VALUES ($1,$2,'M524_STORE',100,100,$3,$4,$5,$6,'家居产品')`, [id,orderId,cap,received,trial,direction])
    }
    const pay = async (id, amount, date, rows, type = '首次支付', note = null) => {
      const p = (await db.query(`INSERT INTO sale_order_payments(sale_order_id,change_type,amount,payment_method,status,source_end,paid_at,note)
        VALUES ($1,$2,$3,'线下','已支付','staff',$4,$5) RETURNING id`, [id,type,amount,date,note])).rows[0].id
      for (const [si, value] of rows) await db.query(`INSERT INTO sale_payment_item_receipts(sale_payment_id,sale_order_id,sale_item_id,amount)
        VALUES ($1,$2,$3,$4)`,[p,id,si,value])
    }
    const d1='2026-02-01T01:00:00.000Z', d2='2026-02-02T01:00:00.000Z'
    await order('M524_PART',1990); await item('M524_PART','M524_PART_I',3000,1990)
    await pay('M524_PART',1000,d1,[['M524_PART_I',1000]])
    await pay('M524_PART',990,d2,[['M524_PART_I',990]],'回款')
    await order('M524_BIG',20000); await item('M524_BIG','M524_BIG_I',20010,20000)
    await pay('M524_BIG',20000,d1,[['M524_BIG_I',20000]])
    await order('M524_MIX',2100); await item('M524_MIX','M524_MIX_N',3000,1600)
    await item('M524_MIX','M524_MIX_T',500,500,true)
    await pay('M524_MIX',2100,d1,[['M524_MIX_N',1600],['M524_MIX_T',500]])
    for (const id of ['M524_SMALL1','M524_SMALL2']) {
      await order(id,1000); await item(id,id+'_I',3000,1000); await pay(id,1000,d1,[[id+'_I',1000]])
    }
    for (const id of ['M524_1980A','M524_1980B','M524_1980C']) {
      await order(id,1980); await item(id,id+'_I',1980,1980); await pay(id,1980,d1,[[id+'_I',1980]])
    }
    // 旧卡来自体验项目：不能以新转入2000直接升级；新增现金只有1000。
    await order('M524_SIGNED',1000,'转换单','已支付',d1)
    await item('M524_SIGNED','M524_SIGNED_O',-10000,-10000,true,'转出')
    await item('M524_SIGNED','M524_SIGNED_N',11000,11000,false,'转入')
    await pay('M524_SIGNED',1000,d1,[['M524_SIGNED_O',-10000],['M524_SIGNED_N',11000]])
    // 新式增量receipt + 旧式signed之后再回款，均不重复原资产。
    await order('M524_NEW',1990,'转换单'); await item('M524_NEW','M524_NEW_O',-10000,-10000,false,'转出')
    await item('M524_NEW','M524_NEW_N',15000,11990,false,'转入')
    await pay('M524_NEW',1000,d1,[['M524_NEW_N',1000]])
    await pay('M524_NEW',990,d2,[['M524_NEW_N',990]],'回款')
    await order('M524_OLD_NEW',1990,'转换单'); await item('M524_OLD_NEW','M524_OLD_NEW_O',-10000,-10000,false,'转出')
    await item('M524_OLD_NEW','M524_OLD_NEW_N',15000,11990,false,'转入')
    await pay('M524_OLD_NEW',1000,d1,[['M524_OLD_NEW_O',-10000],['M524_OLD_NEW_N',11000]])
    await pay('M524_OLD_NEW',990,d2,[['M524_OLD_NEW_N',990]],'回款')
    await order('M524_ZERO',0,'转换单','已支付',d1); await item('M524_ZERO','M524_ZERO_N',15000,15000,false,'转入')
    // 旧转换混合目标：净新增2100按转入权重拆为非体验1600+体验500。
    await order('M524_CONV_MIX',2100,'转换单','已支付',d1)
    await item('M524_CONV_MIX','M524_CONV_MIX_O',-18900,-18900,true,'转出')
    await item('M524_CONV_MIX','M524_CONV_MIX_N',16000,16000,false,'转入')
    await item('M524_CONV_MIX','M524_CONV_MIX_T',5000,5000,true,'转入')
    await pay('M524_CONV_MIX',2100,d1,[['M524_CONV_MIX_O',-18900],['M524_CONV_MIX_N',16000],['M524_CONV_MIX_T',5000]])
    await order('M524_REFUND',2500,'销售单','已支付',d2); await item('M524_REFUND','M524_REFUND_I',2500,1500)
    await pay('M524_REFUND',2500,d1,[['M524_REFUND_I',2500]])
    await pay('M524_REFUND',-1000,d2,[['M524_REFUND_I',-1000]],'退款',JSON.stringify({items:[{refSaleItemId:'M524_REFUND_I',refundAmount:1000}]}))
    await pay('M524_REFUND',0,d2,[],'退款','{not valid json')
    await order('M524_TRIAL',5000);await item('M524_TRIAL','M524_TRIAL_I',5000,5000,true)
    await pay('M524_TRIAL',5000,d1,[['M524_TRIAL_I',5000]])
    await order('M524_CENT',0.03,'转换单');await item('M524_CENT','M524_CENT_O',-1.97,-1.97,false,'转出')
    await item('M524_CENT','M524_CENT_N',1,1,false,'转入');await item('M524_CENT','M524_CENT_T',1,1,true,'转入')
    await pay('M524_CENT',0.03,d1,[['M524_CENT_O',-1.97],['M524_CENT_N',1],['M524_CENT_T',1]])
    await order('M524_CONV_REF',2500,'转换单','部分支付');await item('M524_CONV_REF','M524_CONV_REF_I',9000,1500,false,'转入')
    await pay('M524_CONV_REF',2500,d1,[['M524_CONV_REF_I',2500]])
    await pay('M524_CONV_REF',-1000,d2,[['M524_CONV_REF_I',-1000]],'退款')
    await order('M524_HISTORY',4000,'销售单','已支付','2025-01-02T00:00:00Z')
    for (const [id,type,status] of [['M524_PENDING','销售单','待支付'],['M524_CLOSED','销售单','已关闭'],['M524_FULL_REF','销售单','已退款'],['M524_INTERNAL','内部单','已支付'],['M524_TOPUP','充值单','已支付'],['M524_DEPOSIT','寄存单','已支付']]) await order(id,5000,type,status,d1)
    const expected={M524_TRIAL:[0,5000,null],M524_CENT:[0.02,0.01,null],M524_CONV_REF:[2500,0,d1],M524_PART:[1990,0,d2],M524_BIG:[20000,0,d1],M524_MIX:[1600,500,null],M524_SMALL1:[1000,0,null],M524_SMALL2:[1000,0,null],M524_1980A:[1980,0,null],M524_1980B:[1980,0,null],M524_1980C:[1980,0,null],M524_SIGNED:[1000,0,null],M524_NEW:[1990,0,d2],M524_OLD_NEW:[1990,0,d2],M524_ZERO:[0,0,null],M524_CONV_MIX:[1600,500,null],M524_REFUND:[2500,0,d1],M524_HISTORY:[4000,0,'2025-01-02T00:00:00.000Z']}
    for (const file of files) {
      const rows=(await db.query(queryFor(file)+' SELECT * FROM order_amounts',['M524_USER',1990])).rows
      const actual=Object.fromEntries(rows.map(r=>[r.sale_order_id,[Number(r.non_trial),Number(r.trial),r.qualified_at?.toISOString()??null]]))
      assert.deepEqual(actual,expected,file)
    }
    for (const threshold of [1980,1990,2000,5000]) {
      const rows=(await db.query(queryFor(files[0])+' SELECT * FROM order_amounts WHERE non_trial >= $2',['M524_USER',threshold])).rows
      assert.equal(rows.some(r=>r.sale_order_id==='M524_PART'),threshold<=1990)
      assert.equal(rows.some(r=>r.sale_order_id==='M524_1980A'),threshold<=1980)
    }
  } finally { await db.query('ROLLBACK'); await db.end() }
})
