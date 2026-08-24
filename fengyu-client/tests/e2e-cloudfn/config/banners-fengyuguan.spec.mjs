#!/usr/bin/env bun
/**
 * clientApi.config.banners / fengyuguan / shareGift / serviceHotline / invalidateConfig 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/config.js
 *
 * 实测要点：
 *   - 四个接口都是公开（无 auth 中间件） → 全部用 invokePublic
 *   - banners 返回 { count, v }（不再返回 URL 列表）：count/v 取自 system_configs.key='banner_count'
 *     （admin saveSettings 写入，updated_at 当版本号 v）；无 banner_count 时按 banner_images 数组长度兜底
 *   - fengyuguan 读 system_configs.key='fengyuguan_image'，返回 { url, v }：value 是裸字符串 URL，
 *     v 取自 updated_at（缓存版本号，client 防缓存用）；行不存在返回 url='' / v=0
 *   - shareGift 读 system_configs.key='share_gift_config'（JSON）：仅返回 5 个展示字段（enabled/percent/
 *     minFaceValue/maxFaceValue/validityDays），运营内部字段（couponTemplateId/inviterMustHavePaidOrder/
 *     messages）一律不暴露；任何异常（无配置/disabled/解析失败）返回 { enabled: false }
 *   - invalidateConfig 只清进程内 utils/config 缓存（getMemberThreshold 用），副作用不可直接观测；
 *     仅断言 code=0 + success=true
 *
 * 用例（12 个）：
 *   1. banners 有数据         — INSERT system_configs(banner_count='2') → { count:2, v:number }
 *   2. banners 无数据         — DELETE banner_count + banner_images → { count:0 }
 *   3. fengyuguan 有数据      — INSERT → 返回 url
 *   4. invalidateConfig       — code=0, success=true
 *   5. shareGift 无配置行      — { enabled:false }
 *   6. shareGift 显式 enabled=false — { enabled:false }
 *   7. shareGift enabled+完整字段 — 返回 5 字段精确等于配置
 *   8. shareGift enabled+其他字段缺/0 — 走默认值
 *   9. shareGift value 是坏 JSON   — { enabled:false }（catch 兜底）
 *  10. shareGift 敏感字段不暴露 — keys 严格 = 5 字段
 */
import '../setup.mjs'
import { NS, closePool, pgQuery } from '../setup.mjs'
import { invokePublic } from '../helpers/invoke-client.mjs'
import { cleanupTestData } from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const BANNER_KEY = 'banner_images'
const BANNER_COUNT_KEY = 'banner_count'
const FENGYUGUAN_KEY = 'fengyuguan_image'
const SHARE_GIFT_KEY = 'share_gift_config'
const SERVICE_HOTLINE_KEY = 'service_hotline'

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
let _shareGiftBackup = null
let _serviceHotlineBackup = null

// ─── shareGift 5 个公开字段（路由白名单） ───────────────────
const SHARE_GIFT_PUBLIC_KEYS = ['enabled', 'percent', 'minFaceValue', 'maxFaceValue', 'validityDays']

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
  if (typeof res.data.v !== 'number' || res.data.v <= 0) {
    throw new Error(`expect v>0 number (cache version), got ${JSON.stringify(res.data.v)}`)
  }
}

async function caseServiceHotlineWithData() {
  const phone = `${NS}-400-1234`
  await upsertConfig(SERVICE_HOTLINE_KEY, phone)
  const res = await invokePublic('config.serviceHotline', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.phone !== phone) {
    throw new Error(`phone mismatch: expected ${phone}, got ${res.data.phone}`)
  }
  if (typeof res.data.v !== 'number' || res.data.v <= 0) {
    throw new Error(`expect v>0 number (cache version), got ${JSON.stringify(res.data.v)}`)
  }
}

async function caseServiceHotlineNoRow() {
  await pgQuery('DELETE FROM system_configs WHERE key = $1', [SERVICE_HOTLINE_KEY])
  const res = await invokePublic('config.serviceHotline', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.phone !== '') {
    throw new Error(`expect phone='' when no row, got ${JSON.stringify(res.data.phone)}`)
  }
  if (res.data.v !== 0) {
    throw new Error(`expect v=0 when no row, got ${JSON.stringify(res.data.v)}`)
  }
}

async function caseInvalidateConfig() {
  const res = await invokePublic('config.invalidateConfig', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.success !== true) {
    throw new Error(`expect success=true, got ${res.data.success}`)
  }
}

// ─────────────── shareGift 用例 ───────────────

async function caseShareGiftNoRow() {
  await pgQuery('DELETE FROM system_configs WHERE key = $1', [SHARE_GIFT_KEY])
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.enabled !== false) {
    throw new Error(`expect enabled=false, got ${JSON.stringify(res.data)}`)
  }
}

async function caseShareGiftExplicitDisabled() {
  await upsertConfig(SHARE_GIFT_KEY, JSON.stringify({
    enabled: false,
    percent: 0.20,
    minFaceValue: 10,
    maxFaceValue: 800,
    validityDays: 60,
    couponTemplateId: 'tpl-secret',
  }))
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.enabled !== false) {
    throw new Error(`expect enabled=false (explicit), got ${JSON.stringify(res.data)}`)
  }
  // 关闭态时不应泄露任何其他字段
  if (Object.keys(res.data).length !== 1) {
    throw new Error(`disabled response should only have {enabled}, got keys=${Object.keys(res.data).join(',')}`)
  }
}

