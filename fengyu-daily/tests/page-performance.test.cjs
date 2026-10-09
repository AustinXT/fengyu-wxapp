const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function boot(name,api) {
  let page,context='A';
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,`../miniprogram/pages/${name}/${name}.ts`),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(code,{exports:{},Page:p=>{page=p;},wx:{},require:file=>file.endsWith('/session')?{sessionContext:()=>context,expireLogin(){}}:file.endsWith('/route')?{decodeRouteId:x=>x||''}:{callApi:api,showError(){},today:()=> '2026-10-09'}});
  page.setData=p=>Object.assign(page.data,p);
  return{page,change:()=>{context='B';}};
}
const period={id:'p',name:'经营月',start:'2026-10-01',end:'2026-10-31'};
test('PK首次一次取班级，打开班级只读榜单，切指标不请求并使用对应服务端排名',async()=>{
  const calls=[];const value={weekTarget:100,weekDone:50,monthTarget:100,monthDone:50};
  const {page}=boot('pk',async(action,payload)=>{calls.push({action,payload});return action==='pk.classes'?{period,periods:[period],classes:[{id:'c',name:'班',members:2}],scopeLabel:'授权'}:{week:{name:'周'},scopeLabel:'授权',rows:[{employeeId:'a',rank:1,rankByMetric:{sales:1,consumption:2},sales:value,consumption:value},{employeeId:'b',rank:2,rankByMetric:{sales:2,consumption:1},sales:value,consumption:value}]};});
  await page.load();assert.deepEqual(calls.map(c=>c.action),['pk.classes']);
  page.setData({selectedClass:true});await page.load(false);assert.deepEqual(calls.map(c=>c.action),['pk.classes','pk.read']);
  page.metricChange({currentTarget:{dataset:{metric:'consumption'}}});assert.deepEqual(Array.from(page.data.rows,r=>r.employeeId),['b','a']);assert.equal(calls.length,2);
  page.metricChange({currentTarget:{dataset:{metric:'sales'}}});assert.deepEqual(Array.from(page.data.rows,r=>r.employeeId),['a','b']);assert.equal(calls.length,2);
});
test('记录初始化一次返回周期与历史，返回时保留内容；切身份旧请求不能覆盖新内容',async()=>{
  const calls=[];let resolveOld;
  const {page,change}=boot('history',async(action,payload)=>{calls.push({action,payload});if(calls.length===2)return new Promise(r=>{resolveOld=r;});return {employee:{name:calls.length===1?'A':'B'},own:true,reports:[{id:calls.length===1?'old':'new'}],periods:[period],period,summary:null};});
  await page.load();assert.equal(calls.length,1);assert.equal(calls[0].action,'report.history');assert.equal(calls[0].payload.includePeriods,true);
  const refresh=page.load();assert.equal(page.data.ready,true);assert.equal(page.data.reports[0].id,'old');
  change();await page.load();assert.equal(page.data.employee.name,'B');assert.equal(calls[2].payload.includePeriods,true);
  resolveOld({employee:{name:'A'},reports:[{id:'late'}],summary:null});await refresh;
  assert.equal(page.data.reports[0].id,'new');assert.equal(page.data.employee.name,'B');
});
