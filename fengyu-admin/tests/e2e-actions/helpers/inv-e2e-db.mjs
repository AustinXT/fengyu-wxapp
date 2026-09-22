/**
 * 进销存链路冒烟专用一次性数据库供给。
 *
 * 为什么不用共享 5433 开发库：inventory_movements 是 DB 触发器强制的只追加表
 * （migration 0009 trg_inventory_movements_append_only），任何产生库存流水的链路
 * 测试都会在共享库留下**永久不可删除**的夹具残留（movements 钉住 lots/docs/skus/
 * org_nodes 整张 FK 图）。因此链路冒烟一律跑在本地 docker 一次性库：
 *
 *   1. 容器 fengyu-inv-e2e-pg（postgres:16, 127.0.0.1:54397）；
 *   2. 模板库 fengyu_inv_e2e_tpl 用 db/scripts/bootstrap-from-zero.sh 全量迁移一次；
 *   3. 每次运行 DROP + CREATE fengyu_inv_e2e TEMPLATE tpl —— 秒级拿到纯净 schema。
 *
 * 覆盖：INV_E2E_DATABASE_URL 可显式指定目标库（生产 IP 一律拒绝）。
 * 清理容器：docker rm -f fengyu-inv-e2e-pg
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

const CONTAINER = 'fengyu-inv-e2e-pg'
const PORT = 54397
const TPL_DB = 'fengyu_inv_e2e_tpl'
const RUN_DB = 'fengyu_inv_e2e'
const TPL_CONN = `postgresql://postgres:test@127.0.0.1:${PORT}/${TPL_DB}`

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options })
}

function psql(database, query) {
  return run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', query])
}

function migrationFileCount() {
  return readdirSync(path.join(REPO_ROOT, 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .length
}

/**
 * @param {{ runDb?: string }} [opts] `runDb` 指定运行库名，默认 `fengyu_inv_e2e`。
 *   每次调用都 `DROP … WITH (FORCE)` 再从模板重建 —— **两个冒烟同时跑同一个运行库会互相踢掉**，
 *   所以别的冒烟要用就自己传一个库名（org-ancestry 传 `fengyu_org_ancestry_e2e`），
 *   模板库与容器则共用（模板只读，重建是秒级的）。
 */
export function ensureInventoryE2eDb(opts = {}) {
  const runDb = opts.runDb ?? RUN_DB
  const runConn = `postgresql://postgres:test@127.0.0.1:${PORT}/${runDb}`
  const explicit = process.env.INV_E2E_DATABASE_URL
  if (explicit) {
    if (explicit.includes('118.178.196.26')) {
      throw new Error('[inv-e2e-db] 拒绝连接生产库 118.178.196.26')
    }
    return explicit
  }

  // 1) 容器存在且在运行
  const inspect = run('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER])
  if (inspect.status !== 0) {
    const created = run('docker', [
      'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=test', '-e', `POSTGRES_DB=${TPL_DB}`,
      '-p', `${PORT}:5432`, 'postgres:16',
    ])
    if (created.status !== 0) {
      throw new Error(`[inv-e2e-db] 启动容器失败：${created.stderr}`)
    }
  } else if (inspect.stdout.trim() !== 'true') {
    const started = run('docker', ['start', CONTAINER])
    if (started.status !== 0) {
      throw new Error(`[inv-e2e-db] 启动已存在容器失败：${started.stderr}`)
    }
  }

  // 2) 等待就绪
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (run('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres']).status === 0) {
      ready = true
      break
    }
    run('sleep', ['1'])
  }
  if (!ready) throw new Error('[inv-e2e-db] 容器 60s 内未就绪')

  // 3) 模板库迁移到位（bootstrap 幂等，缺 migration 会补齐）
  psql('postgres', `CREATE DATABASE ${TPL_DB}`) // 已存在时静默失败即可
  const migrated = psql(TPL_DB, 'SELECT COUNT(*) FROM drizzle.__drizzle_migrations')
  const migratedCount = migrated.status === 0 ? Number(migrated.stdout.trim()) : -1
  if (migratedCount < migrationFileCount()) {
    console.log(`[inv-e2e-db] 模板库迁移 ${migratedCount}/${migrationFileCount()}，执行 bootstrap-from-zero…`)
    const bootstrap = run('bash', [path.join(REPO_ROOT, 'db', 'scripts', 'bootstrap-from-zero.sh')], {
      env: { ...process.env, DATABASE_URL: TPL_CONN },
      stdio: 'inherit',
      encoding: undefined,
    })
    if (bootstrap.status !== 0) throw new Error('[inv-e2e-db] bootstrap-from-zero.sh 失败')
  }

  // 4) 从模板重建纯净运行库（触发器/枚举/权限种子随模板整套复制）
  const dropped = psql('postgres', `DROP DATABASE IF EXISTS ${runDb} WITH (FORCE)`)
  if (dropped.status !== 0) throw new Error(`[inv-e2e-db] DROP 运行库失败：${dropped.stderr}`)
  const created = psql('postgres', `CREATE DATABASE ${runDb} TEMPLATE ${TPL_DB}`)
  if (created.status !== 0) throw new Error(`[inv-e2e-db] 按模板重建运行库失败：${created.stderr}`)

  return runConn
}
