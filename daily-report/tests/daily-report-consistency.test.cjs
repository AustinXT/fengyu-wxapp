const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../daily-summary-miniapp-v2.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const key='fengyu-daily-reports-v1';
function storage(){return {items:new Map(),fail:false,getItem(k){return this.items.get(k)??null;},setItem(k,v){if(this.fail)throw Error('quota');this.items.set(k,String(v));}};}
function boot(localStorage=storage()){
  const context=vm.createContext({localStorage,structuredClone,setTimeout,clearTimeout});
  const stop=scripts[0].indexOf('document.addEventListener("input"');
  vm.runInContext(scripts[0].slice(0,stop)+`
    render=()=>{};showToast=message=>{state.toast=message};openPage=page=>{state.page=page};
    initializeReports();
    globalThis.api={data,state,records,loadFormFromRecord,saveCurrent,detailPage,fillPage,recordsForMonth,reportStats,submissionStats,captureSnapshot,businessForReport,legacySummary,dailyNotes,copyLast,entryBusiness,businessCard,personalReportContent,homePage,pkClassesPage,pkPage,goalPage};
  })();`,context);
  return {api:context.api,localStorage};
}
const plain=value=>JSON.parse(JSON.stringify(value));
const today=(api,id)=>api.records(id).find(r=>r.date===api.data.today);

