const test=require('node:test'),assert=require('node:assert/strict');
const {visibleStores}=require('../utils/operating-visibility');
test('PK数据范围不拼接其他角色的总部范围',async()=>{
 const calls=[];const pg={query:async(sql,args)=>{calls.push(args);return [{store_id:'s1'}]}};
 const auth={storeId:'s1',availableWorkspaces:['management'],roleBindings:[{scopeId:'m1',scopeType:'市场',actions:['data_center:dashboard']},{scopeId:'hq',scopeType:'总部',actions:['employee:list']}],scopedStores:[{store_id:'s1'},{store_id:'s2'}],managerStores:[]};
 assert.deepEqual(await visibleStores(auth,pg),['s1']);assert.ok(calls.some(args=>JSON.stringify(args).includes('m1')));assert.ok(!calls.some(args=>JSON.stringify(args).includes('hq')));
});
