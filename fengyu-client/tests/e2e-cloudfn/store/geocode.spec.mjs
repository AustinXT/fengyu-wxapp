#!/usr/bin/env bun
/**
 * clientApi.store.geocode
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/store.js → geocode
 *
 * 路由依赖：腾讯地图 LBS API（HTTPS GET https://apis.map.qq.com/ws/geocoder/v1/）
 *           需要环境变量 TMAP_KEY / TMAP_SECRET。
 *
 * 用例策略：
 *   - 如果环境未配 TMAP_KEY，整个 spec SKIP（exit 0，不算 fail）
 *   - 否则跑：
 *       1. 缺参数: geocode({}) → INVALID_PARAMS（不需要外网）
 *       2. happy: 广州坐标 → 返回 province 含 '广东' 或 city 含 '广州'
 *
 * 注意：单测不 mock fetch，依赖真实 API。如果环境无网络但有 TMAP_KEY，
 *       happy case 会失败（exit 1），这符合"基础设施告警"语义。
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

async function caseMissingParam() {
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.geocode', {})
  if (res.code === 0) throw new Error(`expect non-zero, got success`)
  if (!String(res.message || '').includes('缺少坐标')) {
    throw new Error(`expect "缺少坐标", got: ${res.message}`)
  }
}

async function caseHappyGuangzhou() {
  // 广州天河 CBD 附近
  const res = await invokeAs(TEST_CLIENT_OPENID, 'store.geocode', {
    latitude: 23.13,
    longitude: 113.26,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const province = String(res.data.province || '')
  const city = String(res.data.city || '')
  if (!province.includes('广东') && !city.includes('广州')) {
    throw new Error(`expect province 广东 or city 广州, got province='${province}', city='${city}'`)
  }
}

const HAS_TMAP = !!(process.env.TMAP_KEY && process.env.TMAP_SECRET)

const CASES = HAS_TMAP
  ? [
      ['missing latitude/longitude → INVALID_PARAMS', caseMissingParam],
      ['happy: Guangzhou coords → province/city', caseHappyGuangzhou],
    ]
  : []

let pass = 0, fail = 0
console.log(`[geocode.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

if (!HAS_TMAP) {
  console.log(`  SKIP: TMAP_KEY / TMAP_SECRET not set in env`)
  await closePool()
  process.exit(0)
}

try {
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
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[geocode.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