test('所有内联脚本语法合法',()=>{for(const script of scripts)new vm.Script(script);});
test('日报列表仅显示一行简短摘要，完整业务仍在详情页',()=>{
  const {api}=boot();const list=api.personalReportContent(api.data.employees.find(p=>p.id==='zhang'));
  assert.match(list,/<p>关联 3 条业务<\/p>/);assert.match(list,/list-card daily-record/);
  assert.doesNotMatch(list,/李女士|张三的演示顾客|面部护理|居家护理产品/);
  api.state.selectedEmployee='zhang';api.state.selectedRecordDate='2026-07-05';assert.match(api.detailPage(),/张三的演示顾客/);
  assert.ok(/\.daily-record p\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/.test(html));
});
test('初始化保留旧版文字、标签、业务、指导关系；刷新不重新生成',()=>{
  const {api,localStorage}=boot(),row=today(api,'zhang');
  assert.match(row.summary,/今日行动：已完成重点客户回访/);
  assert.match(row.summary,/今日成长：/);assert.match(row.summary,/明日计划：/);
  api.loadFormFromRecord(row);assert.equal(api.state.form.mentor,'李老师');assert.equal(api.state.form.entries.length,3);
  const raw=localStorage.getItem(key);boot(localStorage);assert.equal(localStorage.getItem(key),raw);
});
test('三项独立填写、保存、刷新及只读分别展示，空值不会复活旧文字',()=>{
  const {api,localStorage}=boot();api.loadFormFromRecord(today(api,'zhang'));
  assert.equal(api.state.form.action,'已完成重点客户回访。');assert.equal(api.state.form.summary,'');
  const edit=api.fillPage();for(const field of ['action','growth','plan'])assert.match(edit,new RegExp(`data-form-field="${field}"`));assert.doesNotMatch(edit,/data-form-field="summary"/);
  Object.assign(api.state.form,{action:'回访客户\n预约到店',growth:'沟通复盘 <内容>',plan:'',dirty:true});assert.equal(api.saveCurrent('draft'),true);
  const refreshed=boot(localStorage).api;refreshed.loadFormFromRecord(today(refreshed,'zhang'));
  assert.equal(refreshed.state.form.action,'回访客户\n预约到店');assert.equal(refreshed.state.form.growth,'沟通复盘 <内容>');assert.equal(refreshed.state.form.plan,'');assert.equal(refreshed.state.form.summary,'');
  refreshed.saveCurrent('submitted');const detail=refreshed.detailPage();
  assert.match(detail,/section-title">今日行动<\/div><p[^>]*>回访客户\n预约到店/);assert.match(detail,/section-title">今日成长<\/div><p[^>]*>沟通复盘 &lt;内容&gt;/);assert.match(detail,/section-title">明日计划<\/div><p[^>]*>未填写/);
  assert.doesNotMatch(detail,/今日行动：|其他补充（保留原内容）/);
});
test('兼容旧合并文字及未分类内容，不覆盖最近保存的文字',()=>{
  const {api}=boot();
  const merged={action:'旧行动',growth:'旧成长',plan:'旧计划',summary:'保留前言\n今日行动：新的行动\n第二行\n今日成长：新的成长\n明日计划：新的计划'};
  assert.deepEqual(plain(api.dailyNotes(merged)),{action:'新的行动\n第二行',growth:'新的成长',plan:'新的计划',summary:'保留前言'});
  assert.deepEqual(plain(api.dailyNotes({summary:'今日行动：行动 今日成长：成长 明日计划：计划'})),{action:'行动',growth:'成长',plan:'计划',summary:''});
  assert.deepEqual(plain(api.dailyNotes({action:'原行动',summary:'没有标签的旧补充'})),{action:'原行动',growth:'',plan:'',summary:'没有标签的旧补充'});
});
test('复制上次补充分别带入三项，不改变当前关联业务',()=>{
  const {api}=boot();api.loadFormFromRecord(today(api,'zhang'));const entries=plain(api.state.form.entries),last=api.records('zhang').find(r=>r.date==='2026-07-05');
  api.copyLast();const expected=api.dailyNotes(last);for(const field of ['action','growth','plan','summary'])assert.equal(api.state.form[field],expected[field]);assert.deepEqual(plain(api.state.form.entries),entries);
});
for(const [role,id] of [['employee','zhang'],['manager','zhao']]){
  test(`${role} 草稿保存、刷新、提交、详情、重新提交数据一致`,()=>{
    const {api,localStorage}=boot();api.state.role=role;
    // 店长当天默认为已提交，先以无记录的方式演示新建草稿。
    if(role==='manager'){api.data.records[id]=api.records(id).filter(r=>r.date!==api.data.today);localStorage.setItem(key,JSON.stringify({version:1,items:Object.fromEntries(Object.entries(api.data.records).flatMap(([owner,rows])=>rows.map(r=>[`${owner}:${r.date}`,r])))}));}
    api.loadFormFromRecord(today(api,id));
    Object.assign(api.state.form,{summary:'整日补充\n包含 <特殊字符>',mentor:'指导甲',peer:'同事乙',dirty:true});
    api.state.form.entries[0].feedback='服务反馈\n跨行测试';api.state.form.entries[0].issue='后续跟进测试';
    const original=plain(api.state.form);
    assert.equal(api.saveCurrent('draft'),true);
    const loaded=boot(localStorage).api;loaded.state.role=role;loaded.loadFormFromRecord(today(loaded,id));
    for(const field of ['entries','action','growth','plan','summary','mentor','peer','actual','period','date'])assert.deepEqual(plain(loaded.state.form[field]),original[field]);
    const before=loaded.reportStats(id).submitted;
    assert.equal(loaded.saveCurrent('submitted'),true);assert.equal(loaded.reportStats(id).submitted,before+1);
    const row=today(loaded,id);assert.deepEqual(plain(row.entries),original.entries);assert.deepEqual(plain(row.snapshot.day),original.actual);
    const detail=loaded.detailPage();assert.match(detail,/服务反馈\n跨行测试/);assert.match(detail,/后续跟进测试/);assert.match(detail,/指导甲/);assert.match(detail,/&lt;特殊字符&gt;/);
    loaded.loadFormFromRecord(row);loaded.state.form.entries[0].feedback='再次提交';loaded.state.editingSubmitted=true;
    assert.equal(loaded.saveCurrent('submitted'),true);assert.equal(loaded.reportStats(id).submitted,before+1);
    const reloaded=boot(localStorage).api;assert.equal(today(reloaded,id).entries[0].feedback,'再次提交');
  });
}
test('历史草稿保存到原日期，不误写今天；历史已提交只读',()=>{
  const {api}=boot(),todayCopy=plain(today(api,'zhang'));const row=api.records('zhang').find(r=>r.date==='2026-07-04');
  row.status='draft';api.loadFormFromRecord(row);api.state.form.summary='历史草稿修改';assert.equal(api.saveCurrent('draft'),true);
  assert.deepEqual(plain(today(api,'zhang')),todayCopy);assert.equal(api.dailyNotes(api.records('zhang').find(r=>r.date==='2026-07-04')).summary,'历史草稿修改');
  api.loadFormFromRecord(api.records('zhang').find(r=>r.date==='2026-07-04'));assert.equal(api.saveCurrent('submitted'),true);
  api.state.selectedEmployee='zhang';api.state.selectedRecordDate='2026-07-04';assert.doesNotMatch(api.detailPage(),/data-action="edit-today"/);
  assert.equal(api.saveCurrent('submitted'),false);
});
test('金额、周期、目标快照独立于当前配置；店长读取门店目标',()=>{
  const local=storage();local.setItem('fengyu-daily-targets-v3',JSON.stringify({'store:westlake:2026-07':{sales:{month:900000,weeks:{w2:190000}},consumption:{month:600000,weeks:{w2:120000}}},'personal:zhao:2026-07':{sales:{month:1,weeks:{w2:1}},consumption:{month:1,weeks:{w2:1}}}}));
  const {api}=boot(local),row=today(api,'zhao'),snapshot=plain(row.snapshot),period=plain(row.period);
  assert.equal(snapshot.scope,'store');assert.equal(snapshot.month.sales.target,900000);assert.equal(snapshot.week.sales.target,190000);
  local.setItem('fengyu-daily-targets-v3','{}');local.setItem('fengyu-daily-periods-v2',JSON.stringify({monthStart:'2026-06-24',monthEnd:'2026-07-23',weeks:[{start:'2026-07-01',end:'2026-07-07',name:'新经营周'}]}));
  const refreshed=boot(local).api;assert.deepEqual(plain(today(refreshed,'zhao').snapshot),snapshot);assert.deepEqual(plain(today(refreshed,'zhao').period),period);
  refreshed.state.role='manager';refreshed.loadFormFromRecord(today(refreshed,'zhao'));refreshed.state.form.summary='仅修改反馈';refreshed.saveCurrent('submitted');assert.deepEqual(plain(today(refreshed,'zhao').snapshot),snapshot);
});
test('人员隔离、不同标签页保存不覆盖其他人的记录',()=>{
  const {api,localStorage}=boot(),other=boot(localStorage).api;
  api.loadFormFromRecord(today(api,'zhang'));api.state.form.summary='员工保存';api.saveCurrent('draft');
  other.state.role='manager';other.loadFormFromRecord(today(other,'zhao'));other.state.form.summary='店长保存';other.saveCurrent('submitted');
  const refreshed=boot(localStorage).api;assert.equal(refreshed.dailyNotes(today(refreshed,'zhang')).summary,'员工保存');assert.equal(refreshed.dailyNotes(today(refreshed,'zhao')).summary,'店长保存');
  assert.notEqual(today(refreshed,'zhang').entries[0].id,today(refreshed,'zhao').entries[0].id);
});
test('其他身份无权读取草稿，无权保存他人记录',()=>{
  const {api}=boot();api.state.role='manager';api.state.selectedEmployee='zhang';api.state.selectedRecordDate='2026-07-06';assert.match(api.detailPage(),/不能查看草稿内容/);assert.doesNotMatch(api.detailPage(),/已完成重点客户回访/);
  api.state.role='admin';assert.match(api.detailPage(),/不能查看草稿内容/);api.loadFormFromRecord(today(api,'zhang'));assert.equal(api.saveCurrent('submitted'),false);
});
test('月份按经营月日期范围筛选，没有临时复制；应交不含未来',()=>{
  const {api,localStorage}=boot();assert.deepEqual(plain(api.reportStats('zhang')),{due:11,submitted:2,missing:9,rate:18});
  const raw=localStorage.getItem(key);api.state.selectedMonth='2026-06';assert.equal(api.recordsForMonth('zhang').length,1);assert.equal(api.recordsForMonth('zhang')[0].date,'2026-06-25');assert.equal(api.reportStats('zhang').due,31);assert.equal(localStorage.getItem(key),raw);
  api.state.selectedMonth='2026-07';api.data.records.zhang.push({...today(api,'zhang'),date:'2026-07-20',status:'submitted'});assert.equal(api.reportStats('zhang').submitted,2);assert.ok(api.recordsForMonth('zhang').every(r=>r.date<=api.data.today));
});
test('实际统计同步到本店和人员概况，不使用固定数字',()=>{
  const {api}=boot(),people=api.data.employees.filter(p=>p.storeId==='westlake');const before=api.submissionStats(people,'today');api.loadFormFromRecord(today(api,'zhang'));api.saveCurrent('submitted');assert.equal(api.submissionStats(people,'today').submitted,before.submitted+1);
});
test('存储失败不改原记录或显示成功，保留编辑内容',()=>{
  const {api,localStorage}=boot(),row=plain(today(api,'zhang'));api.loadFormFromRecord(today(api,'zhang'));api.state.form.summary='未能保存';api.state.form.dirty=true;localStorage.fail=true;
  assert.equal(api.saveCurrent('submitted'),false);assert.deepEqual(plain(today(api,'zhang')),row);assert.equal(api.state.form.dirty,true);assert.match(api.state.toast,/保存失败/);assert.doesNotMatch(api.state.toast,/已提交/);
});
test('损坏存储不覆盖、不回填他人或今天的业务',()=>{
  const local=storage();local.setItem(key,'broken');const {api}=boot(local);assert.equal(local.getItem(key),'broken');assert.equal(api.records('zhang').length,0);assert.match(api.homePage(),/存储读取失败/);
  api.data.records.zhang=[{ownerId:'zhang',date:'2026-07-04',status:'submitted',summary:'旧内容',entries:[{id:'unknown',feedback:'原反馈'}]}];api.state.selectedRecordDate='2026-07-04';assert.match(api.detailPage(),/业务明细未保存/);assert.match(api.detailPage(),/未保存完整经营快照/);
  api.loadFormFromRecord(api.records('zhang')[0]);assert.equal(api.state.form.actual,null);assert.equal(api.state.form.entries[0].id,'unknown');
});
test('编辑与只读渲染共用业务字段顺序，反馈转义且保留换行',()=>{
  const {api}=boot(),entry=today(api,'zhang').entries[0];entry.feedback='<script>\n多行';const edit=api.businessCard(entry),detail=api.businessCard(entry,true);
  for(const output of [edit,detail]){assert.match(output,/&lt;script&gt;\n多行/);assert.ok(output.indexOf('业务日期')<output.indexOf('本次核销'));assert.ok(output.indexOf('服务反馈 / 顾客反馈')<output.indexOf('后续跟进'));}
  assert.doesNotMatch(detail,/<textarea|data-remove-business/);
});
test('PK、目标页面仍可渲染，窄屏布局保留滚动与底部操作区',()=>{
  const {api}=boot();assert.match(api.pkClassesPage(),/浙江红军/);assert.match(api.pkPage(),/业绩榜/);assert.match(api.goalPage(),/经营目标/);
  api.loadFormFromRecord(today(api,'zhang'));assert.match(api.fillPage(),/content with-actions/);assert.match(api.fillPage(),/bottom-actions/);
  assert.ok(/\.content\s*\{[^}]*overflow:\s*auto/.test(html),'内容区保持可滚动');
});
test('完整页面初始化及真实事件处理：草稿输入、保存、重新打开、提交',()=>{
  const localStorage=storage(),events={},screen={innerHTML:'',querySelector(){return null;}},classes=new Set();
  const document={body:{classList:{contains:c=>classes.has(c),toggle(c,on){if(on)classes.add(c);else classes.delete(c);}}},addEventListener:(name,handler)=>events[name]=handler,getElementById:()=>screen,querySelectorAll:()=>[],querySelector:()=>null};
  const context=vm.createContext({localStorage,structuredClone,document,window:{addEventListener(){},scrollTo(){}},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(scripts[0],context);assert.match(screen.innerHTML,/我的日报/);
  const click=dataset=>events.click({target:{closest(selector){if(selector==='#app-screen')return screen;if(selector==='[data-action]'&&dataset.action)return {dataset};if(selector==='[data-record-date]'&&dataset.recordDate)return {dataset};return null;}}});
  click({action:'go-fill'});assert.match(screen.innerHTML,/data-form-field="action"[^>]*>已完成重点客户回访/);
  events.input({target:{dataset:{entryId:'FW-0706-018',entryKey:'feedback'},value:'事件输入的反馈',matches:s=>s==='[data-entry-id]'}});
  click({action:'save-draft'});click({recordOwner:'zhang',recordDate:'2026-07-06'});assert.match(screen.innerHTML,/事件输入的反馈/);
  click({action:'submit-summary'});assert.match(screen.innerHTML,/日报详情/);assert.match(screen.innerHTML,/事件输入的反馈/);assert.doesNotMatch(screen.innerHTML,/<textarea/);
});
