#!/usr/bin/env node
// seed-first-admin.js
//
// 幂等地为新生产库插入"首个 admin 用户"四张表：
//   1. org_nodes      (id='ORG-HQ', name='总部', type='总部', parent_id=NULL)
//   2. staff_wechat_users (employee_id='EMP-ADMIN-001', name, phone, org_node_id, position_name)
//   3. admin_passwords (employee_id, password_hash=bcrypt(pwd, 12), must_change=true)
//   4. permission_roles (employee_id, role='admin', scope_id='ORG-HQ')
//
// 设计：
//   - 整个流程一个事务：失败完全回滚
//   - 幂等：先 SELECT phone 是否已存在 → 是则 SKIP（return 0），否则插入
//   - bcryptjs 与 fengyu-admin 同版本同 cost (12)
//
// Usage:
//   node db/scripts/seed-first-admin.js --phone 13800000001 --name 张三 --password 'TempPass#2026'
//   node db/scripts/seed-first-admin.js --phone 13800000001 --name 张三 --password 'TempPass#2026' --dry-run
//
//   DATABASE_URL 默认读 db/.env；务必显式传目标库，避免连到非预期环境：
//   dev : DATABASE_URL=postgresql://...@101.34.242.103:5433/fengyu_wxapp node db/scripts/seed-first-admin.js ...
//   prod: DATABASE_URL=postgresql://...@118.178.196.26:5433/fengyu_wxapp node db/scripts/seed-first-admin.js ...

const path = require('node:path')
const fs = require('node:fs')
const { Client } = require('pg')
const { hash } = require('bcryptjs')

// --- CLI 参数 ---
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--phone') opts.phone = args[++i]
    else if (a === '--name') opts.name = args[++i]
    else if (a === '--password') opts.password = args[++i]
    else if (a === '--employee-id') opts.employeeId = args[++i]
    else if (a === '--org-id') opts.orgId = args[++i]
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: node seed-first-admin.js --phone <13...> --name <name> --password <pwd> [--dry-run]
Optional:
  --employee-id   default: EMP-ADMIN-001
  --org-id        default: ORG-HQ
  --dry-run       print plan, don't insert
Env:
  DATABASE_URL    pg connection (defaults to db/.env)`)
      process.exit(0)
    }
  }
  return opts
}

function requireArg(opts, key, label) {
  if (!opts[key]) {
    console.error(`ERROR: missing required --${label}`)
    console.error(`  Usage: node seed-first-admin.js --phone <13...> --name <name> --password <pwd>`)
    process.exit(1)
  }
}

function validatePhone(phone) {
  if (!/^1[3-9][0-9]{9}$/.test(phone)) {
    console.error(`ERROR: phone "${phone}" invalid. Must match ^1[3-9][0-9]{9}$ (11 digits).`)
    process.exit(1)
  }
}

function loadDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const envPath = path.join(__dirname, '..', '.env')
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.+)$/m)
    if (m) return m[1].trim()
  }
  console.error('ERROR: DATABASE_URL not set and db/.env not found.')
  process.exit(1)
}

async function main() {
  const opts = parseArgs()
  requireArg(opts, 'phone', 'phone')
  requireArg(opts, 'name', 'name')
  requireArg(opts, 'password', 'password')
  validatePhone(opts.phone)

  const employeeId = opts.employeeId || 'EMP-ADMIN-001'
  const orgId = opts.orgId || 'ORG-HQ'
  const databaseUrl = loadDbUrl()
  const dbHost = databaseUrl.match(/@([^:/]+:[0-9]+)\//)?.[1] || '?'

  console.log(`Target DB: ${dbHost}`)
  console.log(`Plan:`)
  console.log(`  org_nodes        id=${orgId} name=总部 type=总部`)
  console.log(`  staff_wechat_users employee_id=${employeeId} name=${opts.name} phone=${opts.phone}`)
  console.log(`  admin_passwords  employee_id=${employeeId} bcrypt(***, 12) must_change=true`)
  console.log(`  permission_roles employee_id=${employeeId} role=admin scope=${orgId}`)

  if (opts.dryRun) {
    console.log(`\n[dry-run] no changes applied.`)
    return
  }

  const passwordHash = await hash(opts.password, 12)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await client.query('BEGIN')

    // 幂等：phone 已存在 → SKIP
    const existing = await client.query(
      `SELECT employee_id, name FROM staff_wechat_users WHERE phone = $1 LIMIT 1`,
      [opts.phone],
    )
    if (existing.rowCount > 0) {
      console.log(`\nSKIP: phone ${opts.phone} already exists (employee_id=${existing.rows[0].employee_id}, name=${existing.rows[0].name})`)
      await client.query('ROLLBACK')
      return
    }

    // 1. org_nodes (HQ)
    await client.query(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES ($1, $2, $3::org_node_type, NULL, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, '总部', '总部'],
    )

    // 2. staff_wechat_users
    await client.query(
      `INSERT INTO staff_wechat_users (employee_id, name, phone, org_node_id, position_name, is_resigned)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [employeeId, opts.name, opts.phone, orgId, '超级管理员'],
    )

    // 3. admin_passwords
    await client.query(
      `INSERT INTO admin_passwords (employee_id, password_hash, must_change)
       VALUES ($1, $2, true)`,
      [employeeId, passwordHash],
    )

    // 4. permission_roles (admin @ HQ)
    await client.query(
      `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
       VALUES ($1, 'admin', $2, 'seed-first-admin')`,
      [employeeId, orgId],
    )

    await client.query('COMMIT')
    console.log(`\n✓ Seed complete. Login with phone=${opts.phone} (must change password on first login).`)

    // 验证
    const counts = await client.query(`
      SELECT 'org_nodes' AS t, COUNT(*)::int AS c FROM org_nodes WHERE id = $1
      UNION ALL SELECT 'staff_wechat_users', COUNT(*)::int FROM staff_wechat_users WHERE employee_id = $2
      UNION ALL SELECT 'admin_passwords', COUNT(*)::int FROM admin_passwords WHERE employee_id = $2
      UNION ALL SELECT 'permission_roles', COUNT(*)::int FROM permission_roles WHERE employee_id = $2 AND role = 'admin'`,
      [orgId, employeeId])
    console.log(`Verification:`)
    for (const r of counts.rows) console.log(`  ${r.t.padEnd(20)} = ${r.c}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`\n✗ Seed FAILED, transaction rolled back.`)
    console.error(err)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
