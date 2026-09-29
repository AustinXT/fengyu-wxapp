/** #291 CI 真 PG 测试。必须显式提供隔离的、服务端默认 UTC 的 TEST_PG_URL。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'



const root = fileURLToPath(new URL('../../', import.meta.url))
const url = process.env.TEST_PG_URL
assert.ok(url, '必须提供 TEST_PG_URL（测试专用 UTC 库）')
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), '只允许本地隔离库')
const require = createRequire(resolve(root, 'fengyu-staff/cloudfunctions/staffApi/package.json'))
const { Client } = require('pg')
test('服务端默认时区确为 UTC（不使用应用连接配置）', async () => {
  const client = new Client({ connectionString: url })
  try {
    await client.connect()
    assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC')
    assert.equal((await client.query("SELECT ('2026-09-01 00:00:00+08'::timestamptz)::date::text AS day")).rows[0].day, '2026-08-31')
  } finally { await client.end() }
})

function run(target, mode, wrong = false) {
  return spawnSync('bun', ['run', resolve(root, 'scripts/tests/session-timezone-probe.ts'), target, mode], {
    cwd: root,
    env: { ...process.env, E2E_DATABASE_URL: url + (wrong ? '?TimeZone=UTC' : ''), DATABASE_URL: url,
      PG_CONNECTION_STRING: url + (mode === 'url-options' ? '?options=-c%20TimeZone%3DUTC' : ''), NODE_ENV: 'production' },
    encoding: 'utf8', timeout: 20000,
  })
}
for (const target of ['admin', 'analyst', 'staff', 'client', 'pay']) {
  test(`${target} 在 UTC 服务端建连为上海${target === 'analyst' ? '' : '；admin/staff 原查询按上海零点归日'}`, () => {
    const child = run(target, 'normal')
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.match(child.stdout, /PASS/)
  })
  test(`${target} 错误时区退出进程（不能只拒绝一条查询）`, () => {
    const child = run(target, target === 'admin' || target === 'analyst' ? 'startup' : 'wrong-options', true)
    assert.equal(child.status, 1, child.stderr + child.stdout)
    assert.match(child.stderr, /PG_TIMEZONE_MISMATCH/)
    assert.doesNotMatch(child.stdout, /PASS/)
  })
}
for (const target of ['staff', 'client', 'pay']) {
  test(`${target} 连接串 options 覆盖客户端配置时退出进程`, () => {
    const child = run(target, 'url-options')
    assert.equal(child.status, 1, child.stderr + child.stdout)
    assert.match(child.stderr, /PG_TIMEZONE_MISMATCH/)
    assert.doesNotMatch(child.stdout, /PASS/)
  })
}

// 生产 worker 是 Bun 预构建的 Node bundle；export 的 define 会裁掉 Web auth/React 分支。
const bundleDir = mkdtempSync(resolve(root, 'fengyu-admin/.timezone-test-'))
after(() => rmSync(bundleDir, { recursive: true, force: true }))
for (const worker of ['cron', 'export-worker']) {
  const bundle = resolve(bundleDir, `${worker}.mjs`)
  const buildEnv = { ...process.env }
  delete buildEnv.NODE_ENV
  const built = spawnSync('bun', ['build', `src/${worker}/index.ts`, '--target=node', '--format=esm',
    `--outfile=${bundle}`, '--external=pg-native', '--external=server-only', '--external=@opentelemetry/api',
    ...(worker === 'export-worker' ? ['--define', 'process.env.FENGYU_EXPORT_WORKER="1"'] : []),
  ], { cwd: resolve(root, 'fengyu-admin'), encoding: 'utf8', env: buildEnv, timeout: 60000 })
  assert.equal(built.status, 0, built.stderr + built.stdout)
  test(`${worker} 在任务执行前因错误时区启动失败（生产 Node bundle）`, () => {
    const child = spawnSync(process.execPath, ['--conditions=react-server', bundle, '--once'], {
      cwd: resolve(root, 'fengyu-admin'), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, E2E_DATABASE_URL: url + '?TimeZone=UTC', DATABASE_URL: url, NODE_ENV: 'production' },
    })
    assert.equal(child.status, 1, child.stderr + child.stdout)
    assert.match(child.stderr, /PG_TIMEZONE_MISMATCH/)
    assert.doesNotMatch(child.stdout, /one-shot done|claimed job/)
  })
  test(`${worker} 构建 --check 不建连`, () => {
    const child = spawnSync(process.execPath, ['--conditions=react-server', bundle, '--check'], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, E2E_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid' },
    })
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.match(child.stdout, /check passed|bundle verified/)
  })
}
