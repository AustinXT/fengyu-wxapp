const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../../node_modules/typescript');
const root = path.resolve(__dirname, '../../../miniprogram');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function page(name, api = async () => ({})) {
  let config;
  const urls = [], errors = [], calls = [];
  const wx = { navigateTo: o => urls.push(o.url), redirectTo: o => urls.push(o.url),
    getStorageSync: () => 'employee', setNavigationBarTitle() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, showToast() {} };
  const cloud = {callApi: (action,payload) => {calls.push([action,payload]);return api(action,payload);}, today: () => '2026-10-07',showError: e => errors.push(e.message)};
  const compiled = file => ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const route = { exports: {} };
  vm.runInNewContext(compiled(path.join(root,'utils/route.ts')), {exports:route.exports,require:()=>cloud});
  vm.runInNewContext(compiled(path.join(root,`pages/${name}/${name}.ts`)),{
    exports:{},Page:p=>config=p,wx,require:n=>n.endsWith('/route')?route.exports:cloud,
  });
  config.data = JSON.parse(JSON.stringify(config.data));
  config.setData = function(patch){Object.assign(this.data,patch);};
  return {p:config,urls,errors,calls};
}
const event = dataset => ({currentTarget:{dataset}});
const editorData = (overrides = {}) => ({report:{status:'draft',version:2,mentor_employee_id:'mentor',peer_employee_id:'peer',action:'原正文'},entries:[],readOnly:false,metrics:{guidance:{mentor:{name:'原指导员'},peer:{name:'原同事'}}},...overrides});
test('首页今日/最近、员工记录、个人历史已提交直达详情，草稿仍填写',()=>{
  for(const name of ['home','workbench','history']){
    const {p,urls,calls}=page(name);
    const open = name==='home'?'openRecent':'open';
    p[open](event({status:'submitted',id:'日报/%',date:'2026-10-07'}));
    assert.equal(urls.pop(),'/pages/detail/detail?id='+encodeURIComponent('日报/%'));
    p[open](event({status:'draft',id:'draft',date:'2026-10-07'}));
    assert.equal(urls.pop(),'/pages/report/report?date=2026-10-07');assert.equal(calls.length,0);
  }
  const {p,urls}=page('home');p.data.status='已提交';p.report();assert.equal(urls.pop(),'/pages/detail/detail?date=2026-10-07');
  p.data.status='草稿';p.report();assert.equal(urls.pop(),'/pages/report/report?date=2026-10-07');
  for(const name of ['home','workbench','history']){
    const markup=fs.readFileSync(path.join(root,`pages/${name}/${name}.wxml`),'utf8');
    assert.match(markup,/data-status="\{\{item.status\}\}"/);assert.match(markup,/data-id="\{\{item.id\}\}"/);
  }
});
test('日报与联系人同时请求；慢联系人不阻塞正文，失败保留关系且允许保存',async()=>{
  const contact=deferred();
  const {p,calls,errors}=page('report',async(action,payload)=>{
    if(action==='contacts.list')return contact.promise;
    if(action==='report.read')return editorData();
    if(action==='report.save'){assert.equal(payload.mentorEmployeeId,'mentor');assert.equal(payload.peerEmployeeId,'peer');return {report:{version:3,status:'draft'}};}
  });
  await p.load();assert.equal(p.data.ready,true);assert.equal(p.data.loading,false);assert.equal(p.data.contactsLoading,true);
  assert.deepEqual(calls.map(c=>c[0]).slice(0,2),['contacts.list','report.read']);
  p.chooseContact({detail:{value:'0'},currentTarget:{dataset:{kind:'mentor'}}});assert.equal(p.data.mentorId,'mentor');
  contact.reject(Error('网络失败'));await tick();assert.equal(p.data.contactsError,true);assert.equal(p.data.mentorName,'原指导员');assert.equal(p.data.action,'原正文');assert.equal(errors.length,0);
  await p.write(false);assert.equal(p.data.version,3);assert.equal(p.data.mentorId,'mentor');
});
test('联系人重试只读联系人，成功匹配现存编号和姓名',async()=>{
  let attempts=0;
  const {p,calls}=page('report',async action=>{
    if(action==='report.read')return editorData();
    if(++attempts===1)throw Error('失败');return {contacts:[{employee_id:'mentor',name:'原指导员'},{employee_id:'peer',name:'原同事'}]};
  });
  await p.load();await tick();await p.retryContacts();
  assert.equal(p.data.contactsError,false);assert.equal(p.data.mentorIndex,1);assert.equal(p.data.peerIndex,2);assert.equal(calls.filter(c=>c[0]==='report.read').length,1);
});
test('切换日期或卸载后，旧联系人结果不覆盖新页面',async()=>{
  const first=deferred(),second=deferred();let n=0;
  const {p}=page('report',async action=> action==='report.read'?editorData(): (++n===1?first.promise:second.promise));
  await p.load();p.data.date='2026-10-06';await p.load();
  second.resolve({contacts:[{employee_id:'mentor',name:'新结果'}]});await tick();assert.equal(p.data.mentorName,'新结果');
  first.resolve({contacts:[{employee_id:'mentor',name:'旧结果'}]});await tick();assert.equal(p.data.mentorName,'新结果');
  const late=deferred();const other=page('report',async action=>action==='report.read'?editorData():late.promise).p;
  await other.load();other.onUnload();late.resolve({contacts:[]});await tick();assert.equal(other.data.contactsLoading,true);
});
test('已提交状态过期入口仍跳转详情，迟到联系人不更新；当日本人编辑及历史只读保留',async()=>{
  const contact=deferred();const {p,urls}=page('report',async action=>action==='report.read'?editorData({report:{id:'submitted',status:'submitted'}}):contact.promise);
  await p.load();assert.equal(urls[0],'/pages/detail/detail?id=submitted');contact.resolve({contacts:[{employee_id:'other',name:'迟到'}]});await tick();assert.equal(p.data.contacts.length,0);
  const edit=page('report',async action=>action==='report.read'?editorData({report:{id:'today',status:'submitted'},readOnly:false}):{contacts:[]});edit.p.data.editing=true;await edit.p.load();assert.equal(edit.p.data.ready,true);assert.equal(edit.urls.length,0);
  const old=page('report',async action=>action==='report.read'?editorData({report:{id:'old',status:'submitted'},readOnly:true}):{contacts:[]});old.p.data.editing=true;await old.p.load();assert.equal(old.urls[0],'/pages/detail/detail?id=old');
  const detail=page('detail');detail.p.data.canEdit=false;detail.p.edit();assert.equal(detail.urls.length,0);detail.p.data.canEdit=true;detail.p.data.report={report_date:'2026-10-07'};detail.p.edit();assert.equal(detail.urls[0],'/pages/report/report?edit=1&date=2026-10-07');
});
test('联系人尚未返回时可提交；提交后忽略迟到结果',async()=>{
  const contact=deferred();const {p,urls}=page('report',async action=>action==='report.read'?editorData():action==='contacts.list'?contact.promise:{report:{version:3,status:'submitted'}});
  await p.load();await p.write(true);assert.equal(urls[0],'/pages/detail/detail?date=2026-10-07');contact.resolve({contacts:[]});await tick();assert.equal(p.data.contacts.length,0);
});
test('组织/门店/员工/报告/目标范围参数只解码一次，非法编码不请求',async()=>{
  for(const [name,key,field] of [['range','nodeId','nodeId'],['manager','storeId','selectedStoreId'],['history','employeeId','employeeId'],['detail','id','id'],['goal','scopeId','scopeId']]){
    const h=page(name);h.p.load=async()=>{};h.p.initialize=async()=>{};
    const value='中文/%2F &';h.p.onLoad({[key]:encodeURIComponent(value)});assert.equal(h.p.data[field],value);
    const invalid=page(name);invalid.p.onLoad({[key]:'%zz'});if(invalid.p.onShow)invalid.p.onShow();await tick();assert.equal(invalid.calls.length,0);assert.equal(invalid.errors.length,1);assert.equal(invalid.p.data.routeInvalid,true);
  }
});
test('联系人空值短路，非空仍查询并拒绝越权',async()=>{
  const contacts=require('../routes/contacts');let count=0;
  const query=async()=>{count++;return [{employee_id:'allowed',name:'允许员工'}];};
  assert.deepEqual(await contacts.validate(query,{},null,null),{mentor:null,peer:null});assert.equal(count,0);
  assert.equal((await contacts.validate(query,{},'allowed',null)).mentor.name,'允许员工');assert.equal(count,1);
  await assert.rejects(contacts.validate(query,{},null,'outside'),/PERMISSION_DENIED/);assert.equal(count,2);
});
function reportRoute(old) {
  const statements = [], module = {exports:{}}, snapshot = {scope:'personal',period:{name:'周期'},day:{sales:100}};
  let captures = 0;
  const pg = {transaction: async fn => fn({query:async(sql,args)=>{
    statements.push([sql,args]);
    if(sql.includes('FOR UPDATE'))return {rows:old?[old]:[]};
    if(sql.includes('INSERT INTO daily_reports'))return {rows:[{id:args[0],status:args[6],metric_snapshot:JSON.parse(args[11])}]};
    return {rows:[]};
  }})};
  vm.runInNewContext(fs.readFileSync(require.resolve('../routes/report'),'utf8'),{module,console,require:name=>{
    if(name==='../db/pg')return pg;
    if(name==='./business')return {candidates:async()=>[]};
    if(name==='./contacts')return require('../routes/contacts');
    if(name==='./metrics')return {captureReportSnapshot:async()=>{captures++;return structuredClone(snapshot);},reportSnapshotForViewer:s=>s};
    return require(name);
  }});
  const validation = require('../utils/validation');
  const ctx = (version,date=validation.today())=>({auth:{employeeId:'self',storeId:'store',name:'员工',storeName:'门店'},event:{payload:{date,version,entries:[],action:'行动'}}});
  return {route:module.exports,ctx,statements,captures:()=>captures,snapshot};
}
test('日报版本冲突、已提交保存限制仍生效，提交仍冻结指标及指导关系',async()=>{
  const stale=reportRoute({id:'old',status:'draft',version:2});
  await assert.rejects(stale.route.save(stale.ctx(1)),/CONFLICT/);
  assert.ok(stale.statements.some(([sql])=>sql.includes('pg_advisory_xact_lock')));
  assert.equal(stale.statements.some(([sql])=>sql.includes('INSERT')),false);
  const submitted=reportRoute({id:'old',status:'submitted',version:2});
  await assert.rejects(submitted.route.save(submitted.ctx(2)),/INVALID_STATE/);
  await assert.rejects(submitted.route.submit(submitted.ctx(2,'2020-01-01')),/INVALID_STATE/);
  const fresh=reportRoute(null),ctx=fresh.ctx(0);await fresh.route.submit(ctx);
  assert.equal(fresh.captures(),1);assert.equal(ctx.result.report.metric_snapshot.day.sales,100);
  assert.deepEqual(ctx.result.report.metric_snapshot.guidance,{mentor:null,peer:null});
  const draft=reportRoute(null);await draft.route.save(draft.ctx(0));assert.equal(draft.captures(),0);
});

test('目标页按实际周数展示，只让最后一周自动取余额', async()=>{
  for(const count of [1,5]) {
    const weeks=Array.from({length:count},(_,i)=>({id:'v'+i,name:'周'+(i+1),start:'2026-10-01',end:'2026-10-31'}));
    const period={id:'variable',start:'2026-10-01',end:'2026-10-31',weeks};
    for(let current=0;current<count;current++) {
      const h=page('goal',async()=>({period,week:weeks[current],periods:[],target:{month_confirmed:true,counts_month_confirmed:true,sales:10000,consumption:20000,visits:10,newCustomers:0,projects:20,penalty:'复盘',weeks:Object.fromEntries(weeks.map(w=>[w.id,{sales:1000,consumption:2000}]))}}));
      await h.p.load();
      assert.equal(h.p.data.weeks.length,count);
      assert.equal(h.p.data.automatic,current===count-1);
      assert.equal(h.p.data.weeks.filter(w=>w.automatic).length,1);
      assert.equal(h.p.data.weeks[count-1].automatic,true);
    }
  }
});
