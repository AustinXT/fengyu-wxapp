import { createRequire } from 'node:module'
const require = createRequire(new URL('../../fengyu-admin/package.json', import.meta.url))
const { Client } = require('pg')
const { hash } = require('bcryptjs')
const url = new URL(process.env.DATABASE_URL || '')
if (url.hostname !== '127.0.0.1' || url.port !== '58096' || url.pathname !== '/lxcoding_demo' || url.username !== 'lxcoding_demo' || url.search || url.hash) {
  throw Error('模拟数据只允许写入专用隧道连接的 lxcoding_demo')
}
if (!process.env.DEMO_LOGIN_PHONE || !process.env.DEMO_LOGIN_PASSWORD) throw Error('演示登录配置缺失')
const client = new Client({ connectionString: url.toString() })
await client.connect()
const insert = async (table, values, returning = '') => {
  // Identifiers come exclusively from the fixed seed definitions below.
  const keys = Object.keys(values)
  return client.query(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i+1}`).join(',')})${returning ? ` RETURNING "${returning}"` : ''}`, Object.values(values))
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
const day = (offset) => {
  const date = new Date(`${today}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate()+offset)
  return date.toISOString().slice(0,10)
}
const timestamp = (offset, hour = 12) => `${day(offset)}T${String(hour).padStart(2,'0')}:00:00+08:00`
try {
  await client.query('BEGIN')
  await client.query("SELECT pg_advisory_xact_lock(hashtext('lxcoding-demo:seed'))")
  if ((await client.query("SELECT 1 FROM system_configs WHERE key='lxcoding_demo_seed_version'")).rowCount) {
    const admin = await client.query('SELECT 1 FROM staff_wechat_users WHERE employee_id=$1 AND phone=$2', ['LX-ADMIN',process.env.DEMO_LOGIN_PHONE])
    if (!admin.rowCount) throw Error('演示管理员与本地配置不一致，拒绝修改角色')
    // main 保留纯系统管理员不查看顾客详情的规则；演示账号同时承担客户管理职责。
    await client.query("INSERT INTO permission_roles(employee_id,role,scope_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(employee_id,role,scope_id) DO NOTHING", ['LX-ADMIN','customer_mgr','LX-HQ','demo-seed'])
    await client.query("UPDATE system_configs SET value='2' WHERE key='lxcoding_demo_seed_version'")
    console.log('模拟数据已初始化，保留用户在演示库的操作记录')
    await client.query('COMMIT')
    process.exitCode = 0
  } else {
    if ((await client.query('SELECT 1 FROM staff_wechat_users LIMIT 1')).rowCount) throw Error('库非空，拒绝覆盖；请核对演示库来源')
    await insert('org_nodes', { id:'LX-HQ', name:'LX CODING 美业集团（演示）', type:'总部' })
    for (const [id,name] of [['LX-M1','星海市场'],['LX-M2','云栖市场']]) {
      await insert('org_nodes', { id, name, type:'市场', parent_id:'LX-HQ' })
    }
    await insert('staff_wechat_users', { employee_id:'LX-ADMIN', name:'演示管理员', phone:process.env.DEMO_LOGIN_PHONE, org_node_id:'LX-HQ', position_name:'超级管理员', hired_at:day(-400) })
    await insert('admin_passwords', { employee_id:'LX-ADMIN', password_hash:await hash(process.env.DEMO_LOGIN_PASSWORD,12), must_change:false })
    await insert('permission_roles', { employee_id:'LX-ADMIN', role:'admin', scope_id:'LX-HQ', created_by:'demo-seed' })
    await insert('permission_roles', { employee_id:'LX-ADMIN', role:'customer_mgr', scope_id:'LX-HQ', created_by:'demo-seed' })
    const stores = []
    const storeNames = ['星海旗舰店','星海花园店','云栖中心店','云栖悦美店']
    const staffNames = ['林晓','周宁','许悦','陈晴','苏禾']
    for (let s=0;s<4;s++) {
      const market = s<2?'LX-M1':'LX-M2'
      const id = `LX-STORE-${s+1}`
      const node = `LX-ORG-${s+1}`
      await insert('org_nodes', { id:node, name:storeNames[s], type:'门店', parent_id:market, sort_order:s })
      await insert('org_nodes', { id:`${node}-BEAUTY`, name:'美容部', type:'部门', parent_id:node })
      await insert('stores', { store_id:id, store_name:storeNames[s], org_node_id:node, opening_date:day(-400), bed_count:8+s*2, district:'演示城区', street_address:`演示路${100+s}号`, business_hours:'09:00-21:00', description:'LX CODING 虚构门店，仅供系统体验', cover_image:'/demo-store.svg' })
      const employees=[]
      for(let e=0;e<5;e++) {
        const employee=`LX-EMP-${s+1}-${e+1}`
        employees.push(employee)
        await insert('staff_wechat_users', { employee_id:employee, phone:`1991000${String(s*5+e+1).padStart(4,'0')}`, name:`${staffNames[e]}${s+1}`, gender:'女', store_id:id, org_node_id:`${node}-BEAUTY`, position_name:e===0?'店长':'美容师', skills:['美容师'], hired_at:day(-300+e*15), social_insurance:true })
        if(e===0) await insert('permission_roles', { employee_id:employee, role:'manager', scope_id:node, created_by:'demo-seed' })
      }
      stores.push({id,node,market,name:storeNames[s],employees})
    }
    const clients=[]
    const family=['林','苏','陈','周','许','赵','宋','温','沈','顾']
    const names=['安宁','小悦','晓晴','知夏','清禾','若琳']
    for(let i=0;i<60;i++) {
      const store=stores[i%4]
      const user=`LX-CUSTOMER-${String(i+1).padStart(3,'0')}`
      const name=family[i%10]+names[Math.floor(i/10)]
      const employee=store.employees[1+i%4]
      const phone=`1992000${String(i+1).padStart(4,'0')}`
      await insert('client_wechat_users', { user_id:user, name, phone, gender:'女', bound_store_id:store.id, bound_employee_id:employee, member_level:['初钻','星钻','粉钻','金钻','黑钻'][i%5], customer_type:i%3?'会员客':'体验客', customer_source:['自进店','美团','老带新'][i%3], customer_status:'保有会员-稳定', monthly_activity:'一次客活', birthday:`199${i%9}-0${1+i%9}-15`, skin_type:['干性','混合性','中性'][i%3], notes:'虚构顾客资料，仅供演示', created_at:timestamp(-120-i) })
      clients.push({user,name,phone,store,employee})
    }
    await insert('product_categories',{category_id:'LX-KIND-SERVICE', category_name:'耗卡', display_color:'#5D5294'})
    await insert('product_categories',{category_id:'LX-KIND-HOME', category_name:'家居', display_color:'#3D8A5A'})
    await insert('product_categories',{category_id:'LX-CAT-SERVICE', category_name:'面部与身体护理', product_kind:'耗卡', sales_category:'自销自耗'})
    await insert('product_categories',{category_id:'LX-CAT-HOME', category_name:'居家护肤', product_kind:'家居', sales_category:'自销自耗'})
    await insert('mall_categories',{category_id:'LX-MALL', category_name:'精选项目', category_group:'护理'})
    const skus=[]
    const products=[['水润焕颜护理',1980],['舒敏修护护理',2680],['紧致焕新护理',3980],['肩颈舒缓护理',1680],['经络养护项目',2980],['光感亮肤护理',3280],['水润精华液',268],['舒缓修护面膜',198]]
    for(let i=0;i<products.length;i++) {
      const [name,price]=products[i]
      const service=i<6
      const sku=`LX-SKU-${i+1}`
      const product=`LX-PRODUCT-${i+1}`
      await insert('product_skus',{sku_id:sku,category_id:service?'LX-CAT-SERVICE':'LX-CAT-HOME',product_type:service?'疗程卡':'家居产品',spec_name:service?`${name} · 10次卡`:`${name} · 标准装`,price,session_count:service?10:null,unit:service?'次':'盒',service_fee:service?30:0,is_shengmei:service,sort_order:i})
      await insert('products',{product_id:product,category_id:'LX-MALL',name,price,cover_image:'/demo-product.svg',description:'LX CODING 演示商品，价格与资料均为模拟',sort_order:i})
      await insert('mall_product_skus',{product_id:product,sku_id:sku})
      skus.push({sku,name,price,service})
    }
    for(const market of ['LX-M1','LX-M2']) for(const role of ['美容师','推广师','养生师']) {
      await insert('commission_rate_matrix',{org_id:market,order_type:'销售单',role_type:role,sales_category:'自销自耗',amount_tier_min:0,commission_rate:0.08})
    }
    const serviceCandidates=[]
    for(let i=0;i<180;i++) {
      const customer=clients[i%60]
      const sku=skus[i%8]
      const offset=i<8?0:-1-Math.floor((i-8)/4)
      const at=timestamp(offset,10+i%8)
      const order=`FY-XSD-WX-${day(offset).replaceAll('-','').slice(2)}${String(i+1).padStart(4,'0')}`
      const item=`LX-ITEM-${i+1}`
      const allocated=i%7!==0
      await insert('sale_orders',{sale_order_id:order,status:'已支付',sale_order_type:'销售单',document_type:'售后',market_name:customer.store.market==='LX-M1'?'星海市场':'云栖市场',store_id:customer.store.id,store_name:customer.store.name,sale_order_datetime:at,performance_attribution_date:day(offset),client_user_id:customer.user,client_phone:customer.phone,customer_name:customer.name,total_amount:sku.price,payable_amount:sku.price,received:sku.price,payment_method:'线下',opened_by:customer.employee,preferred_employee_id:customer.employee,paid_at:at,offline_confirmed_by:'LX-ADMIN',offline_confirmed_at:at,allocation_status:allocated?'已分配':'待分配',remark:'模拟订单，仅供体验',created_at:at,updated_at:at})
      await insert('sale_items',{sale_item_id:item,sale_order_id:order,store_id:customer.store.id,sku_id:sku.sku,product_name:sku.name,product_kind_at_sale:sku.service?'耗卡':'家居',product_type:sku.service?'疗程卡':'家居产品',session_count:sku.service?10:null,remaining_sessions:sku.service?10:null,paid_sessions:sku.service?10:null,unit_price:sku.service?sku.price/10:sku.price,unit_real_price:sku.service?sku.price/10:sku.price,sale_amount:sku.price,received:sku.price,sales_category:'自销自耗',service_fee:sku.service?30:0,is_shengmei:sku.service,expire_date:day(365),created_at:at,updated_at:at})
      const payment=(await insert('sale_order_payments',{sale_order_id:order,change_type:'首次支付',amount:sku.price,payment_method:'线下',status:'已支付',source_end:'admin',operator_employee_id:'LX-ADMIN',paid_at:at,created_at:at,allocation_status:allocated?'已分配':'待分配',note:'演示收款'},'id')).rows[0].id
      const receipt=(await insert('sale_payment_item_receipts',{sale_payment_id:payment,sale_order_id:order,sale_item_id:item,amount:sku.price,sales_category:'自销自耗',created_at:at},'id')).rows[0].id
      if(allocated) await insert('sale_payment_item_allocations',{sale_payment_item_receipt_id:receipt,employee_id:customer.employee,role_type:'美容师',department_name:'美容部',allocation_ratio:1,allocated_amount:sku.price,commission_rate:0.08,commission_amount:Number((sku.price*0.08).toFixed(2)),created_at:at})
      if(sku.service) serviceCandidates.push({customer,sku,item,offset,at})
    }
    for(let i=0;i<100;i++) {
      const {customer,sku,item,offset,at}=serviceCandidates[i]
      const service=`LX-SERVICE-${i+1}`
      await insert('service_orders',{service_order_id:service,status:'已完成',service_order_type:'售后',market_name:customer.store.market==='LX-M1'?'星海市场':'云栖市场',store_id:customer.store.id,service_date:day(offset),assigned_employee_id:customer.employee,client_user_id:customer.user,started_at:at,staff_completed_at:at,completed_at:at,commission_status:'已分配',created_at:at})
      const sid=`LX-SERVICE-ITEM-${i+1}`
      await insert('service_items',{service_item_id:sid,sale_item_id:item,service_order_id:service,session_used:1,employee_id:customer.employee,service_duration:60,unit_real_price:sku.price/10,is_shengmei:true,sales_category:'自销自耗',created_at:at})
      await client.query('UPDATE sale_items SET remaining_sessions=remaining_sessions-1 WHERE sale_item_id=$1',[item])
      await insert('service_commissions',{service_item_id:sid,employee_id:customer.employee,role_type:'美容师',allocation_ratio:1,commission_rate:0.10,fixed_fee:30,consume_amount:sku.price/10,commission_amount:Number((sku.price/100+30).toFixed(2)),created_at:at})
    }
    for(let i=0;i<6;i++) {
      const {customer,sku,item}=serviceCandidates[100+i]
      const service=`LX-SERVICE-ACTIVE-${i+1}`
      await insert('service_orders',{service_order_id:service,status:'待服务',service_order_type:'售后',market_name:customer.store.market==='LX-M1'?'星海市场':'云栖市场',store_id:customer.store.id,service_date:today,assigned_employee_id:customer.employee,client_user_id:customer.user})
      await insert('service_items',{service_item_id:`LX-SVC-ACTIVE-ITEM-${i+1}`,sale_item_id:item,service_order_id:service,session_used:1,employee_id:customer.employee,service_duration:60,unit_real_price:sku.price/10,is_shengmei:true,sales_category:'自销自耗'})
    }
    for(let i=0;i<12;i++) {
      const {customer,item}=serviceCandidates[110+i]
      await insert('appointments',{appointment_id:`LX-APPT-${i+1}`,status:i%2?'已确认':'待确认',store_id:customer.store.id,client_user_id:customer.user,client_name:customer.name,employee_id:customer.employee,sale_item_id:item,appointment_time:timestamp(1+Math.floor(i/6),10+i%6),notes:'演示预约'})
    }
    for(let i=0;i<12;i++) {
      const customer=clients[i]
      const order=`LX-RECHARGE-${i+1}`
      const amount=2000+i*200
      const at=timestamp(-10)
      await insert('sale_orders',{sale_order_id:order,status:'已支付',sale_order_type:'充值单',market_name:customer.store.market==='LX-M1'?'星海市场':'云栖市场',store_id:customer.store.id,store_name:customer.store.name,sale_order_datetime:at,performance_attribution_date:day(-10),client_user_id:customer.user,customer_name:customer.name,total_amount:amount,payable_amount:amount,received:amount,payment_method:'线下',opened_by:'LX-ADMIN',paid_at:at,remark:'模拟充值',created_at:at})
      await insert('sale_order_payments',{sale_order_id:order,change_type:'首次支付',amount,payment_method:'线下',status:'已支付',source_end:'admin',paid_at:at,created_at:at})
      await insert('prepaid_cards',{card_id:`LX-CARD-${i+1}`,user_id:customer.user,balance:amount})
      await insert('card_transactions',{card_id:`LX-CARD-${i+1}`,type:'充值',amount,ref_order_id:order,external_ref:`demo-recharge-${i+1}`,created_at:at})
    }
    for(let i=0;i<3;i++) {
      await insert('coupon_templates',{template_id:`LX-COUPON-${i+1}`,name:['新客体验券','会员护理券','焕颜礼遇券'][i],coupon_type:'现金券',discount_value:[50,100,200][i],min_spend:[199,499,999][i],total_count:1000,validity_mode:'fixed',valid_from:timestamp(-30),valid_to:timestamp(365),description:'虚构优惠券，仅用于系统演示'})
    }
    for(let i=0;i<24;i++) await insert('user_coupons',{coupon_id:`LX-USER-COUPON-${i+1}`,template_id:`LX-COUPON-${1+i%3}`,user_id:clients[i].user,expire_at:timestamp(60)})
    await insert('system_configs',{key:'lxcoding_demo_seed_version',value:'2'})
    await insert('operation_logs',{operator_employee_id:'LX-ADMIN',operator_name:'演示管理员',action:'demo.seed',target_type:'system',target_id:'lxcoding_demo',source:'admin',detail:JSON.stringify({synthetic:true,stores:4,customers:60,orders:192})})
    await client.query('COMMIT')
    console.log('已创建虚构数据：4 门店、21 员工、60 顾客、8 商品、192 订单、106 服务单、12 预约、12 储值卡、24 优惠券')
  }
} catch(error) {
  await client.query('ROLLBACK')
  // PG errors include bind values in some drivers; expose only diagnostic fields.
  console.error(`模拟数据初始化失败：${error.code || ''} ${error.message} ${error.constraint || ''}`)
  process.exitCode=1
} finally { await client.end() }
