const test=require('node:test'),assert=require('node:assert/strict');
const {targetScope}=require('../utils/target-scope');
test('总部只读授权不能代填市场；只能填写本人管理市场及本人门店',async()=>{
 const base={employeeId:'self',availableWorkspaces:['management'],scopeOrgNodeIds:['m1','m2'],managerStores:[{store_id:'s1'}]};
 const query=async()=>[{id:'m1'}];
 await assert.rejects(targetScope({...base,roleBindings:[{scopeType:'总部',scopeId:'hq',actions:['data_center:dashboard']}]},{scope:'market',scopeId:'m1'},query),/PERMISSION_DENIED/);
 const director={...base,roleBindings:[{scopeType:'市场',scopeId:'m1',actions:['data_center:dashboard']}]};
 assert.deepEqual(await targetScope(director,{scope:'market',scopeId:'m1'},query),{scope:'market',scopeId:'m1'});
 await assert.rejects(targetScope(director,{scope:'market',scopeId:'m2'},query),/PERMISSION_DENIED/);
 await assert.rejects(targetScope(base,{scope:'store',scopeId:'s2'},query),/PERMISSION_DENIED/);
 await assert.rejects(targetScope(base,{scope:'personal',scopeId:'other'},query),/PERMISSION_DENIED/);
 const storeManager={...base,employeeId:'manager',roleBindings:[{isStoreManager:true,scopeType:'门店',scopeId:'s1'}]};
 await assert.rejects(targetScope(storeManager,{scope:'personal'},query),/店长无需设置个人经营目标/);
 assert.deepEqual(await targetScope(storeManager,{scope:'store',scopeId:'s1'},query),{scope:'store',scopeId:'s1'});
 const employee={...base,managerStores:[],roleBindings:[]};
 assert.deepEqual(await targetScope(employee,{scope:'personal'},query),{scope:'personal',scopeId:'self'});
});
