/**
 * scope-isolation 套件公共 setup
 *
 * - 复用 e2e-cloudfn/setup.mjs 的环境变量（ALLOW_TEST_OPENID / PG_CONNECTION_STRING）
 * - 跑 seed-openids.sql 给 FY-TEST-* 员工注入确定性 openid
 * - 导出共用的 OPENID / scope-id 常量
 *
 * 用法（每个 scope-s*.mjs 顶部）：
 *   import './setup.mjs'
 */
import '../e2e-cloudfn/setup.mjs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../e2e-cloudfn/setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_SQL = path.join(__dirname, 'seed-openids.sql')

/** scope 测试账号 — 与 admin 端 _helpers/scope-helpers.ts TEST_PHONES 同源 */
export const SCOPE_OPENID = {
  MGR: 'staff-scope-FY-TEST-MGR',   // store-nc01 manager
  MGR2: 'staff-scope-FY-TEST-MGR2', // store-nc02 manager
  MKT: 'staff-scope-FY-TEST-MKT',   // 南昌市场 manager
  ADM: 'staff-scope-FY-TEST-ADM',   // 总部 admin
}

export const SCOPE_TOPOLOGY = {
  HQ_ORG_ID: '16d1184b46db099a',
  MARKET_NC: '6707cc8b88579108',
  MARKET_NC2: 'ec9ca0f5c96be174',
  STORE_NC01: 'store-nc01',
  STORE_NC02: 'store-nc02',
  STORE_OTHER_MARKET: 'b79a82e33d6cf4f3',
  ORG_NC01: 'org-store-nc01',
  ORG_NC02: 'org-store-nc02',
}

export const SCOPE_CLIENTS = {
  NC01: 'FY-FIX-CLIENT-01',
  NC02: 'FY-TEST-CLIENT-NC02',
  OTHER_MARKET: 'FY-TEST-CLIENT-OM',
}

let _seeded = false
export function ensureOpenidsSeeded() {
  if (_seeded) return
  try {
    execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu -f ${SEED_SQL}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    )
    _seeded = true
  } catch (e) {
    const err = e
    console.error('[scope-isolation/setup] seed openids 失败：', err.message || err)
    throw err
  }
}

export { REPO_ROOT }