async function caseShareGiftEnabledFullFields() {
  const cfg = {
    enabled: true,
    percent: 0.20,
    minFaceValue: 5,
    maxFaceValue: 800,
    validityDays: 60,
    couponTemplateId: 'tpl-internal-secret',  // 敏感字段
    inviterMustHavePaidOrder: true,           // 敏感字段
    messages: { invite: 'hi' },               // 敏感字段
  }
  await upsertConfig(SHARE_GIFT_KEY, JSON.stringify(cfg))
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const d = res.data
  if (d.enabled !== true) throw new Error(`enabled mismatch: ${d.enabled}`)
  if (d.percent !== 0.20) throw new Error(`percent mismatch: ${d.percent}`)
  if (d.minFaceValue !== 5) throw new Error(`minFaceValue mismatch: ${d.minFaceValue}`)
  if (d.maxFaceValue !== 800) throw new Error(`maxFaceValue mismatch: ${d.maxFaceValue}`)
  if (d.validityDays !== 60) throw new Error(`validityDays mismatch: ${d.validityDays}`)
}

async function caseShareGiftEnabledDefaults() {
  // 只写 enabled=true，其他字段缺/0 → 走默认值
  await upsertConfig(SHARE_GIFT_KEY, JSON.stringify({ enabled: true }))
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const d = res.data
  if (d.enabled !== true) throw new Error(`enabled mismatch: ${d.enabled}`)
  if (d.percent !== 0.15) throw new Error(`expect default percent=0.15, got ${d.percent}`)
  if (d.minFaceValue !== 1) throw new Error(`expect default min=1, got ${d.minFaceValue}`)
  if (d.maxFaceValue !== 500) throw new Error(`expect default max=500, got ${d.maxFaceValue}`)
  if (d.validityDays !== 90) throw new Error(`expect default validityDays=90, got ${d.validityDays}`)
}

async function caseShareGiftBadJson() {
  // system_configs.value 是 text 列（看 db/schema/system-config.ts）。
  // 路由读出来后调 JSON.parse(string)，坏 JSON 会被 catch 兜底 → 返回 {enabled:false}。
  await upsertConfig(SHARE_GIFT_KEY, '{bad json not closed')
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0 (catch 兜底), got ${res.code}: ${res.message}`)
  if (res.data.enabled !== false) {
    throw new Error(`expect enabled=false on bad JSON, got ${JSON.stringify(res.data)}`)
  }
}

async function caseShareGiftSensitiveFieldsNotLeaked() {
  await upsertConfig(SHARE_GIFT_KEY, JSON.stringify({
    enabled: true,
    percent: 0.18,
    minFaceValue: 10,
    maxFaceValue: 600,
    validityDays: 30,
    couponTemplateId: 'tpl-secret-xyz',
    inviterMustHavePaidOrder: true,
    messages: { invite: 'hi', accept: 'thanks' },
    extraInternal: 'should not appear',
  }))
  const res = await invokePublic('config.shareGift', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const keys = Object.keys(res.data).sort()
  const expected = [...SHARE_GIFT_PUBLIC_KEYS].sort()
  if (keys.length !== expected.length || keys.join(',') !== expected.join(',')) {
    throw new Error(`expect keys = ${expected.join(',')}, got ${keys.join(',')}`)
  }
}

const CASES = [
  ['banners with data → returns array of URLs', caseBannersWithData],
  ['banners no row → returns []', caseBannersEmpty],
  ['fengyuguan with data → returns url', caseFengyuguanWithData],
  ['serviceHotline with data → returns phone', caseServiceHotlineWithData],
  ['serviceHotline no row → {phone:"",v:0}', caseServiceHotlineNoRow],
  ['invalidateConfig → code=0 success=true', caseInvalidateConfig],
  ['shareGift no row → {enabled:false}', caseShareGiftNoRow],
  ['shareGift explicit enabled=false → {enabled:false}', caseShareGiftExplicitDisabled],
  ['shareGift enabled full → 5 fields match', caseShareGiftEnabledFullFields],
  ['shareGift enabled defaults → 0.15/1/500/90', caseShareGiftEnabledDefaults],
  ['shareGift bad JSON → catch 兜底 {enabled:false}', caseShareGiftBadJson],
  ['shareGift 敏感字段不泄露 → keys = 白名单', caseShareGiftSensitiveFieldsNotLeaked],
]

let pass = 0, fail = 0
console.log(`[config/banners-fengyuguan.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  // 备份生产配置（system_configs 是全局表，不在 NS 范围内）
  _bannerBackup = await snapshotConfigRow(BANNER_KEY)
  _bannerCountBackup = await snapshotConfigRow(BANNER_COUNT_KEY)
  _fengyuguanBackup = await snapshotConfigRow(FENGYUGUAN_KEY)
  _shareGiftBackup = await snapshotConfigRow(SHARE_GIFT_KEY)
  _serviceHotlineBackup = await snapshotConfigRow(SERVICE_HOTLINE_KEY)

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
    await restoreConfigRow(SHARE_GIFT_KEY, _shareGiftBackup)
    await restoreConfigRow(SERVICE_HOTLINE_KEY, _serviceHotlineBackup)
  } catch (e) {
    console.warn(`[config] restore failed: ${e.message}`)
  }
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[config/banners-fengyuguan.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
