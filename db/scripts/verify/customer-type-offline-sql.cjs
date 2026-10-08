#!/usr/bin/env node
// #257 离线SQL真实行为回归。只起唯一临时Docker PG，不读取业务连接。
const fs=require('fs'),{execFileSync}=require('child_process'),assert=require('assert/strict'),path=require('path');
const container='pg-257-offline-verify-'+process.pid+'-'+require('crypto').randomBytes(3).toString('hex');
const root=path.resolve(__dirname,'../../..');
process.chdir(root);
const sql=q=>execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','fy257','-v','ON_ERROR_STOP=1','-At'],{input:q,encoding:'utf8'}).trim();
const bind=q=>q.replace(/\$(\d+)/g,(_,n)=>{if(n!=='1')throw Error('unknown bind');return '1980'});
async function verify() {
execFileSync('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=verify','-e','POSTGRES_DB=fy257','postgres:16'],{stdio:'pipe'});
try {
let ready=false;
for(let i=0;i<30;i++) {
 try { execFileSync('docker',['exec',container,'pg_isready','-U','postgres','-d','fy257'],{stdio:'pipe'});ready=true;break; } catch { await new Promise(r=>setTimeout(r,1000)); }
}
if(!ready)throw Error('private verification PG not ready');
sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');sql(fs.readFileSync('db/scripts/verify/customer-type-fixtures.sql','utf8'));sql(fs.readFileSync('db/migrations/0045_try_cast_helpers.sql','utf8').replaceAll('--> statement-breakpoint',''));
sql("ALTER TABLE sale_orders ADD updated_at timestamptz DEFAULT now(); ALTER TABLE client_wechat_users ADD name text; ALTER TABLE client_wechat_users ADD phone text; UPDATE client_wechat_users SET customer_type='会员客' WHERE user_id IN('U_none','U_small','U_trial'); UPDATE client_wechat_users SET name='谢廷(测试)' WHERE user_id='U_pure';");
const all=require('../recalc-all-customer-types');
const before=sql("SELECT row_to_json(u) FROM client_wechat_users u WHERE user_id='U_pure';");
// 归因脚本单独执行时不能给档位尚未对齐的非会员打会员历史标记。
for(const file of ['recalc-became-member-at','backfill-membership-upgrade-doc-type']) {
 const lib=require('../'+file);sql(`BEGIN;${bind(lib.BUILD_TARGET_SQL)};${lib.UPDATE_SQL};COMMIT;`);
}
assert.equal(sql("SELECT became_member_at IS NULL FROM client_wechat_users WHERE user_id='U_refund'"),'t');
assert.equal(sql("SELECT is_membership_upgrade FROM sale_orders WHERE sale_order_id='O_refund'"),'f');

// 只升不降（#545）：夹具把三个计算上属低档的顾客预置成「会员客」。
// 必须同时断言 computed_type（仍是低档）与 new_type（保留会员客），才能证明是
// 单调门挡住了降档，而不是「压根没算出低档」的假绿。
const shadow=q=>sql(`BEGIN;${bind(all.BUILD_TARGET_TABLE_SQL)};${q};ROLLBACK;`)
 .split('\n').filter(l=>l&&!/^(BEGIN|ROLLBACK|SELECT \d+)$/.test(l)).join('\n');
assert.equal(shadow("SELECT string_agg(computed_type::text||'->'||new_type::text, ',' ORDER BY user_id) FROM _recalc_target WHERE user_id IN('U_none','U_small','U_trial')"),'流量客->会员客,小美客->会员客,体验客->会员客');

const execute=()=>sql(`BEGIN;${bind(all.BUILD_TARGET_TABLE_SQL)};${all.UPDATE_TYPE_SQL};${all.UPDATE_LEVEL_SQL};${all.UPDATE_BECAME_SQL};COMMIT;`);
execute();
// 单调保护：预置会员客不因计算值为低档而降档
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_none'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_small'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_trial'"),'会员客');
// 升级方向不受影响
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_refund'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_legacy'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_mix'"),'小美客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_overrefund'"),'小美客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_exitonly'"),'流量客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_xorder'"),'小美客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_badjson'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_truncjson'"),'会员客');
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_badnum'"),'会员客');
assert.equal(before,sql("SELECT row_to_json(u) FROM client_wechat_users u WHERE user_id='U_pure';"));
const once=sql('SELECT json_agg(u ORDER BY user_id)::text FROM client_wechat_users u');execute();assert.equal(once,sql('SELECT json_agg(u ORDER BY user_id)::text FROM client_wechat_users u'));
for(const file of ['recalc-became-member-at','backfill-membership-upgrade-doc-type']){const lib=require('../'+file);sql(`BEGIN;${bind(lib.BUILD_TARGET_SQL)};${lib.UPDATE_SQL};ROLLBACK;`)}
// 消费金额被修正到低于阈值仍不降档（只升不降）；计算值确实掉到小美客。
// 已有退款加回毛实收保持达标（#187）。
sql("UPDATE sale_items SET received=400,sale_amount=400 WHERE sale_order_id='O_legacy'; UPDATE sale_orders SET received=400 WHERE sale_order_id='O_legacy';");execute();
assert.equal(sql("SELECT customer_type FROM client_wechat_users WHERE user_id='U_legacy'"),'会员客');
assert.equal(shadow("SELECT computed_type FROM _recalc_target WHERE user_id='U_legacy'"),'小美客');
console.log('PASS: 只升不降（降档被挡且计算值可见）、升级方向、无单/零额、退款毛实收、历史回退、测试账号不动、幂等、三脚本真实PG可执行');

// 新审计SQL在真正READ ONLY事务中执行，不创建TEMP或写业务数据。
const audit=require('../audit-customer-type-transitions');
sql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;${bind(audit.AUDIT_SQL)};ROLLBACK;`);
console.log('PASS: 两个归因脚本单独运行不标记非会员；审计READ ONLY SQL可执行');
} finally { execFileSync('docker',['stop',container],{stdio:'pipe'}); }
}
verify().catch(e=>{console.error(e.message);process.exitCode=1});
