const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../db/pg');
const report = require('../routes/report');
const period = { id:'p',name:'测试周期',start_date:'2026-10-01',end_date:'2026-10-31',version:1,
  weeks:[{id:'w',name:'本周',start:'2026-10-01',end:'2026-10-31'}] };
const auth={employeeId:'self',storeId:'s',managerStores:[],roleBindings:[]};
async function run(payload, accessible=true) {
  const calls=[];const original=pg.query;
  pg.query=async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('count(r.id)'))return [{employee_id:'self',due:1,submitted:1}];
    if(sql.includes('SELECT u.employee_id,u.name,u.store_id')) return accessible?[{employee_id:payload.employeeId||'self',store_id:'s'}]:[];
    if(sql.includes("WHERE type='市场'"))return [{id:'m'}];
    if(sql.includes('FROM daily_operating_periods'))return [period];
    if(sql.includes('SELECT id,report_date,status'))return [{id:'r',status:'submitted'}];
    if(sql.includes('count(r.id)'))return [{employee_id:'self',due:1,submitted:1}];
    throw Error('Unexpected SQL: '+sql);
  };
  const ctx={auth,event:{payload}};
  try {await report.history(ctx);return {data:ctx.result,calls};}finally{pg.query=original;}
}
test('历史默认保持366条和不限定周期；首页限制条数仍是参数化查询',async()=>{
  const original=await run({});assert.equal(original.data.period,null);assert.equal(original.data.summary,null);
  assert.equal(original.calls.find(x=>x.sql.includes('LIMIT $6')).args[5],366);
  const limited=await run({limit:2});assert.equal(limited.calls.find(x=>x.sql.includes('LIMIT $6')).args[5],2);
  for(const limit of [0,367,'2',2.5])await assert.rejects(run({limit}),/INVALID_PARAMS/);
});
test('初始化响应合并周期与历史，沿用观看者的周期解析与默认选择',async()=>{
  const result=await run({includePeriods:true});assert.equal(result.data.period.id,'p');assert.equal(result.data.periods[0].id,'p');
  const history=result.calls.find(x=>x.sql.includes('LIMIT $6'));assert.equal(history.args[3],'2026-10-01');
  assert.equal(result.data.summary.submitted,1);
});
test('越权员工查询在读取周期和历史之前拒绝',async()=>{
  await assert.rejects(run({employeeId:'other',includePeriods:true},false),/NOT_FOUND/);
});
