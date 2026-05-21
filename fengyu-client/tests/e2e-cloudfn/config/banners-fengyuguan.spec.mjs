#!/usr/bin/env bun
/**
 * clientApi.config.banners / fengyuguan / invalidateConfig 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/config.js
 *
 * 实测要点：
 *   - 三个接口都是公开（无 auth 中间件） → 全部用 invokePublic
 *   - banners 返回 { count, v }（不再返回 URL 列表）：count/v 取自 system_configs.key='banner_count'
 *     （admin saveSettings 写入，updated_at 当版本号 v）；无 banner_count 时按 banner_images 数组长度兜底
 *   - fengyuguan 读 system_configs.key='fengyuguan_image'，value 是裸字符串 URL；行不存在返回 url=''
 *   - invalidateConfig 只清进程内 utils/config 缓存（getMemberThreshold 用），副作用不可直接观测；
 *     仅断言 code=0 + success=true
 *   - banners 路由 **本身没缓存**（utils/config 缓存是 getMemberThreshold 的，与 banners 无关），
 *     所以多次调用每次都查 DB；本 spec 不再测"内存缓存"那一项
 *
 * 用例：
 *   1. banners 有数据         — INSERT system_configs(banner_count='2') → 返回 { count:2, v:number }
 *   2. banners 无数据         — DELETE banner_count + banner_images → 返回 { count:0 }
 *   3. fengyuguan 有数据      — INSERT → 返回 url
 *   4. invalidateConfig       — code=0, success=true
 */
import '../setup.mjs'
import { NS, closePool, pgQuery } from '../setup.mjs'
import { invokePublic } from '../helpers/invoke-client.mjs'
import { cleanupTestData } from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const BANNER_KEY = 'banner_images'
const BANNER_COUNT_KEY = 'banner_count'
const FENGYUGUAN_KEY = 'fengyuguan_image'

/**
 * 备份 + 恢复系统配置（避免污染生产配置）
 */
async function snapshotConfigRow(key) {
  const rows = await pgQuery(
    'SELECT value FROM system_configs WHERE key = $1',
    [key]
  )
  return rows[0]?.value ?? null
}

async function restoreConfigRow(key, original) {
  if (original === null) {
    await pgQuery('DELETE FROM system_configs WHERE key = $1', [key])
  } else {
    await pgQuery(
      `INSERT INTO system_configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, original]
    )
  }
}

async function upsertConfig(key, value) {
  await pgQuery(
    `INSERT INTO system_configs (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  )
}

// ─── 测试前后保护原 system_configs 行 ────────────────────────
let _bannerBackup = null
let _bannerCountBackup = null
let _fengyuguanBackup = null

async function caseBannersWithData() {
  await upsertConfig(BANNER_COUNT_KEY, '2')

  const res = await invokePublic('config.banners', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.count !== 2) {
    throw new Error(`expect count=2, got ${JSON.stringify(res.data)}`)
  }
  if (typeof res.data.v !== 'number' || res.data.v <= 0) {
    throw new Error(`expect v>0 number (cache version), got ${JSON.stringify(res.data.v)}`)
  }
}

async function caseBannersEmpty() {
  await pgQuery('DELETE FROM system_configs WHERE key = $1', [BANNER_COUNT_KEY])
  await pgQuery('DELETE FROM system_configs WHERE key = $1', [BANNER_KEY])
  const res = await invokePublic('config.banners', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.count !== 0) {
    throw new Error(`expect count=0, got ${JSON.stringify(res.data)}`)
  }
}

async function caseFengyuguanWithData() {
  const url = `https://example.com/${NS}/fengyuguan.jpg`
  await upsertConfig(FENGYUGUAN_KEY, url)

  const res = await invokePublic('config.fengyuguan', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.url !== url) {
    throw new Error(`url mismatch: expected ${url}, got ${res.data.url}`)
  }
}

async function caseInvalidateConfig() {
  const res = await invokePublic('config.invalidateConfig', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.success !== true) {
    throw new Error(`expect success=true, got ${res.data.success}`)
  }
}

const CASES = [
  ['banners with data → returns array of URLs', caseBannersWithData],
  ['banners no row → returns []', caseBannersEmpty],
  ['fengyuguan with data → returns url', caseFengyuguanWithData],
  ['invalidateConfig → code=0 success=true', caseInvalidateConfig],
]

let pass = 0, fail = 0
console.log(`[config/banners-fengyuguan.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  // 备份生产配置（system_configs 是全局表，不在 NS 范围内）
  _bannerBackup = await snapshotConfigRow(BANNER_KEY)
  _bannerCountBackup = await snapshotConfigRow(BANNER_COUNT_KEY)
  _fengyuguanBackup = await snapshotConfigRow(FENGYUGUAN_KEY)

  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  // 恢复生产配置
  try {
    await restoreConfigRow(BANNER_KEY, _bannerBackup)
    await restoreConfigRow(BANNER_COUNT_KEY, _bannerCountBackup)
    await restoreConfigRow(FENGYUGUAN_KEY, _fengyuguanBackup)
  } catch (e) {
    console.warn(`[config] restore failed: ${e.message}`)
  }
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[config/banners-fengyuguan.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
