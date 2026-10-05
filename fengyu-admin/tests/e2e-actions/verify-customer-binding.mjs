/**
 * #301: 从 fengyu-admin 运行：
 * bun --preload ./tests/e2e-actions/_admin-preload.mjs ./tests/e2e-actions/verify-customer-binding.mjs
 * 完整 mergeClientProfile + 真实 Drizzle/PG；Next 会话、权限、审计和缓存使用既有替身。
 * 唯一临时容器；不读取业务库配置。仅建立合并需要的列/引用约束，不验证完整迁移或鉴权。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { clientWechatUsers } from '../../../db/schema/user.ts'

const container = `pg-301-binding-${process.pid}-${randomBytes(3).toString('hex')}`
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const psql = (query) => execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'verify', '-v', 'ON_ERROR_STOP=1', '-At'], { encoding: 'utf8', input: query }).trim()
const quote = (id) => `"${id.replaceAll('"', '""')}"`
const references = {
  sale_orders: 'client_user_id', user_coupons: 'user_id', point_transactions: 'user_id',
  point_batches: 'user_id', prepaid_cards: 'user_id', appointments: 'client_user_id',
  service_orders: 'client_user_id', pickup_records: 'client_user_id', messages: 'recipient_id',
}
let started = false
try {
  docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=verify', '-e', 'POSTGRES_DB=verify', '-p', '127.0.0.1::5432', 'postgres:16')
  started = true
  let ready = false
  for (let i = 0; i < 30; i++) {
    try { docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'verify'); ready = true; break } catch { await sleep(1000) }
  }
  assert.ok(ready, '临时 PostgreSQL 未就绪')
  const port = docker('port', container, '5432/tcp').split(':').at(-1)
  process.env.E2E_DATABASE_URL = `postgres://postgres:verify@127.0.0.1:${port}/verify`
  const columns = getTableConfig(clientWechatUsers).columns.map((c) => {
    const type = ({ string: 'text', number: 'numeric', bigint: 'numeric', boolean: 'boolean', date: 'timestamptz', json: 'jsonb', array: 'text[]' })[c.dataType]
    assert.ok(type, `未支持测试列类型：${c.name}/${c.dataType}`)
    return `${quote(c.name)} ${type}${c.name === 'user_id' ? ' PRIMARY KEY' : ''}`
  })
  psql(`CREATE TABLE client_wechat_users (${columns.join(',')})`)
  for (const [table, column] of Object.entries(references)) {
    const extra = table === 'point_batches' ? ', remaining_amount numeric, expire_at timestamptz' : table === 'messages' ? ', recipient_type text' : ''
    psql(`CREATE TABLE ${quote(table)} (${quote(column)} text REFERENCES client_wechat_users(user_id), updated_at timestamptz${extra})`)
  }
  const { db } = await import('../../src/db/index.ts')
  const { mergeClientProfile } = await import('../../src/actions/customers.ts')
  const realTransaction = db.transaction.bind(db)
  const seed = (bound) => {
    psql('TRUNCATE client_wechat_users CASCADE')
    psql(`INSERT INTO client_wechat_users(user_id,openid,phone,name,bound_employee_id,bound_employee_name,customer_type,workfine_override_fields)
      VALUES ('source','wx-source','19999000001','活跃顾客',${bound ? "'current'" : 'NULL'},${bound ? "'当前员工'" : 'NULL'},'流量客','{}'),
      ('orphan',NULL,'19999000001','孤儿顾客','old','孤儿员工','流量客','{}')`)
    for (const [table, column] of Object.entries(references)) {
      psql(`INSERT INTO ${quote(table)}(${quote(column)}) VALUES ('orphan')`)
    }
    psql("UPDATE point_batches SET remaining_amount=12, expire_at=NOW()+INTERVAL '1 day'; UPDATE messages SET recipient_type='客户'")
  }
  const assertMerged = (employee, name) => {
    assert.equal(psql("SELECT count(*) FROM client_wechat_users WHERE user_id='orphan'"), '0')
    assert.equal(psql("SELECT bound_employee_id || '|' || bound_employee_name FROM client_wechat_users WHERE user_id='source'"), `${employee}|${name}`)
    assert.equal(psql("SELECT points_balance FROM client_wechat_users WHERE user_id='source'"), '12')
    for (const [table, column] of Object.entries(references)) {
      assert.equal(psql(`SELECT count(*) FROM ${quote(table)} WHERE ${quote(column)}='source'`), '1', table)
    }
  }

  // 两次事务外读取已经结束，在真正进入事务前用另一连接完成合法分配。
  seed(false)
  let injected = false
  db.transaction = async (fn, options) => {
    assert.equal(injected, false)
    injected = true
    psql("UPDATE client_wechat_users SET bound_employee_id='new',bound_employee_name='新分配员工' WHERE user_id='source'")
    return realTransaction(fn, options).catch((error) => { console.error(error); throw error })
  }
  const raced = await mergeClientProfile('source', 'orphan')
  db.transaction = realTransaction
  assert.equal(injected, true)
  assert.equal(raced.success, true, raced.message)
  assert.ok(!raced.fieldsMigrated.includes('boundEmployeeId'))
  assert.ok(!raced.fieldsMigrated.includes('boundEmployeeName'))
  assert.equal(raced.ordersReassigned, 1)
  assertMerged('new', '新分配员工')

  seed(false)
  const empty = await mergeClientProfile('source', 'orphan')
  assert.equal(empty.success, true, empty.message)
  assert.ok(empty.fieldsMigrated.includes('boundEmployeeId'))
  assert.ok(empty.fieldsMigrated.includes('boundEmployeeName'))
  assertMerged('old', '孤儿员工')

  seed(true)
  const bound = await mergeClientProfile('source', 'orphan')
  assert.equal(bound.success, true, bound.message)
  assert.ok(!bound.fieldsMigrated.includes('boundEmployeeId'))
  assertMerged('current', '当前员工')
  console.log('PASS: 完整mergeClientProfile三例：读空后新分配保留、仍空迁移、已有绑定不覆盖；9张引用表迁移、积分重算、孤儿删除、fieldsMigrated/ordersReassigned一致')
} finally {
  if (globalThis.pgClient) await globalThis.pgClient.end()
  if (started) docker('stop', container)
}
