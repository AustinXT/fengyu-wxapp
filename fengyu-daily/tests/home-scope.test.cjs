const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function boot() {
 let page, context='A'; const calls=[], messages=[];
 const state={fail:false};
 const code=ts.transpileModule(fs.readFileSync(__dirname+'/../miniprogram/pages/home/home.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{exports:{},Page:p=>page=p,wx:{showToast:o=>messages.push(o.title)},require:n=>n.endsWith('/session')?{identityContext:()=>context,sessionContext:()=>context,sessionChanged:()=>Error('changed')}:n.endsWith('/workspace')?{login:async()=>({user:{employeeId:'u',managerStores:[]},workspace:'management'}),syncTabs(){}}:{today:()=> '2026-10-09',showError(){},callApi:async(a,p)=>{calls.push(p);if(state.fail)throw Error('network');return {nodes:[{id:'a',type:'市场',name:'甲'},{id:'b',type:'市场',name:'乙'}]};}}});
 page.setData=p=>Object.assign(page.data,p);return{page,calls,messages,state,change:()=>context='B'};
}
const event=period=>({currentTarget:{dataset:{period}}});
test('多市场全范围切周不发非法请求；选择市场后可看周，返回全部自动回今日',async()=>{
 const {page,calls,messages}=boot();await page.load();page.periodChange(event('week'));
 assert.equal(page.data.period,'today');assert.equal(calls.length,1);assert.equal(messages.length,1);
 page.scopeChange({detail:{value:'1'}});await new Promise(r=>setImmediate(r));
 page.periodChange(event('week'));await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).nodeId,'a');assert.equal(calls.at(-1).period,'week');
 page.scopeChange({detail:{value:'0'}});await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).period,'today');
});
test('换身份清空旧周选择；旧非法状态重试恢复今日；失败仍保留市场选项',async()=>{
 const {page,calls,state,change}=boot();await page.load();page.setData({period:'month',scopeIndex:1});change();await page.load();assert.equal(calls.at(-1).period,'today');assert.equal(calls.at(-1).nodeId,undefined);
 page.setData({period:'week',scopeIndex:0,scopes:[{id:'',name:'全部'}]});await page.load();assert.equal(calls.at(-1).period,'today');
 state.fail=true;await page.load();assert.equal(page.data.error,true);assert.equal(page.data.scopes.length,3);assert.equal(page.data.overview,null);
 state.fail=false;page.scopeChange({detail:{value:'2'}});await new Promise(r=>setImmediate(r));assert.equal(page.data.error,false);assert.equal(calls.at(-1).nodeId,'b');
});
test('单市场全范围仍能直接看经营月',async()=>{const {page,calls}=boot();await page.load();page.data.scopes.pop();page.periodChange(event('month'));await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).period,'month');});
