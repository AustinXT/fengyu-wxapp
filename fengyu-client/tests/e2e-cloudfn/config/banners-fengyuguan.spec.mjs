#!/usr/bin/env bun
/**
 * clientApi.config.banners / fengyuguan / shareGift / serviceHotline / invalidateConfig 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/config.js
 *
 * 实测要点：
 *   - 四个接口都是公开（无 auth 中间件） → 全部用 invokePublic
 *   - banners 返回 { count, v, images }：images 是已施加 imageMogr2 缩略规则 + ?v= 版本号的
 *     完整 URL 列表（issue #231 把 URL 构造从前端收回服务端）；count/v 取自
 *     system_configs.key='banner_count'
 *     （admin saveSettings 写入，updated_at 当版本号 v）；无 banner_count 时按 banner_images 数组长度兜底
 *   - fengyuguan 读 system_configs.key='fengyuguan_image'，返回 { url, v }：value 是裸字符串 URL，
 *     v 取自 updated_at（缓存版本号，client 防缓存用）；行不存在返回 url='' / v=0
 *   - shareGift 读 system_configs.key='share_gift_config'（JSON）：仅返回 5 个展示字段（enabled/percent/
 *     minFaceValue/maxFaceValue/validityDays），运营内部字段（couponTemplateId/inviterMustHavePaidOrder/
 *     messages）一律不暴露；任何异常（无配置/disabled/解析失败）返回 { enabled: false }
 *   - invalidateConfig 只清进程内 utils/config 缓存（getMemberThreshold 用），副作用不可直接观测；
 *     仅断言 code=0 + success=true
 *
 * 用例（14 个）：
 *   1. banners 有数据         — INSERT banner_count='2' → { count:2, v:number, images:[2 条已缩略 URL] }
 *   2. banners 无数据         — DELETE banner_count + banner_images → { count:0, images:[] }
 *   2b. banners 忽略 banner_images 的 host — 下发值恒走服务端钉死的 COS_BASE
 *   2c. banners count 失控     — banner_count='999999' → images 被 clamp 到 20 条
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

// 合法 COS host —— 必须真在 utils/image.js 的白名单里，否则整组退化成「全拒」的恒真断言
const COS_HOST = 'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la'

async function caseBannersWithData() {
  await upsertConfig(BANNER_COUNT_KEY, '2')
  // banner_images 存的是 admin 上传原件的随机名 URL，服务端只借它的 origin（issue #231）
  await upsertConfig(BANNER_KEY, JSON.stringify([
    `${COS_HOST}/fengyu-client/banner/1788156883695-gz1cdm.jpg`,
  ]))

  const res = await invokePublic('config.banners', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.count !== 2) {
    throw new Error(`expect count=2, got ${JSON.stringify(res.data)}`)
  }
  if (typeof res.data.v !== 'number' || res.data.v <= 0) {
    throw new Error(`expect v>0 number (cache version), got ${JSON.stringify(res.data.v)}`)
  }

  // ─── issue #231：URL 构造收回服务端，下发值必须已缩略且带版本号 ───
  const { images } = res.data
  if (!Array.isArray(images) || images.length !== 2) {
    throw new Error(`expect images to be 2 URLs, got ${JSON.stringify(images)}`)
  }
  images.forEach((url, i) => {
    const expected = `${COS_HOST}/fengyu-client/banner/banner${i + 1}.jpg`
      + `?imageMogr2/thumbnail/1080x1080&v=${res.data.v}`
    if (url !== expected) {
      throw new Error(`banner[${i}] mismatch:\n  expected ${expected}\n  got      ${url}`)
    }
  })
  // 随机名原件绝不能出现在下发值里（前端要的是 reuploadToFixedPath 之后的固定名）
  if (images.join().includes('1788156883695-gz1cdm')) {
    throw new Error(`下发了 admin 上传原件的随机名 URL: ${JSON.stringify(images)}`)
  }
}

/**
 * issue #231：host 来源已钉死为云函数自己的 COS_BASE，**不从 banner_images 取**。
 *
 * banner_images 是 admin 可写且无校验的字段。拿它当 host 来源等于让持 system:config
 * 的账号把全量顾客的首页图源指到任意桶，而 host 白名单只做后缀匹配、拦不住同后缀的桶。
 * 这条正面证明：banner_images 指到哪里都不影响下发值。
 */
async function caseBannersIgnoresImagesHost() {
  await upsertConfig(BANNER_COUNT_KEY, '1')
  await upsertConfig(BANNER_KEY, JSON.stringify([
    'https://636c-cloud1-3gpht4b01ff88838-1406056527.tcb.qcloud.la/x/y.jpg',
  ]))

  const res = await invokePublic('config.banners', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const expected = `${COS_HOST}/fengyu-client/banner/banner1.jpg`
    + `?imageMogr2/thumbnail/1080x1080&v=${res.data.v}`
  if (JSON.stringify(res.data.images) !== JSON.stringify([expected])) {
    throw new Error(
      `banner_images 的 host 不该影响下发值\n  expected [${expected}]\n  got      ${JSON.stringify(res.data.images)}`
    )
  }
}

/**
 * count 是裸 text 且 admin 侧无长度校验，而它现在是服务端循环的上界。
 * 不 clamp 的话 `999999` 会让这个公开未认证接口生成 99 万条 URL（实测响应 150MB / OOM）。
 */
async function caseBannersCountClamped() {
  await upsertConfig(BANNER_COUNT_KEY, '999999')
  await upsertConfig(BANNER_KEY, JSON.stringify([`${COS_HOST}/fengyu-client/banner/x.jpg`]))

  const res = await invokePublic('config.banners', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.images) || res.data.images.length !== 20) {
    throw new Error(`expect images clamped to 20, got ${res.data.images?.length}`)
  }
  const bytes = JSON.stringify(res.data).length
  if (bytes > 10 * 1024) {
    throw new Error(`响应体应被 clamp 在 10KB 内，实际 ${(bytes / 1024).toFixed(1)}KB`)
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
  if (!Array.isArray(res.data.images) || res.data.images.length !== 0) {
    throw new Error(`expect images=[], got ${JSON.stringify(res.data.images)}`)
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
  ['banners 忽略 banner_images 的 host（来源钉死）', caseBannersIgnoresImagesHost],
  ['banners count 失控被 clamp 到 20', caseBannersCountClamped],
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
