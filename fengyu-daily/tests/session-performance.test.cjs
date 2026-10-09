const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function boot() {
  const storage = {}, pages = [], calls = [];
  let now = Date.parse('2026-10-09T02:00:00Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getStorageSync: key => storage[key] || '', setStorageSync: (key, value) => { storage[key] = value; },
    cloud: { callFunction: async options => { calls.push(options); return { result: { code: 0, data: {} } }; } } };
  function load(file, require) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/', file + '.ts'), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(code, { exports, require, wx, Date: Clock, getCurrentPages: () => pages });
    return exports;
  }
  const session = load('session', () => { throw Error('Unexpected import'); });
  const cloud = load('cloud', () => session);
  return { session, cloud, wx, pages, calls, storage, advance: ms => { now += ms; } };
}
test('同会话登录合并在途请求，30秒后重验，应用恢复能立即重验', async () => {
  const { session, advance } = boot();let count = 0, resolve;
  const fetch = () => { count++;return new Promise(r => { resolve = r; }); };
  const a = session.sessionUser(fetch), b = session.sessionUser(fetch);
  assert.equal(count, 1);resolve({ employeeId: 'A' });await Promise.all([a,b]);
  await session.sessionUser(fetch);assert.equal(count, 1);
  advance(30_001);const c = session.sessionUser(fetch);assert.equal(count, 2);resolve({ employeeId:'A' });await c;
  session.expireLogin();const d = session.sessionUser(fetch);assert.equal(count, 3);resolve({employeeId:'A'});await d;
});
test('切测试码和跨日均不复用旧身份；旧请求不能写入新会话缓存', async () => {
  const { session, storage, advance } = boot();let resolve;
  const old = session.sessionUser(() => new Promise(r => { resolve = r; }));
  storage.dailyTestBindingCode = 'new-code';
  const newer = await session.sessionUser(async () => ({employeeId:'B'}));assert.equal(newer.employeeId,'B');
  resolve({employeeId:'A'});await assert.rejects(old, e => e.errorType === 'SESSION_CHANGED');
  assert.equal((await session.sessionUser(async () => {throw Error('should use B');})).employeeId,'B');
  advance(86400000);assert.equal((await session.sessionUser(async () => ({employeeId:'C'}))).employeeId,'C');
});
test('鉴权拒绝清除已挂载页面数据，旧业务响应不能覆盖新身份', async () => {
  const { session, cloud, wx, pages } = boot();
  const page = { _loadId: 1, data:{overview:{secret:'old'},reports:[1],ready:true,user:{employeeId:'A'}},setData(p){Object.assign(this.data,p);} };pages.push(page);
  let resolve;wx.cloud.callFunction = () => new Promise(r => { resolve=r; });const old=cloud.callApi('management.read');
  session.invalidateSession();assert.equal(page.data.overview,null);assert.equal(page.data.ready,false);assert.equal(page._loadId,2);
  resolve({result:{code:0,data:{secret:'old'}}});await assert.rejects(old,e=>e.errorType==='SESSION_CHANGED');
  page.data.overview={secret:'current'};
  wx.cloud.callFunction=async()=>({result:{code:-403,errorType:'PERMISSION_DENIED',message:'denied'}});
  await assert.rejects(cloud.callApi('management.read'), e=>e.errorType==='PERMISSION_DENIED');assert.equal(page.data.overview,null);
});
