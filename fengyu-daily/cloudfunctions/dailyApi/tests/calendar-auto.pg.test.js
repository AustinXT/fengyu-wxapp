const {test:baseTest,after}=require('node:test');
const assert=require('node:assert/strict');
const {Pool,types}=require('pg');
const {ensureCalendar,calendarPeriod,calendarData,calendarPreview}=require('../utils/daily-calendar-auto');
const url=process.env.DAILY_TEST_DATABASE_URL;
const test=(name,fn)=>baseTest(name,{skip:!url},fn);
const parsed=url?new URL(url):null;
if(parsed && (parsed.hostname!=='101.34.242.103'||parsed.port!=='8151'||!/^daily_regression_[a-f0-9]{24}$/.test(parsed.pathname.slice(1))||process.env.DAILY_TEST_TEMP_DB!==parsed.pathname.slice(1)))throw Error('只允许独立临时库');
types.setTypeParser(1082,v=>v);
const pool=url?new Pool({connectionString:url,max:5}):null;
const q=async(text,args)=>(await pool.query(text,args)).rows;
const natural={start:{monthOffset:0,day:1},end:{monthOffset:0,day:31},weeks:[[1,7],[8,14],[15,21],[22,31]].map(([a,b],i)=>({id:'w'+i,name:'第'+(i+1)+'周',start:{monthOffset:0,day:a},end:{monthOffset:0,day:b}}))};
const cross={start:{monthOffset:-1,day:26},end:{monthOffset:0,day:25},weeks:[[-1,26,0,2],[0,3,0,9],[0,10,0,16],[0,17,0,25]].map(([a,b,c,d],i)=>({id:'w'+i,name:'第'+(i+1)+'周',start:{monthOffset:a,day:b},end:{monthOffset:c,day:d}}))};
async function tx(work){const c=await pool.connect();try{await c.query('BEGIN');const r=await work(async(t,a)=>(await c.query(t,a)).rows);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
async function fill(allowed,date,month){return tx(query=>ensureCalendar(query,allowed,date,month))}
async function old(key,pattern=natural,region=null){const p=calendarPeriod(key,pattern);await q('INSERT INTO daily_operating_periods(id,name,month_key,region_id,start_date,end_date,weeks) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',['old'+key+(region||''),p.name,key,region,p.start,p.end,JSON.stringify(p.weeks)]);}
let before;
test('初始化旧历史、未来、PK、目标和日报，用真实表验证不改写',async()=>{
 await q("INSERT INTO org_nodes(id,name,type) VALUES('head','总部','总部')");
 for(const id of ['a','b']){await q("INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$2,'市场','head')",[id,'市场'+id]);await q("INSERT INTO org_nodes(id,name,type,parent_id) VALUES($1,$2,'门店',$3)",['n'+id,'店'+id,id]);await q('INSERT INTO stores(store_id,store_name,org_node_id) VALUES($1,$2,$3)',['s'+id,'店'+id,'n'+id]);}
 await q("INSERT INTO staff_wechat_users(employee_id,name,store_id) VALUES('employee','测试员工','sa')");
 await q('INSERT INTO daily_operating_period_templates(id,name,pattern) VALUES($1,$2,$3::jsonb)',['template','自然月',JSON.stringify(natural)]);
 for(const key of ['2028-01','2028-02','2028-04'])await old(key);
 await q("INSERT INTO daily_pk_classes(id,period_id,month_key,name) VALUES('class','old2028-02','2028-02','原班级')");
 await q("INSERT INTO daily_pk_stores(period_id,store_id,class_id,month_key) VALUES('old2028-02','sa','class','2028-02')");
 await q("INSERT INTO daily_operating_targets(period_id,scope,scope_id,sales,consumption,penalty) VALUES('old2028-02','personal','employee',100,100,'')");
 await q("INSERT INTO daily_reports(id,employee_id,store_id,employee_name,store_name,report_date,status,submitted_at) VALUES('report','employee','sa','测试员工','店a','2028-02-02','submitted',now())");
 before={};for(const t of ['daily_operating_periods','daily_pk_classes','daily_pk_stores','daily_operating_targets','daily_reports','daily_operating_period_stores'])before[t]=await q('SELECT * FROM '+t+' ORDER BY 1');
 const r=await fill(null,'2028-02-08');assert.equal(r.created,2);
 for(const t of Object.keys(before)){const after=await q('SELECT * FROM '+t+' ORDER BY 1');for(const row of before[t])assert.ok(after.some(a=>JSON.stringify(a)===JSON.stringify(row)),t+'旧行必须不变');if(t!=='daily_operating_periods'&&t!=='daily_operating_period_stores')assert.deepEqual(after,before[t]);}
 const d=await calendarData(q,null);assert.equal(calendarPreview(d,d.regions[0],'2028-02').period.id,'old2028-02');assert.equal((await q("SELECT * FROM daily_operating_periods WHERE month_key='2028-03'"))[0].end_date,'2028-03-31');
});
test('多人并发滚动补齐幂等，审计及门店快照与新月份同事务',async()=>{
 const results=await Promise.all([fill(null,'2028-03-08'),fill(null,'2028-03-08'),fill(null,'2028-03-08')]);assert.equal(results.reduce((n,r)=>n+r.created,0),2);
 assert.equal((await q("SELECT * FROM daily_operating_periods WHERE month_key='2028-05'")).length,2);
 assert.equal((await q("SELECT * FROM operation_logs WHERE action='daily.period.generate'")).length,4);
 assert.equal((await q('SELECT * FROM daily_operating_period_stores')).length,4);
});
test('员工只补授权市场，未授权和空范围不创建，未来月份受限',async()=>{
 assert.equal((await fill(['sa'],'2028-04-08')).created,1);
 assert.equal((await q("SELECT * FROM daily_operating_periods WHERE month_key='2028-06'"))[0].region_id,'a');
 assert.equal((await fill([],'2028-05-08')).created,0);
 await assert.rejects(()=>fill(['sa'],'2028-05-08','2029-06'),/未来12个月/);
});
test('PK选未来月份补齐所有市场，历史查询只读且拒绝补造',async()=>{
 await fill(null,'2028-05-08','2028-09');assert.equal((await q("SELECT * FROM daily_operating_periods WHERE month_key='2028-09'")).length,2);
 await assert.rejects(()=>fill(null,'2028-05-08','2027-12'),/未来12个月/);
 const d=await calendarData(q,['sa']);calendarPreview(d,d.regions[0],'2027-12');assert.equal((await q("SELECT * FROM daily_operating_periods WHERE month_key='2027-12'")).length,0);
});
test('新旧日期冲突时规则保存和新增月份完整回滚，旧关联不动',async()=>{
 const before=await q('SELECT * FROM daily_operating_periods ORDER BY id');
 await assert.rejects(()=>tx(async query=>{await query("INSERT INTO system_configs(key,value) VALUES('daily_cycle_modes',$1)",[JSON.stringify([{id:'new',isDefault:true,regionIds:[],pattern:cross}])]);return ensureCalendar(query,null,'2028-08-08','2028-10')}),/重叠|不连续/);
 assert.deepEqual(await q('SELECT * FROM daily_operating_periods ORDER BY id'),before);
 assert.equal((await q("SELECT * FROM system_configs WHERE key='daily_cycle_modes'")).length,0);
});
after(()=>pool?.end());
