// L3：真实微信视图；显式COVER_WINDOW_PG_TEST_URL时体验卡走完整迁移私有PG与真实product路由。
// 默认合成API回包；订单始终合成200明细，产品入口只在ignored编译产物启用。
import { createRequire } from 'node:module'
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { startCoverWindowPgFixture } from './cover-window-pg-fixture.mjs'
const require=createRequire(import.meta.url)
const Launcher=require('miniprogram-automator/out/Launcher.js').default
const root=fileURLToPath(new URL('../../../',import.meta.url));
const source=join(root,'fengyu-client/miniprogram');
const output=join(root,'_tmp/issue-273/compiled-client');
mkdirSync(output,{recursive:true});
cpSync(source,output,{recursive:true,filter:path=>!/(?:^|\/)(node_modules|__tests__)(?:\/|$)/.test(path) && !path.endsWith('.ts') && !path.endsWith('project.private.config.json')});
execFileSync(join(source,'node_modules/.bin/tsc'),['-p',join(source,'tsconfig.json'),'--outDir',output],{stdio:'pipe'});
const config=JSON.parse(readFileSync(join(source,'project.config.json'),'utf8'));
config.setting.useCompilerPlugins=[];config.setting.packNpmManually=false;config.libVersion='3.14.3';config.condition={};
writeFileSync(join(output,'project.config.json'),JSON.stringify(config));
writeFileSync(join(output,'project.private.config.json'),JSON.stringify({libVersion:'3.14.3',setting:{urlCheck:true}}));
// 产品源码订单入口保持关闭；仅编译测试产物开启，验证既有隐藏页的窗口。
const flag=join(output,'utils/feature-flags.js');writeFileSync(flag,readFileSync(flag,'utf8').replace('exports.ORDERS_ENTRY_ENABLED = false','exports.ORDERS_ENTRY_ENABLED = true'));
const port=Number(process.env.COVER_WINDOW_AUTO_PORT||9432);
execFileSync('/Applications/wechatwebdevtools.app/Contents/MacOS/cli',['auto','--project',output,'--auto-port',String(port),'--trust-project'],{timeout:60000,stdio:'pipe'});
// RC工具缺失版本握手字段，包的checkVersion会报错；直接连接同一协议并核验真实SDK。
let mp;let lastError;
for(let attempt=0;attempt<20;attempt++){try{const candidate=await new Launcher().connectTool({wsEndpoint:`ws://127.0.0.1:${port}`});const info=await candidate.systemInfo();if(info.SDKVersion!=='3.14.3'){candidate.disconnect();throw new Error('模拟器尚未完成编译')}assert.equal(info.platform,'devtools');mp=candidate;break;}catch(error){lastError=error;await new Promise(r=>setTimeout(r,1000));}}
if(!mp)throw lastError;
let pgServer=null;
mp.on('console',event=>{if(event.level==='error')console.log('微信页面错误',event.args)});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 if(process.env.COVER_WINDOW_PG_TEST_URL) {
  pgServer=await startCoverWindowPgFixture(process.env.COVER_WINDOW_PG_TEST_URL);
  await mp.exposeFunction('__coverPgRequest',async (key,payload)=>{
   let result;try{result=await pgServer.invoke(payload)}catch(error){result={result:{code:-1,message:error.message}}}
   await mp.evaluate((key,result)=>{const resolve=wx.__coverPgResolvers[key];delete wx.__coverPgResolvers[key];resolve(result)},key,result);
  });
  assert.equal((await pgServer.invoke({limit:20})).result.data.skuList.length,20);
  console.log('真实PG路由探针：20条；未绑定市场0条；真实缩略URL通过');
 }
 await mp.evaluate((realPg)=>{
  wx.__coverPgResolvers={};let requestId=0;
  wx.setStorageSync('clientLoggedOut',false);
  wx.__originalCallFunction=wx.cloud.callFunction;
  wx.cloud.callFunction=async function(options) {
   const {action,payload}=options.data;
   let data={};
   if(action==='product.experienceCardList' && wx.__coverFailNext) { wx.__coverFailNext=false; throw new Error('合成翻页网络故障'); }
   if(action==='product.experienceCardList' && realPg) return await new Promise(resolve=>{const key=String(++requestId);wx.__coverPgResolvers[key]=resolve;__coverPgRequest(key,payload)});
   if(action==='product.experienceCardList') {
    const offset=Number(payload.cursor||0); const end=Math.min(200,offset+20);
    data={skuList:Array.from({length:end-offset},(_,i)=>({sku_id:'S'+(i+offset),product_name:'合成卡'+(i+offset),spec_name:'测试',cover_image:'/images/icons/tab-home-active.png',price:100,session_count:1,unit:'次'})),hasMore:end<200,nextCursor:end<200?String(end):null}
   }
   if(action==='order.list') data={orders:[{sale_order_id:'O-test',status:'已支付',sale_order_type:'销售单',total_amount:200,received:200,sale_order_datetime:'2026-10-01',items:Array.from({length:200},(_,i)=>({sale_item_id:'I'+i,product_name:'合成明细'+i,cover_image:'/images/icons/tab-home-active.png',quantity:1,sale_amount:1,product_type:'家居产品',remaining_sessions:null}))}],hasMore:false};
   return {result:{code:0,message:'success',data}}
  };
 },Boolean(pgServer));

 let page=await mp.navigateTo('/pagesExperience/list/list');await wait(1000);
 console.log('experience-first', (await page.data()).skuList.length);
 async function waitData(predicate,label){for(let i=0;i<40;i++){const data=await page.data();if(predicate(data))return data;await wait(100)}throw new Error(label+'超时')}
 // 从真实按钮触发翻页，先让第二页失败，再点击同一按钮恢复原游标。
 await mp.evaluate(()=>{wx.__coverFailNext=true});
 await (await page.$('.load-more-btn')).tap();
 await waitData(data=>data.loadMoreError && !data.loadingMore,'翻页错误态');
 assert.equal((await page.data()).skuList.length,20);
 assert.match(await (await page.$('.load-more-btn')).text(),/点击重试/);
 await (await page.$('.load-more-btn')).tap();
 await waitData(data=>data.skuList.length===40 && !data.loadingMore,'翻页重试');
 assert.equal((await page.data()).loadMoreError,false);
 for(let end=60;end<=200;end+=20){await (await page.$('.load-more-btn')).tap();await waitData(data=>data.skuList.length===end && !data.loadingMore,'按钮翻页')}
 assert.equal(await page.$('.load-more-btn'),null);
 assert.equal((await page.data()).skuList.length,200);
 async function snapshot(label,key,selector) {
  // 在同一次原生测量回包中读取几何和cover标记，避免两次协议往返之间渲染已更新。
  let state;
  for(let attempt=0;attempt<30;attempt++) {
   state=await mp.evaluate((key,selector)=>new Promise(resolve=>{
    const p=getCurrentPages().slice(-1)[0];
    wx.createSelectorQuery().in(p).selectAll(selector).fields({rect:true,dataset:true}).selectViewport().fields({size:true}).exec(([slots,view])=>{
     const rows=p.data[key];
     resolve({rows:rows.length,visible:rows.flatMap((r,i)=>r.coverVisible?[i]:[]),missing:slots.filter(r=>r.top<view.height && r.bottom>0 && !rows[Number(r.dataset.idx)].coverVisible).map(r=>r.dataset.idx),height:view.height});
    });
   }),key,selector);
   assert(state.height>0,label+'必须获得实际视口尺寸');
   if(state.missing.length===0)break;
   await wait(100);
  }
  const images=await page.$$(selector+' image');
  console.log(label,{...state,images:images.length,scroll:await page.scrollTop()});
  assert(state.visible.length<=24);assert(images.length<=24);
  assert.deepEqual(state.missing,[],label+'可视封面不能被上限裁掉');
  return state.visible;
 }
 await snapshot('experience-top','skuList','.experience-cover-slot');
 await mp.pageScrollTo(999999);const bottom=await snapshot('experience-bottom','skuList','.experience-cover-slot');assert(bottom.includes(199));assert(!bottom.includes(0));
 await mp.pageScrollTo(0);const top=await snapshot('experience-return','skuList','.experience-cover-slot');assert(top.includes(0));assert(!top.includes(199));
 page=await mp.navigateTo('/pagesOrder/orders/orders');await wait(1000);assert.equal((await page.data()).coverRows.length,200);
 await snapshot('orders-top','coverRows','.order-cover-slot');await mp.pageScrollTo(999999);const ob=await snapshot('orders-bottom','coverRows','.order-cover-slot');assert(ob.includes(199));assert(!ob.includes(0));
 await mp.pageScrollTo(6000);await snapshot('orders-middle','coverRows','.order-cover-slot');
 await mp.pageScrollTo(0);const ot=await snapshot('orders-return','coverRows','.order-cover-slot');assert(ot.includes(0));assert(!ot.includes(199));
 await page.callMethod('onTabChange',{detail:{name:'已支付'}});
 await waitData(data=>data.activeTab==='已支付' && !data.isLoading && data.coverRows.length===200,'切Tab');
 await mp.pageScrollTo(999999);await snapshot('orders-tab-bottom','coverRows','.order-cover-slot');
 page=await mp.navigateBack();
 assert.equal((await page.data()).skuList.length,200);
 assert.equal((await page.data()).hasMore,false);
 await snapshot('experience-navigate-back','skuList','.experience-cover-slot');
 await mp.evaluate(()=>{wx.__originalObserver=wx.createIntersectionObserver;wx.createIntersectionObserver=()=>{throw new Error('synthetic unavailable')};});
 page=await mp.navigateTo('/pagesExperience/list/list');await wait(1000);for(let i=0;i<9;i++){await page.callMethod('loadList',true);await wait(150)}
 await mp.pageScrollTo(999999);const fb=await snapshot('fallback-bottom','skuList','.experience-cover-slot');assert(fb.includes(199));assert(!fb.includes(0));
 await mp.pageScrollTo(0);const ft=await snapshot('fallback-return','skuList','.experience-cover-slot');assert(ft.includes(0));assert(!ft.includes(199));
 page=await mp.navigateTo('/pagesOrder/orders/orders');await wait(1000);await mp.pageScrollTo(6000);await snapshot('orders-fallback-middle','coverRows','.order-cover-slot');await mp.pageScrollTo(999999);await snapshot('orders-fallback-bottom','coverRows','.order-cover-slot');
 console.log('PASS 200实际视图槽位/有界image节点/往返滚动/原生测量回退')
}finally{await mp.evaluate(()=>{if(wx.__originalCallFunction){wx.cloud.callFunction=wx.__originalCallFunction;delete wx.__originalCallFunction;}delete wx.__coverFailNext;if(wx.__originalObserver){wx.createIntersectionObserver=wx.__originalObserver;delete wx.__originalObserver}}).catch(()=>{});mp.disconnect();if(pgServer)await pgServer.close()}
