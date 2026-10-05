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
// 仅关闭本验收生成的项目，避免重编译触发旧自动化会话重复回包。
try { execFileSync('/Applications/wechatwebdevtools.app/Contents/MacOS/cli',['close','--project',output],{timeout:15000,stdio:'pipe'}); } catch {}
mkdirSync(output,{recursive:true});
cpSync(source,output,{recursive:true,filter:path=>!/(?:^|\/)(node_modules|__tests__)(?:\/|$)/.test(path) && !path.endsWith('.ts') && !path.endsWith('project.private.config.json')});
execFileSync(join(source,'node_modules/.bin/tsc'),['-p',join(source,'tsconfig.json'),'--outDir',output],{stdio:'pipe'});
const config=JSON.parse(readFileSync(join(source,'project.config.json'),'utf8'));
config.appid='touristappid';
config.setting.useCompilerPlugins=[];config.setting.packNpmManually=false;config.libVersion='3.14.3';config.condition={};
writeFileSync(join(output,'project.config.json'),JSON.stringify(config));
writeFileSync(join(output,'project.private.config.json'),JSON.stringify({libVersion:'3.14.3',setting:{urlCheck:true}}));
// 产品源码订单入口保持关闭；仅编译测试产物开启，验证既有隐藏页的窗口。
const flag=join(output,'utils/feature-flags.js');writeFileSync(flag,readFileSync(flag,'utf8').replace('exports.ORDERS_ENTRY_ENABLED = false','exports.ORDERS_ENTRY_ENABLED = true'));
// 在App启动前封住真实云请求；后续再注入合成业务数据，不访问共享dev/prod。
const appFile=join(output,'app.js');
writeFileSync(appFile,"wx.cloud=wx.cloud||{};wx.cloud.init=()=>{};wx.cloud.callFunction=async()=>({result:{code:0,message:'success',data:{}}});\n"+readFileSync(appFile,'utf8'));
// 故障仅注入被测窗口工厂，不覆写整个wx能力（自动化协议也可能依赖它）。
const coverFile=join(output,'utils/cover-window.js');
writeFileSync(coverFile,readFileSync(coverFile,'utf8').replace('created = wx.createIntersectionObserver',"created = ((...args) => { if(getApp().globalData.__coverDisableObserver) throw new Error('synthetic unavailable'); return wx.createIntersectionObserver(...args); })"));
console.log('L3 编译完成，启动隔离项目');
const port=Number(process.env.COVER_WINDOW_AUTO_PORT||9432);
execFileSync('/Applications/wechatwebdevtools.app/Contents/MacOS/cli',['auto','--project',output,'--auto-port',String(port),'--trust-project'],{timeout:60000,stdio:'pipe'});
// RC工具缺失版本握手字段，包的checkVersion会报错；直接连接同一协议并核验真实SDK。
console.log('L3 自动化端口已启动',port);
let mp;let lastError;
for(let attempt=0;attempt<6;attempt++){
 let candidate;
 try{
  console.log('L3 连接/SDK探测',attempt);
  candidate=await new Launcher().connectTool({wsEndpoint:`ws://127.0.0.1:${port}`});
  const info=await candidate.systemInfo();
  if(info.SDKVersion!=='3.14.3')throw new Error('模拟器尚未完成编译');
  assert.equal(info.platform,'devtools');mp=candidate;console.log('L3 SDK通过');break;
 }catch(error){candidate?.disconnect();lastError=error;console.log('L3 SDK探测失败',error.message);await new Promise(r=>setTimeout(r,1000));}
}
if(!mp)throw lastError;
let pgServer=null;
mp.on('console',event=>{if(event.level==='error')console.log('微信页面错误',event.args)});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// RC模拟器个别导航已完成却不回callWxMethod的Promise；调用真实导航API，
// 以实际路由与后续数据/几何判据等待就绪，不依赖那条丢失的协议回执。
async function route(method,url) {
 // 通过专用callWxMethod发导航，避免App.callFunction沙箱异步副作用被后续RPC打断。
 // RC可能丢失完成回执；只对这项协议错误继续检查实际目标路由，不吞业务/参数错误。
 try { await mp.callWxMethod(method,method==='navigateBack'?{}:{url}); }
 catch(error) { if(!/timeout waiting for automator response|^timeout$/.test(error.message))throw error; }
 await wait(3000);
 for(let i=0;i<60;i++){
  const p=await mp.currentPage();
  if(p && (!url || p.path===url.slice(1)))return p;
  await wait(200);
 }
 throw new Error('实际页面路由未就绪：'+url);
}
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
   if(action==='product.shopInit' || action==='product.spuList') {
    const offset=action==='product.shopInit'?0:Number(payload.cursor||0),end=Math.min(200,offset+20);
    data={categories:[{category_id:'C-test',category_name:'合成分类',category_order:0,category_group:null}],groups:[],spuCategoryId:'C-test',spuList:Array.from({length:end-offset},(_,i)=>({product_id:'P'+(offset+i),name:'合成商品'+(offset+i),cover_image:'/images/icons/tab-home-active.png',priceFrom:'100',listPriceFrom:'100',skuList:[]})),hasMore:end<200,nextCursor:end<200?String(end):null};
   }
   if(action==='config.get') data={images:[]};
   if(action==='order.list') data={orders:[{sale_order_id:'O-test',status:'已支付',sale_order_type:'销售单',total_amount:200,received:200,sale_order_datetime:'2026-10-01',items:Array.from({length:200},(_,i)=>({sale_item_id:'I'+i,product_name:'合成明细'+i,cover_image:'/images/icons/tab-home-active.png',quantity:1,sale_amount:1,product_type:'家居产品',remaining_sessions:null}))}],hasMore:false};
   return {result:{code:0,message:'success',data}}
  };
 },Boolean(pgServer));

 console.log('L3 合成API安装完成');
 let page=await route('navigateTo','/pagesExperience/list/list');await wait(1000);
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
 async function snapshot(label,key,selector,scrollSelector='',requiredIndex=null) {
  // 在同一次原生测量回包中读取几何和cover标记，避免两次协议往返之间渲染已更新。
  let state;
  for(let attempt=0;attempt<30;attempt++) {
   state=await mp.evaluate((key,selector,scrollSelector)=>new Promise(resolve=>{
    const p=getCurrentPages().slice(-1)[0];
    const query=wx.createSelectorQuery().in(p);query.selectAll(selector).fields({rect:true,dataset:true});
    if(scrollSelector)query.select(scrollSelector).boundingClientRect();else query.selectViewport().fields({size:true});
    query.exec(([slots,view])=>{
     const rows=p.data[key];
     resolve({rows:rows.length,visible:rows.flatMap((r,i)=>r.coverVisible?[i]:[]),missing:slots.filter(r=>r.top<(view.bottom??view.height) && r.bottom>(view.top??0) && !rows[Number(r.dataset.idx)].coverVisible).map(r=>r.dataset.idx),height:view.height});
    });
   }),key,selector,scrollSelector);
   assert(state.height>0,label+'必须获得实际视口尺寸');
   if(state.missing.length===0 && (requiredIndex===null || state.visible.includes(requiredIndex)))break;
   await wait(100);
  }
  const images=await page.$$(selector+' image');
  console.log(label,{...state,images:images.length,scroll:await page.scrollTop()});
  assert(state.visible.length<=24);assert(images.length<=24);
  assert.deepEqual(state.missing,[],label+'可视封面不能被上限裁掉');
  if(requiredIndex!==null)assert(state.visible.includes(requiredIndex),label+'必须实际滚动到目标槽位');
  return state.visible;
 }
 await snapshot('experience-top','skuList','.experience-cover-slot');
 await mp.pageScrollTo(999999);const bottom=await snapshot('experience-bottom','skuList','.experience-cover-slot');assert(bottom.includes(199));assert(!bottom.includes(0));
 await mp.pageScrollTo(0);const top=await snapshot('experience-return','skuList','.experience-cover-slot');assert(top.includes(0));assert(!top.includes(199));
 page=await route('navigateTo','/pagesOrder/orders/orders');await wait(1000);assert.equal((await page.data()).coverRows.length,200);
 await snapshot('orders-top','coverRows','.order-cover-slot');await mp.pageScrollTo(999999);const ob=await snapshot('orders-bottom','coverRows','.order-cover-slot');assert(ob.includes(199));assert(!ob.includes(0));
 await mp.pageScrollTo(6000);await snapshot('orders-middle','coverRows','.order-cover-slot');
 await mp.pageScrollTo(0);const ot=await snapshot('orders-return','coverRows','.order-cover-slot');assert(ot.includes(0));assert(!ot.includes(199));
 await page.callMethod('onTabChange',{detail:{name:'已支付'}});
 await waitData(data=>data.activeTab==='已支付' && !data.isLoading && data.coverRows.length===200,'切Tab');
 await mp.pageScrollTo(999999);await snapshot('orders-tab-bottom','coverRows','.order-cover-slot');
 page=await route('navigateBack','/pagesExperience/list/list');
 assert.equal((await page.data()).skuList.length,200);
 assert.equal((await page.data()).hasMore,false);
 await snapshot('experience-navigate-back','skuList','.experience-cover-slot');
 console.log('L3 开始测量回退');
 await mp.evaluate(()=>{getApp().globalData.__coverDisableObserver=true;});
 page=await route('navigateTo','/pagesExperience/list/list');console.log('L3 回退页面已打开');await wait(1000);for(let i=0;i<9;i++){await page.callMethod('loadList',true);await wait(150)}
 await mp.pageScrollTo(999999);const fb=await snapshot('fallback-bottom','skuList','.experience-cover-slot');assert(fb.includes(199));assert(!fb.includes(0));
 await mp.pageScrollTo(0);const ft=await snapshot('fallback-return','skuList','.experience-cover-slot');assert(ft.includes(0));assert(!ft.includes(199));
 page=await route('navigateTo','/pagesOrder/orders/orders');await wait(1000);await mp.pageScrollTo(6000);await snapshot('orders-fallback-middle','coverRows','.order-cover-slot');await mp.pageScrollTo(999999);await snapshot('orders-fallback-bottom','coverRows','.order-cover-slot');
 // 共享窗口另外两个调用方：实际scroll-view、完整20条分页到200、故障回退与返回。
 for(const fallback of [false,true]) {
  await mp.evaluate(f=>{getApp().globalData.__coverDisableObserver=f},fallback);
  for(const [name,path] of [['home','/pages/home/home'],['shop','/pagesShop/shop/shop']]) {
   page=name==='home'?await route('switchTab',path):await route('navigateTo',path);
   // 首页在App启动时先使用隔离空回包；业务夹具安装后通过真实加载方法刷新。
   if(name==='home')await page.callMethod('loadShopInit');
   await waitData(d=>d.spuList.length>=20 && !d.isLoading,name+'首屏');
   for(let end=40;end<=200;end+=20){await page.callMethod('onScrollToLower');await waitData(d=>d.spuList.length===end && !d.isLoading,name+'分页')}
   await snapshot(name+'-top-'+fallback,'spuList','.spu-cover-slot','.product-scroll');
   const scroll=await page.$('.product-scroll');await scroll.scrollTo(0,999999);
   const bottom=await snapshot(name+'-bottom-'+fallback,'spuList','.spu-cover-slot','.product-scroll',199);assert(bottom.includes(199));assert(!bottom.includes(0));
   await scroll.scrollTo(0,0);
   const top=await snapshot(name+'-return-'+fallback,'spuList','.spu-cover-slot','.product-scroll',0);assert(top.includes(0));assert(!top.includes(199));
   await route('navigateTo','/pagesExperience/list/list');page=await route('navigateBack',path);
   assert.equal((await page.data()).spuList.length,200);
   await snapshot(name+'-navigate-back-'+fallback,'spuList','.spu-cover-slot','.product-scroll');
  }
 }
 console.log('PASS 200实际视图槽位/有界image节点/往返滚动/原生测量回退')
}finally{await mp.evaluate(()=>{if(wx.__originalCallFunction){wx.cloud.callFunction=wx.__originalCallFunction;delete wx.__originalCallFunction;}delete wx.__coverFailNext;delete getApp().globalData.__coverDisableObserver}).catch(()=>{});mp.disconnect();if(pgServer)await pgServer.close()}
