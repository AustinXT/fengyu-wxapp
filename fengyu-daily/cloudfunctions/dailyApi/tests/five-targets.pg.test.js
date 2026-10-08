const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const url=require('./test-database').testDatabase();
const pg=require('../db/pg'),target=require('../routes/target'),validation=require('../utils/validation');
test('五项目标零值、旧金额锁定、补充确认、周余额及旧请求兼容', {skip:!url},async()=>{
 const id='five-'+randomUUID().slice(0,10),real=Date.now,now='1999-01-01',date=n=>new Date(Date.parse(now+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
 const weeks=[0,1,2,3].map(i=>({id:'w'+(i+1),name:'第'+(i+1)+'周',start:date(i*7),end:date(i*7+6)}));
 const ctx=p=>({auth:{employeeId:id},event:{payload:{scope:'personal',periodId:id,periodVersion:1,...p}}});
 try{
  Date.now=()=>Date.parse(now+'T04:00:00Z');
  await pg.query('INSERT INTO daily_operating_periods(id,name,start_date,end_date,weeks) VALUES($1,$1,$2,$3,$4::jsonb)',[id,now,date(27),JSON.stringify(weeks)]);
  await target.confirmMonth(ctx({version:0,sales:'100',consumption:'200',penalty:'复盘'}));
  const supplement=ctx({version:1,sales:'9999',consumption:'9999',penalty:'不能覆盖',visits:'10',newCustomers:'0',projects:'20'});await target.confirmMonth(supplement);
  assert.equal(supplement.result.target.sales,10000);assert.equal(supplement.result.target.penalty,'复盘');assert.equal(supplement.result.target.newCustomers,0);assert.equal(supplement.result.target.counts_month_confirmed,true);
  await assert.rejects(target.confirmMonth(ctx({version:2,visits:'11',newCustomers:'0',projects:'20'})),/不可修改/);
  await assert.rejects(target.saveWeek(ctx({version:2,sales:'20',consumption:'30',visits:'1.5',newCustomers:'0',projects:'2'})),/非负整数/);
  for(let i=0;i<3;i++){Date.now=()=>Date.parse(weeks[i].start+'T04:00:00Z');const c=ctx({version:i+2,sales:'20',consumption:'30',visits:'2',newCustomers:'0',projects:'3'});await target.saveWeek(c);if(i===2){assert.equal(c.result.target.weeks.w4.visits,4);assert.equal(c.result.target.weeks.w4.newCustomers,0);assert.equal(c.result.target.weeks.w4.projects,11);}}
  // 旧版两项请求更新当前周时，已有计数值不能被清空。
  const legacy=ctx({version:5,sales:'21',consumption:'31'});await target.saveWeek(legacy);assert.equal(legacy.result.target.weeks.w3.visits,2);
  Date.now=()=>Date.parse(date(27)+'T04:00:00Z');await assert.rejects(target.saveWeek(ctx({version:6,sales:'1',consumption:'1',visits:'1',newCustomers:'0',projects:'1'})),/最后一周/);
 }finally{Date.now=real;await pg.query('DELETE FROM daily_operating_targets WHERE period_id=$1',[id]);await pg.query('DELETE FROM daily_operating_periods WHERE id=$1',[id]);await pg.getPool().end();}
});
