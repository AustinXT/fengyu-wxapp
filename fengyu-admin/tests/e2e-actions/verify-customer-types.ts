/** #257 C 私有PostgreSQL行为回归；不读取业务库连接，临时容器唯一命名且finally清理。 */
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
const container = `pg-257-cron-${process.pid}-${randomBytes(3).toString('hex')}`
const docker = (...args: string[]) => execFileSync('docker', args, {encoding:'utf8'}).trim()
const psql = (q: string) => execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','verify','-v','ON_ERROR_STOP=1','-At'],{encoding:'utf8',input:q}).trim()
docker('run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=verify','-e','POSTGRES_DB=verify','-p','127.0.0.1::5432','postgres:16')
try {
  let ready = false
  for(let i=0;i<30;i++) { try { docker('exec',container,'pg_isready','-U','postgres','-d','verify'); ready=true;break } catch { await sleep(1000) } }
  assert.ok(ready)
  const port = docker('port',container,'5432/tcp').split(':').at(-1)
  process.env.E2E_DATABASE_URL = `postgres://postgres:verify@127.0.0.1:${port}/verify`
  psql(readFileSync(resolve('../db/scripts/verify/customer-type-fixtures.sql'),'utf8'))
  psql(readFileSync(resolve('../db/migrations/0045_try_cast_helpers.sql'),'utf8').replaceAll('--> statement-breakpoint',''))
  psql(`ALTER TABLE client_wechat_users ADD name text;
    CREATE TYPE customer_status AS ENUM ('保有会员-稳定','保有会员-有效','沉睡','冰冻','休眠');
    CREATE TYPE spending_tier AS ENUM ('10W+','6-10W','3-6W','1-3W','1990-1W','<1990');
    ALTER TABLE client_wechat_users ADD customer_status customer_status, ADD spending_tier spending_tier;
    CREATE TABLE service_orders(client_user_id text,status text,service_date date);
    CREATE TABLE system_configs(key text PRIMARY KEY,value text);
    INSERT INTO system_configs VALUES('new_member_threshold','1980');
    UPDATE client_wechat_users SET customer_type='会员客' WHERE user_id IN('U_none','U_small','U_trial');
    UPDATE client_wechat_users SET name='谢廷(测试)' WHERE user_id='U_pure';
    UPDATE client_wechat_users SET member_level='初钻',became_member_at='2025-06-01' WHERE user_id='U_legacy';
    UPDATE sale_orders SET is_membership_upgrade=true WHERE sale_order_id='O_legacy';`)
  const {db} = await import('../../src/db')
  const {refreshCustomerTypes} = await import('../../src/cron/steps/refresh-customer-types')
  const {recomputeCustomerTagsInTx} = await import('../../src/lib/recompute-customer-tags')
  const testBefore = psql("SELECT row_to_json(u) FROM client_wechat_users u WHERE user_id='U_pure'")
  await refreshCustomerTypes(db)
  for(const [id,type] of [['U_none','流量客'],['U_small','小美客'],['U_trial','体验客'],['U_refund','会员客'],['U_legacy','会员客']]) assert.equal(psql(`SELECT customer_type FROM client_wechat_users WHERE user_id='${id}'`),type)
  assert.equal(psql("SELECT row_to_json(u) FROM client_wechat_users u WHERE user_id='U_pure'"),testBefore)
  const once = psql('SELECT json_agg(u ORDER BY user_id)::text FROM client_wechat_users u')
  assert.equal((await refreshCustomerTypes(db)).updated,0)
  assert.equal(psql('SELECT json_agg(u ORDER BY user_id)::text FROM client_wechat_users u'),once)
  psql("UPDATE sale_orders SET received=400 WHERE sale_order_id='O_legacy'")
  const beforeHistory = psql("SELECT json_build_array(member_level,became_member_at,(SELECT is_membership_upgrade FROM sale_orders WHERE sale_order_id='O_legacy')) FROM client_wechat_users WHERE user_id='U_legacy'")
  const changed = await db.transaction(tx=>recomputeCustomerTagsInTx(tx,'U_legacy'))
  assert.deepEqual(changed.customerTypeChanged,{from:'会员客',to:'小美客'})
  assert.equal(psql("SELECT json_build_array(member_level,became_member_at,(SELECT is_membership_upgrade FROM sale_orders WHERE sale_order_id='O_legacy')) FROM client_wechat_users WHERE user_id='U_legacy'"),beforeHistory)
  assert.equal((await db.transaction(tx=>recomputeCustomerTagsInTx(tx,'U_legacy'))).customerTypeChanged,null)
  psql("UPDATE sale_orders SET received=3000 WHERE sale_order_id='O_legacy'")
  assert.deepEqual((await db.transaction(tx=>recomputeCustomerTagsInTx(tx,'U_legacy'))).customerTypeChanged,{from:'小美客',to:'会员客'})
  psql("UPDATE system_configs SET value='0' WHERE key='new_member_threshold'")
  await assert.rejects(()=>refreshCustomerTypes(db),/会员门槛/)
  console.log('PASS: 真实cron+helper双向、退款毛实收、无单、测试整行保护、同日幂等、历史字段保留、再达标升级、阈值拒绝')
} finally {
  const g = globalThis as typeof globalThis & {pgClient?: {end:()=>Promise<void>}}
  if(g.pgClient) await g.pgClient.end()
  docker('stop',container)
}
